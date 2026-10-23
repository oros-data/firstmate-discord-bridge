import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { loadConfig, redact, requireNode } from '../src/config.mjs';
import { DiscordREST } from '../src/rest.mjs';
import { State } from '../src/state.mjs';
import { fixture } from './helpers.mjs';

const run = promisify(execFile);

test('configuration names every missing value and rejects old Node versions', async t => {
  const f = await fixture(t);
  await assert.rejects(loadConfig({}, f.root), error => {
    for (const key of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID', 'DISCORD_OWNER_ID', 'FM_HOME']) assert.ok(error.message.includes(key));
    return true;
  });
  assert.throws(() => requireNode('20.19.0'), /22 or newer/);
  requireNode('22.0.0');
});

test('environment overrides .env and blank optional values use defaults', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.env'), 'DISCORD_BOT_TOKEN="test-secret"\nDISCORD_GUILD_ID=10\nDISCORD_CHANNEL_ID=20\nDISCORD_OWNER_ID=30\nFM_INBOX_BIN=\nBRIDGE_DATA_DIR=\n');
  const config = await loadConfig({ DISCORD_OWNER_ID: '31', FM_HOME: f.config.home }, f.root);
  assert.equal(config.owner, '31');
  assert.equal(config.inbox, join(f.config.home, 'bin/fm-inbox.sh'));
  assert.equal(config.data, join(f.root, 'data'));
  assert.equal(config.token, 'test-secret');
  await assert.rejects(loadConfig({ DISCORD_OWNER_ID: 'not-an-id', FM_HOME: f.config.home }, f.root), /DISCORD_OWNER_ID/);
});

test('token redaction covers all occurrences and thrown fetch failures', async () => {
  const token = 'private-token';
  assert.equal(redact(new Error(`bad ${token} ${token}`), token), 'bad [REDACTED] [REDACTED]');
  const rest = new DiscordREST(token, { fetcher: async () => { throw new Error(`url ${token}`); }, sleep: async () => {} });
  await assert.rejects(rest.request('GET', '/users/@me'), error => !error.message.includes(token) && error.message.includes('[REDACTED]'));
  const denied = new DiscordREST(token, { fetcher: async () => new Response(token, { status: 401 }), sleep: async () => {} });
  await assert.rejects(denied.request('GET', '/users/@me'), error => !error.message.includes(token) && error.message.includes('401'));
});

test('REST handles global 429, reset headers, and retryable GET errors with injected fetch', async () => {
  const responses = [
    Response.json({ retry_after: 0.001, global: true }, { status: 429 }),
    new Response(null, { status: 503 }),
    Response.json({ id: '40' }, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.001' } }),
    Response.json({ id: '40' }),
  ];
  const calls = [];
  const sleeps = [];
  const rest = new DiscordREST('token', { fetcher: async (url, options) => { calls.push({ url, options }); return responses.shift(); }, sleep: async ms => sleeps.push(ms) });
  assert.equal((await rest.request('GET', '/users/@me')).id, '40');
  await rest.request('GET', '/users/@me');
  assert.equal(calls.length, 4);
  assert.ok(sleeps.some(ms => ms >= 100));
  assert.equal(calls[0].options.headers.Authorization, 'Bot token');
  assert.ok(calls[0].url.startsWith('https://discord.com/api/v10/'));
});

test('state transactions serialize concurrent changes and survive reload', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, () => new State(f.config.data).run(data => { data.count = (data.count || 0) + 1; })));
  await new State(f.config.data).run(data => assert.equal(data.count, 8));
  const saved = JSON.parse(await readFile(join(f.config.data, 'state.json'), 'utf8'));
  assert.equal(saved.count, 8);
  await writeFile(join(f.config.data, 'state.json'), '{invalid');
  await assert.rejects(f.state.run(() => {}), SyntaxError);
});

test('concurrent state transactions recover a dead process lock safely', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(child, 'exit');
  const lock = join(f.config.data, 'state.lock');
  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(child.pid));
  await Promise.all(Array.from({ length: 4 }, () => new State(f.config.data).run(data => { data.recovered = (data.recovered || 0) + 1; })));
  await f.state.run(data => assert.equal(data.recovered, 4));
});

test('dry run has no network or inbox calls and does not write bridge data', async t => {
  const f = await fixture(t);
  const env = { ...process.env, DISCORD_BOT_TOKEN: f.config.token, DISCORD_GUILD_ID: '10', DISCORD_CHANNEL_ID: '20', DISCORD_OWNER_ID: '30', FM_HOME: f.config.home, BRIDGE_DATA_DIR: join(f.root, 'dry-data') };
  const { stdout, stderr } = await run(process.execPath, [join(process.cwd(), 'src/bridge.mjs'), '--dry-run'], { cwd: f.root, env });
  assert.match(stdout, /no connections and no writes/);
  assert.ok(!stdout.includes(f.config.token));
  assert.equal(stderr, '');
  await assert.rejects(readFile(join(f.root, 'dry-data', 'state.json')), { code: 'ENOENT' });
  assert.deepEqual(await f.calls(), []);
});
