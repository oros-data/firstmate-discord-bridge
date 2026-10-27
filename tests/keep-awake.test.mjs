import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KeepAwake } from '../src/keep-awake.mjs';
import { fixture } from './helpers.mjs';
import { Relay } from '../src/relay.mjs';

function child() {
  const process = new EventEmitter();
  process.killCount = 0;
  process.kill = () => { process.killCount++; };
  process.unref = () => {};
  return process;
}

test('disabled or non-macOS setting starts nothing', () => {
  let count = 0;
  new KeepAwake(0, { platform: 'darwin', starter: () => count++ }).start();
  new KeepAwake(7200, { platform: 'linux', starter: () => count++ }).start();
  assert.equal(count, 0);
});

test('starts detached caffeinate with requested timeout and replaces prior child', () => {
  const calls = [];
  const children = [];
  const awake = new KeepAwake(7200, { platform: 'darwin', starter: (...args) => { calls.push(args); const proc = child(); children.push(proc); return proc; } });
  awake.start();
  awake.start();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['caffeinate', ['-i', '-s', '-t', '7200'], { detached: true, stdio: 'ignore' }]);
  assert.equal(children[0].killCount, 1);
});

test('start failure is reported without throwing', () => {
  const errors = [];
  const awake = new KeepAwake(7200, { platform: 'darwin', starter: () => { throw new Error('missing'); }, onError: error => errors.push(error) });
  assert.doesNotThrow(() => awake.start());
  assert.equal(errors.length, 1);
});

test('only accepted captain messages start blocker and failures do not break handling', async t => {
  const f = await fixture(t);
  let starts = 0;
  f.relay.keepAwake = { start: () => { starts++; throw new Error('ignored by relay'); } };
  assert.equal(await f.relay.inbound(f.message({ author: { id: '9' } })), false);
  assert.equal(starts, 0);
  assert.equal(await f.relay.inbound(f.message()), true);
  assert.equal(starts, 1);
});
