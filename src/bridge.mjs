import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, redact } from './config.mjs';
import { State, acquireLock } from './state.mjs';
import { DiscordREST } from './rest.mjs';
import { Firstmate } from './firstmate.mjs';
import { Gateway } from './gateway.mjs';
import { Relay } from './relay.mjs';

export async function main(args = process.argv.slice(2)) {
  let config;
  let gateway;
  let release;
  const timers = new Set();
  const activePolls = new Set();
  let stopping = false;
  const errors = new Map();
  const logError = error => {
    const message = redact(error, config?.token || process.env.DISCORD_BOT_TOKEN);
    if (Date.now() - (errors.get(message) || 0) < 60000) return;
    errors.set(message, Date.now());
    console.error(message);
  };
  const stop = async () => {
    stopping = true;
    gateway?.stop();
    for (const timer of timers) clearTimeout(timer);
    await gateway?.dispatches;
    await Promise.allSettled([...activePolls]);
    if (release) { await release(); release = null; }
  };
  try {
    if (args.some(arg => !['--check', '--dry-run'].includes(arg)) || args.length > 1) {
      throw new Error('Usage: node src/bridge.mjs [--check|--dry-run]');
    }
    config = await loadConfig();
    if (args.includes('--dry-run')) {
      console.log(`Dry run: no connections and no writes.\nAllow owner ${config.owner} in guild ${config.guild}, channel ${config.channel}, and its threads.\nRun ${config.inbox} in ${config.home}.\nSave state in ${config.data}.\nDownload attachments to ${config.media}.\nPoll replies every 3 seconds. Poll tasks every 10 seconds.`);
      return;
    }
    await access(config.home, constants.R_OK);
    await access(config.inbox, constants.X_OK);
    const rest = new DiscordREST(config.token);
    const bot = await rest.request('GET', '/users/@me');
    if (!bot.bot) throw new Error('The configured token does not belong to a bot.');
    if (args.includes('--check')) {
      console.log(`Bot token is valid: ${redact(bot.username, config.token)} (${bot.id})`);
      return;
    }
    const channel = await rest.request('GET', `/channels/${config.channel}`);
    if (channel.guild_id !== config.guild || channel.type !== 0) throw new Error('DISCORD_CHANNEL_ID must be a text channel in DISCORD_GUILD_ID.');
    const gatewayInfo = await rest.request('GET', '/gateway/bot');
    if (gatewayInfo.session_start_limit?.remaining === 0) {
      throw new Error(`Discord session start limit reached. Retry after ${gatewayInfo.session_start_limit.reset_after} ms.`);
    }
    await mkdir(config.data, { recursive: true, mode: 0o700 });
    release = await acquireLock(join(config.data, 'bridge.lock'), 0);
    const state = new State(config.data);
    const relay = new Relay(config, state, rest, new Firstmate(config), { onError: logError });
    relay.botId = bot.id;
    const poll = async (action, interval) => {
      if (stopping) return;
      const operation = Promise.resolve().then(action);
      activePolls.add(operation);
      try { await operation; } catch (error) { logError(error); }
      finally { activePolls.delete(operation); }
      if (!stopping) {
        const timer = setTimeout(() => { timers.delete(timer); void poll(action, interval); }, interval);
        timers.add(timer);
      }
    };
    gateway = new Gateway({ token: config.token, url: gatewayInfo.url,
      onDispatch: async (type, message) => { if (type === 'MESSAGE_CREATE') await relay.inbound(message); },
      onError: logError,
      onFatal: error => { logError(error); process.exitCode = 1; void stop(); },
    });
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    gateway.start();
    void poll(() => relay.pollReplies(), 3000);
    void poll(() => relay.pollTasks(), 10000);
    console.log('Discord bridge started.');
  } catch (error) {
    logError(error);
    process.exitCode = 1;
    await stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
