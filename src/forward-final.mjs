import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, redact } from './config.mjs';
import { DiscordREST } from './rest.mjs';
import { splitText } from './delivery.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}

async function finalMessage(payload) {
  let last;
  let turn = '';
  if (typeof payload.transcript_path === 'string') {
    const input = createReadStream(payload.transcript_path, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.isSidechain) continue;
        if (record?.type === 'user' && record.message?.role === 'user'
          && !record.message?.content?.some?.(block => block.type === 'tool_result')) {
          last = undefined;
          turn = record.uuid || '';
        }
        if (record?.type === 'assistant' && record.message?.role === 'assistant') {
          last = { id: record.message.id || record.uuid, text: textBlocks(record.message.content) };
        }
      }
    } catch (error) {
      if (typeof payload.last_assistant_message !== 'string') throw error;
    } finally { lines.close(); input.destroy(); }
  }
  const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : last?.text || '';
  const scope = payload.session_id || payload.transcript_path || '';
  const keys = [`turn:${scope}:${payload.prompt_id || turn}:${text}`];
  if (last?.id && last.text === text) keys.push(`message:${last.id}`);
  const uncertainKey = `payload:${scope}:${text}`;
  if (typeof payload.last_assistant_message === 'string' && last?.text !== text) keys.unshift(uncertainKey);
  return { text, keys, uncertainKey };
}

export function runInbox(args, text, home) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FM_HOME: home };
    for (const key of ['DISCORD_BOT_TOKEN', 'FM_STATE_OVERRIDE', 'FM_DATA_OVERRIDE', 'FM_CONFIG_OVERRIDE']) delete env[key];
    const child = spawn(join(home, 'bin/fm-inbox.sh'), args, { cwd: home, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 2500);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); }
    });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('Firstmate inbox command failed or timed out.'));
      else resolve(output);
    });
    child.stdin.end(text || '');
  });
}

async function logFailure(data, error, token) {
  try {
    await mkdir(data, { recursive: true, mode: 0o700 });
    await appendFile(join(data, 'forward-final.log'), `${new Date().toISOString()} ${redact(error, token)}\n`, { mode: 0o600 });
  } catch {}
}

export async function forwardFinal(input, { data = join(root, 'data'), runner = runInbox,
  config = () => loadConfig(process.env, root), transport = settings => new DiscordREST(settings.token) } = {}) {
  let token = process.env.DISCORD_BOT_TOKEN;
  try {
    const payload = JSON.parse(input);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Stop payload.');
    if (payload.hook_event_name && payload.hook_event_name !== 'Stop') return;
    const message = await finalMessage(payload);
    if (!message.text.trim() || /^Captain, shipshape\.[^\r\n]*$/.test(message.text.trim())) return;
    const settings = await config();
    const state = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
    const receipts = JSON.parse(await runner(['receipts'], undefined, settings.home));
    if (receipts.schema !== 'fm-inbox-receipts.v1' || !Array.isArray(receipts.handled)) throw new Error('Invalid inbox receipts.');
    const note = receipts.handled.filter(note => {
      const route = state.notes && Object.hasOwn(state.notes, note.id) ? state.notes[note.id] : null;
      return route && /^\d{1,20}$/.test(route.channel) && /^\d{1,20}$/.test(route.message)
        && note.request_id === `discord:${route.message}` && note.acknowledged === true && note.reply === null;
    }).sort((a, b) => {
      const order = String(b.at || '').localeCompare(String(a.at || ''));
      if (order) return order;
      const first = BigInt(state.notes[a.id].message);
      const second = BigInt(state.notes[b.id].message);
      return first === second ? 0 : first > second ? -1 : 1;
    })[0];
    token = settings.token;
    const text = redact(message.text, token).replace(/^FILE:/gm, '\u200bFILE:');
    const records = join(data, 'forward-final');
    await mkdir(records, { recursive: true, mode: 0o700 });
    const uncertainName = createHash('sha256').update(message.uncertainKey).digest('hex');
    try { await readFile(join(records, uncertainName)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const key of message.keys) {
      const name = createHash('sha256').update(key).digest('hex');
      let handle;
      try { handle = await open(join(records, name), 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return; throw error; }
      try { await handle.writeFile(JSON.stringify({ note: note?.id || null, at: new Date().toISOString() })); await handle.sync(); }
      finally { await handle.close(); }
    }
    if (note) await runner(['reply', note.id, '-'], text, settings.home);
    else {
      const rest = transport(settings);
      for (const part of splitText(text).filter(value => value.trim())) await rest.message(settings.channel, part);
    }
  } catch (error) {
    await logFailure(data, error, token);
  }
}

export async function main() {
  const deadline = setTimeout(() => {
    void logFailure(join(root, 'data'), new Error('Stop hook timed out.'), process.env.DISCORD_BOT_TOKEN)
      .finally(() => process.exit(0));
  }, 7000);
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4 * 1024 * 1024) throw new Error('Stop payload exceeds size limit.');
    }
    await forwardFinal(input);
  } catch (error) {
    await logFailure(join(root, 'data'), error, process.env.DISCORD_BOT_TOKEN);
  } finally { clearTimeout(deadline); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
