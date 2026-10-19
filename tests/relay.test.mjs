import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fixture } from './helpers.mjs';
import { State } from '../src/state.mjs';
import { Relay } from '../src/relay.mjs';
import { prepareReply, splitText, deliverOnce } from '../src/delivery.mjs';
import { readAllowedFile, downloadAttachment, MAX_FILE } from '../src/files.mjs';
import { post, parsePost } from '../src/cli.mjs';

test('allowlist ignores bots and wrong user, guild, channel, and thread parent', async t => {
  const f = await fixture(t);
  for (const message of [f.message({ author: { id: '9' } }), f.message({ author: { id: '30', bot: true } }),
    f.message({ guild_id: '9' }), f.message({ channel_id: '9' }), f.message({ guild_id: undefined })]) {
    assert.equal(await f.relay.inbound(message), false);
  }
  f.discord.channels.set('51', { id: '51', guild_id: '10', type: 11, parent_id: '999' });
  assert.equal(await f.relay.inbound(f.message({ channel_id: '51' })), false);
  assert.deepEqual(await f.calls(), []);
  assert.equal(f.discord.calls.filter(call => call.method === 'POST').length, 0);
});

test('inbound uses request id and argument list, saves media and mapping, and ignores redelivery after restart', async t => {
  const f = await fixture(t);
  const message = f.message({ content: '--danger $(touch nope) "hello"', attachments: [{ id: '88', filename: '../../screen shot.png', size: 10, url: 'https://cdn.discordapp.com/attachments/1/88/image.png' }] });
  assert.equal(await f.relay.inbound(message), true);
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 5), ['note', '--request-id', 'discord:100', '--json', '--']);
  assert.equal(calls[0].cwd, f.config.home);
  const path = calls[0].args[5].split('Attachment: ')[1];
  assert.ok(isAbsolute(path));
  assert.equal(path, join(f.config.media, '100', '88-_.._screen_shot.png'));
  assert.equal(await readFile(path, 'utf8'), 'fake image');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(calls[0].args[5].startsWith('--danger $(touch nope) "hello"'));
  const next = new Relay(f.config, new State(f.config.data), f.rest, f.inbox);
  await next.inbound(message);
  assert.equal((await f.calls()).length, 1);
  await f.state.run(data => {
    assert.ok(data.messages['100']);
    assert.deepEqual(data.notes[data.messages['100']], { channel: '20', message: '100' });
  });
  assert.ok(f.discord.calls.some(call => call.path.includes('/reactions/')));
});

test('request id repairs a crash after note creation but before the mapping save', async t => {
  const f = await fixture(t);
  const originalSave = f.state.save.bind(f.state);
  let failed = false;
  f.state.save = async data => {
    if (!failed && data.messages['100']) { failed = true; throw new Error('simulated disk error'); }
    return originalSave(data);
  };
  await f.relay.inbound(f.message());
  const calls = (await f.calls()).filter(call => call.args[0] === 'note');
  assert.equal(calls[0].args[2], 'discord:100');
  await f.state.run(data => {
    delete data.messages['100'];
    data.notes = {};
    data.pendingMessages['100'] = f.message();
  });
  await f.relay.pollReplies();
  const retries = (await f.calls()).filter(call => call.args[0] === 'note');
  assert.equal(retries.length, 2);
  assert.equal(retries[1].args[2], retries[0].args[2]);
});

test('the inbox adapter returns the real note JSON shape and preserves request id replay', async t => {
  const f = await fixture(t);
  const first = await f.inbox.note('100', 'original');
  const replay = await f.inbox.note('100', 'original');
  assert.equal(first.outcome, 'created');
  assert.equal(replay.outcome, 'replay');
  assert.equal(first.id, replay.id);
  assert.equal(first.saved, true);
  assert.equal(first.request_id, 'discord:100');
});

test('oversized inbound files are not downloaded and the text still reaches firstmate', async t => {
  const f = await fixture(t);
  f.relay.fetcher = async () => { throw new Error('must not download'); };
  await f.relay.inbound(f.message({ attachments: [{ id: '88', size: MAX_FILE + 1 }] }));
  assert.match((await f.calls())[0].args[5], /Attachment not downloaded/);
  await f.state.run(data => assert.ok(data.messages['100']));
});

test('task-thread messages carry the task prefix', async t => {
  const f = await fixture(t);
  f.discord.channels.set('50', { id: '50', parent_id: '20', guild_id: '10', type: 11 });
  await f.state.run(data => { data.tasks['task-one'] = { thread: '50' }; });
  await f.relay.inbound(f.message({ channel_id: '50' }));
  assert.equal((await f.calls())[0].args[5], '[task task-one]\nHello firstmate');
});

test('saved-but-unannounced notes return exit 3 and remain mapped', async t => {
  const f = await fixture(t);
  await writeFile(join(f.config.home, 'failed-wake'), '');
  await f.relay.inbound(f.message());
  await f.state.run(data => assert.ok(data.messages['100']));
  assert.ok([...f.discord.history.values()].flat().some(message => message.content.includes('note is saved')));
});

test('inbox failure leaves durable input and posts one warning on retries', async t => {
  const f = await fixture(t);
  f.relay.firstmate = { note: async () => { throw new Error('not running'); }, receipts: async () => ({ replies: [], reply_cursor: '' }) };
  await f.relay.inbound(f.message());
  await f.relay.pollReplies();
  await f.state.run(data => assert.ok(data.pendingMessages['100']));
  assert.equal([...f.discord.history.values()].flat().filter(message => message.content.includes('could not be saved')).length, 1);
});

test('outbound splits replies, sends allowed files, removes FILE lines and persists paged cursors', async t => {
  const f = await fixture(t);
  await f.relay.inbound(f.message());
  let noteId;
  await f.state.run(data => { noteId = data.messages['100']; });
  const path = join(f.config.home, 'data', 'answer.txt');
  await writeFile(path, 'answer file');
  await writeFile(join(f.config.home, 'receipts.json'), JSON.stringify([
    { id: noteId, cursor: '000000000001', body: 'a'.repeat(1500) + '\n\n' + 'b'.repeat(2200) + `\nFILE: ${path}` },
    { id: 'other-note', cursor: '000000000002', body: 'must not post' },
    { id: 'other-note-two', cursor: '000000000003', body: 'must not post either' },
  ]));
  await f.relay.pollReplies();
  const posts = f.discord.calls.filter(call => call.method === 'POST');
  assert.ok(posts.length >= 3);
  assert.ok(posts.every(call => call.body.content.length <= 1900 && !call.body.content.includes('FILE:')));
  assert.equal(posts.flatMap(call => call.files).length, 1);
  assert.equal(await posts.flatMap(call => call.files)[0].text(), 'answer file');
  const count = posts.length;
  const restarted = new Relay(f.config, new State(f.config.data), f.rest, f.inbox);
  await restarted.pollReplies();
  await restarted.pollReplies();
  assert.equal(f.discord.calls.filter(call => call.method === 'POST').length, count);
  await f.state.run(data => assert.equal(data.cursor, '000000000003'));
  const receipts = (await f.calls()).filter(call => call.args[0] === 'receipts');
  assert.deepEqual(receipts[1].args, ['receipts', '--after', '000000000002']);
});

test('a lost POST response is reconciled without a duplicate and queued attachments cannot change', async t => {
  const f = await fixture(t);
  await f.relay.inbound(f.message());
  let noteId;
  await f.state.run(data => { noteId = data.messages['100']; });
  const file = join(f.config.media, 'result.txt');
  await writeFile(file, 'original');
  await writeFile(join(f.config.home, 'receipts.json'), JSON.stringify([
    { id: noteId, cursor: '000000000001', body: 'x'.repeat(2500) + `\nFILE: ${file}` },
  ]));
  const send = f.rest.message.bind(f.rest);
  f.rest.message = async (...args) => { await send(...args); throw new Error('response lost'); };
  await assert.rejects(f.relay.pollReplies(), /response lost/);
  await f.state.run(data => {
    assert.equal(data.cursor, '');
    assert.ok(data.replyPlans[`${noteId}:000000000001`]);
  });
  f.rest.message = send;
  await writeFile(file, 'changed');
  const next = new Relay(f.config, new State(f.config.data), f.rest, f.inbox);
  await assert.rejects(next.pollReplies(), /queued attachment changed/);
  assert.equal(f.discord.history.get('20').length, 2);
  await writeFile(file, 'original');
  await next.pollReplies();
  await next.pollReplies();
  assert.equal(f.discord.history.get('20').length, 3);
  await f.state.run(data => assert.equal(data.cursor, '000000000001'));
});

test('file roots reject external paths, traversal, relative paths, and escaping symlinks', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'private.txt');
  await writeFile(outside, 'secret');
  const link = join(f.config.media, 'link.txt');
  await symlink(outside, link);
  for (const path of [outside, link, 'relative.txt', join(f.config.media, '..', '..', 'private.txt')]) {
    await assert.rejects(readAllowedFile(path, f.config.roots));
  }
  const prepared = await prepareReply(`Safe answer\nFILE: ${outside}\nFILE: ${link}`, f.config.roots);
  assert.equal(prepared.flatMap(message => message.files).length, 0);
  assert.ok(prepared[0].text.startsWith('Safe answer'));
  assert.ok(!prepared[0].text.includes(outside));
  assert.ok(prepared[0].text.includes('refused'));
});

test('attachment download validates hosts and enforces declared and streamed caps', async t => {
  const f = await fixture(t);
  let requested = 0;
  const fetcher = async () => { requested++; return new Response(new Uint8Array(MAX_FILE + 1)); };
  const item = { id: '88', filename: 'x', size: 1, url: 'https://cdn.discordapp.com/attachments/a/b/c' };
  await assert.rejects(downloadAttachment({ ...item, size: MAX_FILE + 1 }, '100', f.config.media, fetcher), /25 MB/);
  await assert.rejects(downloadAttachment({ ...item, url: 'http://localhost/a' }, '100', f.config.media, fetcher), /Invalid/);
  assert.equal(requested, 0);
  await assert.rejects(downloadAttachment(item, '100', f.config.media, fetcher), /25 MB/);
});

test('one new task gets one thread and one opening; status relay uses offsets and sends only the state word', async t => {
  const f = await fixture(t);
  const meta = join(f.config.home, 'state', 'task-one.meta');
  const status = join(f.config.home, 'state', 'task-one.status');
  await writeFile(meta, 'title=Build the bridge\n');
  await writeFile(status, `working: private text\ndone [at=1]: ${f.config.token} secret\nblocked: secret detail\nneeds-decision: choose\nfailed: detail\ndone partial`);
  await f.relay.pollTasks();
  await f.relay.pollTasks();
  assert.equal(f.discord.calls.filter(call => call.path.endsWith('/threads') && call.method === 'POST').length, 1);
  const messages = [...f.discord.history.values()].flat();
  assert.equal(messages.filter(message => message.content.includes('Build the bridge')).length, 1);
  assert.deepEqual(messages.slice(1).map(message => message.content), ['task-one: done', 'task-one: blocked', 'task-one: needs-decision', 'task-one: failed']);
  assert.ok(messages.every(message => !message.content.includes('secret')));
  await writeFile(status, 'done partial line\n', { flag: 'a' });
  const next = new Relay(f.config, new State(f.config.data), f.rest, f.inbox);
  next.botId = '40';
  await next.pollTasks();
  await next.pollTasks();
  assert.equal([...f.discord.history.values()].flat().length, 6);
});

test('status relay handles a long line and never sends its private content', async t => {
  const f = await fixture(t);
  await writeFile(join(f.config.home, 'state', 'long-task.meta'), '');
  await writeFile(join(f.config.home, 'state', 'long-task.status'), 'blocked: ' + 'private'.repeat(12000) + '\n');
  await f.relay.pollTasks();
  await f.relay.pollTasks();
  await f.relay.pollTasks();
  const messages = [...f.discord.history.values()].flat();
  assert.deepEqual(messages.map(message => message.content), ['long-task', 'long-task: blocked']);
});

test('thread creation recovers a lost response without creating a second thread', async t => {
  const f = await fixture(t);
  await writeFile(join(f.config.home, 'state', 'task-recover.meta'), 'title=Recovery\n');
  const request = f.rest.request.bind(f.rest);
  let lost = false;
  f.rest.request = async (...args) => {
    const result = await request(...args);
    if (!lost && args[0] === 'POST' && args[1].endsWith('/threads')) { lost = true; throw new Error('lost thread response'); }
    return result;
  };
  await f.relay.pollTasks();
  await f.relay.pollTasks();
  assert.equal(f.discord.calls.filter(call => call.method === 'POST' && call.path.endsWith('/threads')).length, 1);
  await f.state.run(data => assert.ok(data.tasks['task-recover'].opened));
});

test('uncertain delivery reconciles by nonce after a restart and refuses unsafe resend', async t => {
  const f = await fixture(t);
  let record;
  await f.state.run(async (data, save) => {
    const id = await deliverOnce(f.rest, data, save, 'reply-key', '20', 'answer');
    record = data.deliveries['reply-key'];
    assert.ok(id);
    delete record.id;
  });
  await f.state.run(async (data, save) => {
    await deliverOnce(f.rest, data, save, 'reply-key', '20', 'answer');
  });
  assert.equal(f.discord.history.get('20').length, 1);
  f.discord.history.set('20', []);
  await f.state.run(async (data, save) => {
    delete data.deliveries['reply-key'].id;
    await assert.rejects(deliverOnce(f.rest, data, save, 'reply-key', '20', 'answer'), /Uncertain/);
  });
  assert.equal(f.discord.history.get('20').length, 0);
});

test('progress command resolves task ids and checks targets and attachment roots', async t => {
  const f = await fixture(t);
  f.discord.channels.set('50', { id: '50', parent_id: '20', guild_id: '10', type: 11 });
  await f.state.run(data => { data.tasks.work = { thread: '50' }; });
  const file = join(f.config.media, 'progress.txt');
  await writeFile(file, 'progress');
  const ids = await post(f.config, parsePost(['post', '--thread', 'work', '--text', 'Update', '--file', file]), f.rest, f.state);
  assert.equal(ids.length, 2);
  assert.equal(f.discord.history.get('50').length, 2);
  await assert.rejects(post(f.config, { thread: '999', text: 'no', files: [] }, f.rest, f.state), /allowlist/);
  await assert.rejects(post(f.config, { thread: 'work', text: 'no', files: [join(f.config.home, 'calls.jsonl')] }, f.rest, f.state));
  assert.throws(() => parsePost(['post', '--thread', '20']), /needs/);
});

test('split boundaries preserve short lines and do not cut a surrogate pair', () => {
  assert.deepEqual(splitText('abc\n\ndef', 6), ['abc', 'def']);
  const input = 'x'.repeat(1899) + '😀' + 'tail';
  const parts = splitText(input);
  assert.ok(parts.every(part => part.length <= 1900));
  assert.equal(parts.join(''), input);
});
