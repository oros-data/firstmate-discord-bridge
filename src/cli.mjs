import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, redact } from './config.mjs';
import { State } from './state.mjs';
import { DiscordREST } from './rest.mjs';
import { readAllowedFile } from './files.mjs';
import { deliverOnce, splitText } from './delivery.mjs';

export function parsePost(args) {
  if (args[0] !== 'post') throw new Error('Usage: node src/cli.mjs post --thread <id|task-id> --text <text> [--file <absolute path>]');
  const options = { files: [] };
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--thread', '--text', '--file'].includes(key) || value === undefined) throw new Error('Invalid post option.');
    if (key === '--file') options.files.push(value);
    else {
      const name = key.slice(2);
      if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${key}`);
      options[name] = value;
    }
  }
  if (!options.thread || !options.text?.trim() || options.files.length > 10) throw new Error('Post needs --thread and --text, with no more than 10 files.');
  return options;
}

export async function post(config, options, rest = new DiscordREST(config.token), state = new State(config.data)) {
  const files = [];
  for (const path of options.files) files.push(await readAllowedFile(path, config.roots));
  return state.run(async (data, save) => {
    const channel = Object.hasOwn(data.tasks, options.thread) ? data.tasks[options.thread].thread : options.thread;
    if (!/^\d{1,20}$/.test(channel) || !await rest.channelAllowed(channel, config)) throw new Error('Post target is outside the allowlist.');
    const parts = splitText(redact(options.text, config.token)).filter(part => part.trim());
    const key = `progress:${randomUUID()}`;
    const ids = [];
    for (let index = 0; index < parts.length; index++) {
      ids.push(await deliverOnce(rest, data, save, `${key}:text:${index}`, channel, parts[index]));
    }
    for (let index = 0; index < files.length; index++) {
      ids.push(await deliverOnce(rest, data, save, `${key}:file:${index}`, channel, '', [files[index]]));
    }
    return ids;
  });
}

export async function main(args = process.argv.slice(2)) {
  let config;
  try {
    const options = parsePost(args);
    config = await loadConfig();
    for (const id of await post(config, options)) console.log(id);
  } catch (error) {
    console.error(redact(error, config?.token || process.env.DISCORD_BOT_TOKEN));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
