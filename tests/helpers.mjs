import { mkdtemp, mkdir, copyFile, chmod, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.mjs';
import { DiscordREST } from '../src/rest.mjs';
import { Firstmate } from '../src/firstmate.mjs';
import { Relay } from '../src/relay.mjs';

export function fakeDiscord(config) {
  const calls = [];
  const history = new Map();
  const channels = new Map([[config.channel, { id: config.channel, guild_id: config.guild, type: 0 }]]);
  let nextId = 1000;
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/api/v10', '');
    const query = new URL(url).searchParams;
    const method = options.method || 'GET';
    const form = options.body instanceof FormData;
    const body = options.body ? JSON.parse(form ? options.body.get('payload_json') : options.body) : undefined;
    const files = form ? [...options.body.entries()].filter(([key]) => key.startsWith('files[')).map(([, value]) => value) : [];
    calls.push({ path, query, method, body, files, headers: options.headers });
    if (path === '/users/@me') return Response.json({ id: '40', username: 'test-bot', bot: true });
    if (path === `/guilds/${config.guild}/threads/active`) return Response.json({ threads: [...channels.values()].filter(channel => channel.type === 11) });
    const channelMatch = path.match(/^\/channels\/(\d+)$/);
    if (channelMatch && method === 'GET') return Response.json(channels.get(channelMatch[1]) || { id: channelMatch[1], guild_id: '999', type: 0 });
    const messageMatch = path.match(/^\/channels\/(\d+)\/messages$/);
    if (messageMatch) {
      const channel = messageMatch[1];
      if (!history.has(channel)) history.set(channel, []);
      const messages = history.get(channel);
      if (method === 'GET') {
        return Response.json([...messages].reverse().filter(message => !query.get('before') || BigInt(message.id) < BigInt(query.get('before'))).slice(0, Number(query.get('limit') || 50)));
      }
      const replay = body.enforce_nonce && messages.find(message => message.nonce === body.nonce);
      if (replay) return Response.json(replay);
      const message = { id: String(nextId++), channel_id: channel, ...body };
      messages.push(message);
      return Response.json(message);
    }
    const threadMatch = path.match(/^\/channels\/(\d+)\/threads$/);
    if (threadMatch && method === 'POST') {
      const thread = { id: String(nextId++), name: body.name, parent_id: threadMatch[1], guild_id: config.guild, owner_id: '40', type: body.type };
      channels.set(thread.id, thread);
      return Response.json(thread);
    }
    if (path.includes('/reactions/') && method === 'PUT') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fake REST call: ${method} ${path}`);
  };
  return { calls, history, channels, fetcher };
}

export async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fm-discord-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    token: 'test-secret-token', guild: '10', channel: '20', owner: '30',
    home: join(root, 'firstmate'), data: join(root, 'bridge'),
  };
  config.inbox = join(config.home, 'fm-inbox.mjs');
  config.media = join(config.data, 'media');
  config.roots = [join(config.home, 'data'), config.media];
  for (const path of [config.home, join(config.home, 'state'), ...config.roots]) await mkdir(path, { recursive: true });
  await copyFile(new URL('./fixtures/fm-inbox', import.meta.url), config.inbox);
  await chmod(config.inbox, 0o700);
  const discord = fakeDiscord(config);
  const rest = new DiscordREST(config.token, { fetcher: discord.fetcher, sleep: async () => {} });
  const state = new State(config.data);
  const errors = [];
  const inbox = new Firstmate(config);
  const relay = new Relay(config, state, rest, inbox, {
    fetcher: async () => new Response(Buffer.from('fake image')), onError: error => errors.push(error),
  });
  relay.botId = '40';
  const message = (overrides = {}) => ({ id: '100', guild_id: config.guild, channel_id: config.channel,
    author: { id: config.owner, bot: false }, content: 'Hello firstmate', attachments: [], ...overrides });
  const calls = async () => {
    try { return (await readFile(join(config.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { root, config, discord, rest, state, inbox, relay, errors, message, calls };
}
