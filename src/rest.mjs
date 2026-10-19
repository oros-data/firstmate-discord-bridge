import { setTimeout as delay } from 'node:timers/promises';
import { redact } from './config.mjs';

export class DiscordREST {
  constructor(token, { fetcher = fetch, sleep = delay } = {}) {
    this.token = token;
    this.fetcher = fetcher;
    this.sleep = sleep;
    this.tail = Promise.resolve();
    this.nextRequest = 0;
  }

  request(method, path, body, files = []) {
    const operation = this.tail.then(() => this.perform(method, path, body, files));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async perform(method, path, body, files) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Discord REST path.');
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.sleep(Math.max(0, this.nextRequest - Date.now()));
      const headers = { Authorization: `Bot ${this.token}`, 'User-Agent': 'DiscordBot (https://discord.com/developers/docs, 0.1.0)' };
      let payload;
      if (files.length) {
        payload = new FormData();
        payload.append('payload_json', JSON.stringify({ ...body, attachments: files.map((file, id) => ({ id, filename: file.name })) }));
        files.forEach((file, id) => payload.append(`files[${id}]`, new Blob([file.data]), file.name));
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      let response;
      try {
        response = await this.fetcher(`https://discord.com/api/v10${path}`, {
          method, headers, body: payload, signal: AbortSignal.timeout(60000), redirect: 'error',
        });
      } catch (error) { throw new Error(`Discord request failed: ${redact(error, this.token)}`); }
      if (response.headers.get('x-ratelimit-remaining') === '0') {
        this.nextRequest = Date.now() + Number(response.headers.get('x-ratelimit-reset-after') || 1) * 1000;
      }
      if (response.status === 429) {
        const result = await response.json();
        const seconds = Number(result.retry_after);
        this.nextRequest = Date.now() + (Number.isFinite(seconds) ? Math.max(seconds, 0.1) : 5) * 1000;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (method === 'GET' && response.status >= 500 && attempt < 7) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        throw new Error(`Discord REST ${method} failed (${response.status}). Check bot permissions and upload limits.`);
      }
      return response.status === 204 ? null : response.json();
    }
    throw new Error('Discord rate limit retry limit reached.');
  }

  message(channel, text, files = [], nonce) {
    return this.request('POST', `/channels/${channel}/messages`, {
      content: text, allowed_mentions: { parse: [] }, ...(nonce ? { nonce, enforce_nonce: true } : {}),
    }, files);
  }

  reaction(channel, message, emoji) {
    return this.request('PUT', `/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async channelAllowed(id, config) {
    const channel = await this.request('GET', `/channels/${id}`);
    return channel.guild_id === config.guild && (id === config.channel
      || ([10, 11, 12].includes(channel.type) && channel.parent_id === config.channel));
  }
}
