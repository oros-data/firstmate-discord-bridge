import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export function requireNode(version = process.versions.node) {
  if (Number(version.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
}

export function redact(value, token) {
  const text = String(value?.message ?? value);
  return token ? text.split(token).join('[REDACTED]') : text;
}

export async function loadConfig(env = process.env, cwd = process.cwd()) {
  requireNode();
  let text = '';
  try { text = await readFile(join(cwd, '.env'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error('Invalid .env line. Use NAME=value.');
    const value = match[2].trim();
    values[match[1]] = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
  }
  Object.assign(values, env);
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID', 'DISCORD_OWNER_ID'];
  const missing = required.filter(key => !values[key]?.trim());
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  for (const key of required.slice(1)) {
    if (!/^\d{1,20}$/.test(values[key])) throw new Error(`Invalid snowflake: ${key}`);
  }
  const home = resolve(cwd, values.FM_HOME || '/Users/pedrocipriano/Repos/firstmate');
  const data = resolve(cwd, values.BRIDGE_DATA_DIR || './data');
  return {
    token: values.DISCORD_BOT_TOKEN, guild: values.DISCORD_GUILD_ID,
    channel: values.DISCORD_CHANNEL_ID, owner: values.DISCORD_OWNER_ID,
    home, inbox: resolve(cwd, values.FM_INBOX_BIN || join(home, 'bin/fm-inbox.sh')),
    data, media: join(data, 'media'), roots: [join(home, 'data'), join(data, 'media')],
  };
}
