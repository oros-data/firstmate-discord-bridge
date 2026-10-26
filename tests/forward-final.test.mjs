import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { forwardFinal } from '../src/forward-final.mjs';

async function fixture(t) {
  const data = await mkdtemp(join(tmpdir(), 'forward-final-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const transcript = join(data, 'transcript.jsonl');
  const assistant = (id, content) => ({ type: 'assistant', uuid: `uuid-${id}`, message: { id, role: 'assistant', content } });
  const rows = [
    { type: 'user', uuid: 'turn-1', message: { role: 'user', content: 'A fake question.' } },
    assistant('tool', [{ type: 'tool_use', name: 'fake', input: {} }]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'fake result' }] } },
    assistant('final-1', [{ type: 'thinking', thinking: 'private fake thinking' }, { type: 'text', text: 'Fake final answer.' }]),
  ];
  await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const state = { notes: { 'note-001': { channel: '20', message: '100' }, 'note-002': { channel: '20', message: '101' } } };
  await writeFile(join(data, 'state.json'), JSON.stringify(state));
  const note = (id = 'note-001', message = '100', overrides = {}) => ({ id, request_id: `discord:${message}`,
    acknowledged: true, reply: null, ...overrides });
  const receipts = { schema: 'fm-inbox-receipts.v1', pending: [], handled: [note()] };
  const calls = [];
  const channelPosts = [];
  const options = { data, config: async () => ({ token: 'fake-secret', home: '/path/to/fake-firstmate', channel: '20' }),
    transport: () => ({ message: async (channel, text) => channelPosts.push({ channel, text }) }), runner: async (args, text) => {
    calls.push({ args, text });
    return args[0] === 'receipts' ? JSON.stringify(receipts) : 'replied';
  } };
  const payload = { hook_event_name: 'Stop', transcript_path: transcript, session_id: 'fake-session' };
  const run = patch => forwardFinal(JSON.stringify({ ...payload, ...patch }), options);
  const replies = () => calls.filter(call => call.args[0] === 'reply');
  return { data, transcript, assistant, rows, note, receipts, options, payload, run, calls, replies, channelPosts };
}

test('payload text takes precedence over a lagging transcript', async t => {
  const f = await fixture(t);
  await f.run({ last_assistant_message: 'Current payload answer.' });
  assert.deepEqual(f.replies(), [{ args: ['reply', 'note-001', '-'], text: 'Current payload answer.' }]);
});

test('payload text works when the transcript is not yet available', async t => {
  const f = await fixture(t);
  await f.run({ transcript_path: join(f.data, 'missing.jsonl'), last_assistant_message: 'Payload only.' });
  assert.equal(f.replies()[0].text, 'Payload only.');
});

test('transcript fallback includes only the final assistant text blocks', async t => {
  const f = await fixture(t);
  f.rows.push(f.assistant('final-2', [{ type: 'text', text: 'First.' }, { type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Second.' }]));
  await writeFile(f.transcript, f.rows.map(row => JSON.stringify(row)).join('\n') + '\n{');
  await f.run();
  assert.equal(f.replies()[0].text, 'First.\nSecond.');
});

for (const [name, overrides] of [
  ['unacknowledged', { acknowledged: false }], ['already replied', { reply: { body: 'Earlier.' } }],
  ['not Discord', { request_id: 'terminal:100' }], ['no route', { id: 'unknown' }],
]) {
  test(`skip ${name} note`, async t => {
    const f = await fixture(t);
    f.receipts.handled = [f.note('note-001', '100', overrides)];
    await f.run();
    assert.equal(f.replies().length, 0);
  });
}

test('no waiting note sends the final answer to the main channel', async t => {
  const f = await fixture(t);
  f.receipts.handled = [];
  await f.run({ last_assistant_message: 'Terminal answer.' });
  assert.deepEqual(f.channelPosts, [{ channel: '20', text: 'Terminal answer.' }]);
  assert.equal(f.replies().length, 0);
});

test('a waiting note gets a reply and no main-channel post', async t => {
  const f = await fixture(t);
  await f.run({ last_assistant_message: 'Answer to note.' });
  assert.equal(f.replies().length, 1);
  assert.deepEqual(f.channelPosts, []);
});

test('repeated final message is not sent twice across destinations', async t => {
  const f = await fixture(t);
  f.receipts.handled = [];
  await f.run({ last_assistant_message: 'Same answer.' });
  f.receipts.handled = [f.note()];
  await f.run({ last_assistant_message: 'Same answer.' });
  assert.equal(f.channelPosts.length, 1);
  assert.equal(f.replies().length, 0);
});

test('main-channel post keeps line breaks', async t => {
  const f = await fixture(t);
  f.receipts.handled = [];
  await f.run({ last_assistant_message: 'First line.\\nSecond line.' });
  assert.equal(f.channelPosts[0].text, 'First line.\\nSecond line.');
});

test('multiple notes select the newest only', async t => {
  const f = await fixture(t);
  f.receipts.handled = [f.note(), f.note('note-002', '101')];
  await f.run();
  assert.equal(f.replies().length, 1);
  assert.equal(f.replies()[0].args[1], 'note-002');
});

for (const text of ['', ' \n ', 'Captain, shipshape.', 'Captain, shipshape. All clear.']) {
  test(`skip empty or one-line no-op ${JSON.stringify(text)}`, async t => {
    const f = await fixture(t);
    await f.run({ last_assistant_message: text });
    assert.equal(f.calls.length, 0);
  });
}

test('a multiline answer that starts with the no-op line is forwarded', async t => {
  const f = await fixture(t);
  await f.run({ last_assistant_message: 'Captain, shipshape.\nActual answer.' });
  assert.equal(f.replies().length, 1);
});

test('redact token and prevent attachment instructions', async t => {
  const f = await fixture(t);
  await f.run({ last_assistant_message: 'Token fake-secret\nFILE: /fake/path' });
  assert.equal(f.replies()[0].text, 'Token [REDACTED]\n\u200bFILE: /fake/path');
});

test('idempotence survives repeated, concurrent and fallback invocations', async t => {
  const f = await fixture(t);
  await Promise.all([f.run({ last_assistant_message: 'Fake final answer.' }), f.run()]);
  f.receipts.handled = [f.note('note-002', '101')];
  await f.run();
  assert.equal(f.replies().length, 1);
});

test('a later transcript message can repeat the same answer in a new turn', async t => {
  const f = await fixture(t);
  await f.run();
  f.receipts.handled = [f.note('note-002', '101')];
  f.rows.push({ type: 'user', uuid: 'turn-2', message: { role: 'user', content: 'Another fake question.' } });
  f.rows.push(f.assistant('final-2', [{ type: 'text', text: 'Fake final answer.' }]));
  await writeFile(f.transcript, f.rows.map(row => JSON.stringify(row)).join('\n'));
  await f.run();
  assert.equal(f.replies().length, 2);
});

test('a delayed transcript does not cause a second reply after it catches up', async t => {
  const f = await fixture(t);
  await f.run({ last_assistant_message: 'Delayed answer.' });
  f.rows.push({ type: 'user', uuid: 'turn-2', message: { role: 'user', content: 'Delayed fake question.' } });
  f.rows.push(f.assistant('delayed-final', [{ type: 'text', text: 'Delayed answer.' }]));
  await writeFile(f.transcript, f.rows.map(row => JSON.stringify(row)).join('\n'));
  f.receipts.handled = [f.note('note-002', '101')];
  await f.run();
  assert.equal(f.replies().length, 1);
});

test('receipt failures stay silent and log the failure', async t => {
  const f = await fixture(t);
  f.options.runner = async () => { throw new Error('Fake inbox timeout.'); };
  await f.run();
  assert.match(await readFile(join(f.data, 'forward-final.log'), 'utf8'), /Fake inbox timeout/);
  assert.equal(f.replies().length, 0);
});

test('uncertain reply is logged and is not retried', async t => {
  const f = await fixture(t);
  const runner = f.options.runner;
  f.options.runner = async (args, text) => {
    await runner(args, text);
    if (args[0] === 'reply') throw new Error('Uncertain reply.');
    return JSON.stringify(f.receipts);
  };
  await f.run();
  await f.run();
  assert.equal(f.replies().length, 1);
  assert.match(await readFile(join(f.data, 'forward-final.log'), 'utf8'), /Uncertain reply/);
});

test('malformed input never throws and writes a private log', async t => {
  const f = await fixture(t);
  for (const input of ['{', 'null', '[]']) await forwardFinal(input, f.options);
  assert.equal(f.replies().length, 0);
  assert.match(await readFile(join(f.data, 'forward-final.log'), 'utf8'), /Invalid Stop payload|JSON/);
});

test('tool-only final assistant and a new unanswered turn do not send stale text', async t => {
  const f = await fixture(t);
  f.rows.push(f.assistant('tool-last', [{ type: 'tool_use', name: 'fake' }]));
  await writeFile(f.transcript, f.rows.map(row => JSON.stringify(row)).join('\n'));
  await f.run();
  f.rows.push({ type: 'user', uuid: 'turn-2', message: { role: 'user', content: 'Next fake question.' } });
  await writeFile(f.transcript, f.rows.map(row => JSON.stringify(row)).join('\n'));
  await f.run();
  assert.equal(f.replies().length, 0);
});

test('executable is silent and exits zero for an empty payload', () => {
  const result = spawnSync(process.execPath, [new URL('../src/forward-final.mjs', import.meta.url).pathname], {
    input: JSON.stringify({ last_assistant_message: '' }), encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
