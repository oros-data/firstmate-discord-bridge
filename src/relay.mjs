import { readdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadAttachment, MAX_FILE } from './files.mjs';
import { deliverOnce, preparePlan, loadPlannedFiles } from './delivery.mjs';
import { redact } from './config.mjs';

export class Relay {
  constructor(config, state, rest, firstmate, { fetcher = fetch, onError = () => {}, keepAwake = null } = {}) {
    Object.assign(this, { config, state, rest, firstmate, fetcher, onError, keepAwake });
    this.channelCache = new Map();
  }

  async allowed(message) {
    if (message.author?.bot || message.author?.id !== this.config.owner || message.guild_id !== this.config.guild) return false;
    if (!/^\d{1,20}$/.test(message.channel_id) || !/^\d{1,20}$/.test(message.id)) return false;
    if (message.channel_id === this.config.channel) return true;
    const cached = this.channelCache.get(message.channel_id);
    if (cached && cached.expires > Date.now()) return cached.allowed;
    const allowed = await this.rest.channelAllowed(message.channel_id, this.config);
    this.channelCache.set(message.channel_id, { allowed, expires: Date.now() + 60000 });
    return allowed;
  }

  async inbound(message) {
    if (!await this.allowed(message)) return false;
    try { this.keepAwake?.start(); } catch (error) { this.onError(error); }
    return this.state.run(async (state, save) => {
      state.pendingMessages ||= {};
      if (Object.hasOwn(state.messages, message.id)) return true;
      state.pendingMessages[message.id] = { ...message, content: redact(message.content || '', this.config.token) };
      await save();
      await this.saveNote(state, save, state.pendingMessages[message.id]);
      return true;
    });
  }

  async saveNote(state, save, message) {
    let note;
    try {
      const attachments = [];
      for (const attachment of message.attachments || []) {
        if (attachment.size > MAX_FILE) attachments.push('Attachment not downloaded: file exceeds 25 MB.');
        else attachments.push(`Attachment: ${await downloadAttachment(attachment, message.id, this.config.media, this.fetcher)}`);
      }
      const task = Object.entries(state.tasks).find(([, value]) => value.thread === message.channel_id)?.[0];
      const text = [task ? `[task ${task}]` : '', message.content || '', ...attachments].filter(Boolean).join('\n') || '[Discord message without text or files]';
      note = await this.firstmate.note(message.id, text);
      state.notes[note.id] = { channel: message.channel_id, message: message.id };
      state.messages[message.id] = note.id;
      delete state.pendingMessages[message.id];
      await save();
    } catch (error) {
      this.onError(error);
      try {
        await this.rest.reaction(message.channel_id, message.id, '⚠️');
        await deliverOnce(this.rest, state, save, `failure:${message.id}`, message.channel_id,
          'The note could not be saved. Check the local bridge log. The bridge will try again.');
      } catch (failure) { this.onError(failure); }
      return;
    }
    try { await this.rest.reaction(message.channel_id, message.id, note.announced === false ? '⚠️' : '👀'); }
    catch (error) { this.onError(error); }
    if (note.announced === false) {
      try {
        await deliverOnce(this.rest, state, save, `wake:${message.id}`, message.channel_id,
          'The note is saved. Firstmate could not receive the wake signal. Check the firstmate queue.');
      } catch (error) { this.onError(error); }
    }
  }

  async pollReplies() {
    return this.state.run(async (state, save) => {
      for (const message of Object.values(state.pendingMessages || {})) {
        if (await this.allowed(message)) await this.saveNote(state, save, message);
      }
      const receipts = await this.firstmate.receipts(state.cursor);
      for (const reply of receipts.replies) {
        if (typeof reply.cursor !== 'string' || !/^\d{12,}$/.test(reply.cursor) || reply.cursor <= state.cursor) {
          throw new Error('Invalid receipt cursor order.');
        }
        const note = Object.hasOwn(state.notes, reply.id) ? state.notes[reply.id] : null;
        if (note) {
          if (!await this.rest.channelAllowed(note.channel, this.config)) throw new Error('Reply channel is outside the allowlist.');
          state.replyPlans ||= {};
          const planKey = `${reply.id}:${reply.cursor}`;
          if (!Object.hasOwn(state.replyPlans, planKey)) {
            state.replyPlans[planKey] = await preparePlan(redact(reply.body, this.config.token), this.config.roots);
            await save();
          }
          const messages = state.replyPlans[planKey];
          for (let index = 0; index < messages.length; index++) {
            const key = `reply:${reply.id}:${reply.cursor}:${index}`;
            const files = state.deliveries[key] ? [] : await loadPlannedFiles(messages[index], this.config.roots);
            await deliverOnce(this.rest, state, save, key, note.channel, messages[index].text, files);
          }
          delete state.replyPlans[planKey];
        }
        state.cursor = reply.cursor;
        await save();
      }
      if (receipts.reply_cursor !== state.cursor) throw new Error('Receipt page cursor does not match its replies.');
    });
  }

  async pollTasks() {
    let entries;
    try { entries = await readdir(join(this.config.home, 'state'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.meta')) continue;
      const task = entry.name.slice(0, -5);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(task) || task.includes(this.config.token)) continue;
      try {
        await this.state.run(async (state, save) => {
          if (!Object.hasOwn(state.tasks, task)) state.tasks[task] = { offset: 0, generation: 0 };
          const record = state.tasks[task];
          if (!record.thread) {
            const active = await this.rest.request('GET', `/guilds/${this.config.guild}/threads/active`);
            const existing = active.threads.find(thread => thread.parent_id === this.config.channel && thread.name === task && thread.owner_id === this.botId);
            if (existing) record.thread = existing.id;
            else {
              if (record.creating) throw new Error(`Uncertain thread creation for ${task}. Check Discord before manual repair.`);
              record.creating = true;
              await save();
              const thread = await this.rest.request('POST', `/channels/${this.config.channel}/threads`, {
                name: task, type: 11, auto_archive_duration: 10080,
              });
              record.thread = thread.id;
            }
            delete record.creating;
            await save();
          }
          if (!await this.rest.channelAllowed(record.thread, this.config)) throw new Error(`Task thread is outside the allowlist: ${task}`);
          if (!record.opened) {
            const meta = await readFile(join(this.config.home, 'state', entry.name), 'utf8');
            const title = meta.match(/^title[=:]\s*(.+)$/m)?.[1]?.slice(0, 1000);
            await deliverOnce(this.rest, state, save, `opening:${task}:${record.thread}`, record.thread,
              redact(title ? `${task}\n${title}` : task, this.config.token));
            record.opened = true;
            await save();
          }
          await this.relayStatus(task, record, state, save);
        });
      } catch (error) { this.onError(error); }
    }
  }

  async relayStatus(task, record, state, save) {
    let handle;
    try { handle = await open(join(this.config.home, 'state', `${task}.status`), 'r'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      if (stat.size < record.offset) {
        record.offset = 0;
        record.generation++;
        record.skipLong = false;
        record.longState = null;
      }
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, record.offset);
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        const line = buffer.subarray(start, index).toString('utf8');
        const end = record.offset + index + 1;
        const word = record.skipLong ? record.longState : line.match(/^(done|blocked|needs-decision|failed)(?:\s|:|\[|$)/)?.[1];
        if (word) {
          await deliverOnce(this.rest, state, save, `status:${task}:${record.generation}:${end}`, record.thread, `${task}: ${word}`);
        }
        record.skipLong = false;
        record.longState = null;
        start = index + 1;
      }
      if (start) record.offset += start;
      else if (bytesRead === buffer.length) {
        if (!record.skipLong) record.longState = buffer.toString('utf8', 0, 40).match(/^(done|blocked|needs-decision|failed)(?:\s|:|\[|$)/)?.[1] || null;
        record.offset += bytesRead;
        record.skipLong = true;
      }
      await save();
    } finally { await handle.close(); }
  }
}
