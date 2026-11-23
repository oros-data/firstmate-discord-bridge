import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createLog } from '../src/log.mjs';
import { acquireLock } from '../src/state.mjs';
import { fixture } from './helpers.mjs';

const run = promisify(execFile);

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(child, 'exit');
  return child.pid;
}

test('log lines carry a timestamp and process id and the file is private', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'logs', 'lifecycle.log');
  const log = createLog(path, () => new Date('2026-11-23T12:00:00Z'));
  log('start');
  log('stop signal SIGTERM');
  assert.equal(await readFile(path, 'utf8'), `2026-11-23T12:00:00.000Z pid=${process.pid} start\n2026-11-23T12:00:00.000Z pid=${process.pid} stop signal SIGTERM\n`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a lock held by a dead process is taken over and reported', async t => {
  const f = await fixture(t);
  const lock = join(f.config.data, 'bridge.lock');
  const pid = await deadPid();
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'pid'), String(pid));
  const taken = [];
  const release = await acquireLock(lock, 0, { onTakeover: previous => taken.push(previous) });
  assert.deepEqual(taken, [pid]);
  assert.equal(await readFile(join(lock, 'pid'), 'utf8'), String(process.pid));
  await release();
});

test('a lock held by a live process is refused and not reported as taken over', async t => {
  const f = await fixture(t);
  const lock = join(f.config.data, 'bridge.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'pid'), String(process.pid));
  const taken = [];
  await assert.rejects(acquireLock(lock, 0, { onTakeover: previous => taken.push(previous) }), /locked/);
  assert.deepEqual(taken, []);
});

test('a failed start logs its reason and exit code without the token', async t => {
  const f = await fixture(t);
  const env = { ...process.env, DISCORD_BOT_TOKEN: f.config.token, DISCORD_GUILD_ID: '10', DISCORD_CHANNEL_ID: '20', DISCORD_OWNER_ID: '30', FM_HOME: join(f.root, 'missing-home') };
  await assert.rejects(run(process.execPath, [join(process.cwd(), 'src/bridge.mjs')], { cwd: f.root, env }), error => error.code === 1);
  const log = await readFile(join(f.root, 'logs', 'lifecycle.log'), 'utf8');
  assert.match(log, /start node=/);
  assert.match(log, /startup failed: .*missing-home/);
  assert.match(log, /exit code=1/);
  assert.ok(!log.includes(f.config.token));
});
