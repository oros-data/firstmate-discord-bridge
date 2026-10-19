import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function acquireLock(path, wait = 15000) {
  const deadline = Date.now() + wait;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'pid.tmp'), String(process.pid), { mode: 0o600 });
      await rename(join(path, 'pid.tmp'), join(path, 'pid'));
      return () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(join(path, 'pid'), 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid lock: ${path}`);
        try { process.kill(pid, 0); }
        catch (failure) {
          if (failure.code !== 'ESRCH') throw failure;
          const reaper = `${path}.reap`;
          let ownsReaper = false;
          try {
            await mkdir(reaper, { mode: 0o700 });
            ownsReaper = true;
            const current = Number(await readFile(join(path, 'pid'), 'utf8'));
            if (current === pid) {
              let dead = false;
              try { process.kill(current, 0); }
              catch (check) { if (check.code === 'ESRCH') dead = true; else throw check; }
              if (dead) await rm(path, { recursive: true, force: true });
            }
          } catch (check) {
            if (!['EEXIST', 'ENOENT'].includes(check.code)) throw check;
          } finally { if (ownsReaper) await rm(reaper, { recursive: true, force: true }); }
          if (ownsReaper) continue;
        }
      } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      if (Date.now() >= deadline) throw new Error(`Bridge state is locked: ${path}`);
      await delay(100);
    }
  }
}

export class State {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'state.json');
  }

  async save(state) {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flush: true });
    await rename(temporary, this.path);
  }

  async run(action) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await acquireLock(join(this.directory, 'state.lock'));
    try {
      let state;
      try { state = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { version: 1, cursor: '', notes: {}, messages: {}, tasks: {}, deliveries: {} };
      }
      if (state.version !== 1 || typeof state.cursor !== 'string'
        || !state.notes || !state.messages || !state.tasks || !state.deliveries) {
        throw new Error('Invalid bridge state. Restore state.json from a backup.');
      }
      const result = await action(state, () => this.save(state));
      await this.save(state);
      return result;
    } finally { await release(); }
  }
}
