import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createLog(path, now = () => new Date()) {
  return line => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${now().toISOString()} pid=${process.pid} ${line}\n`, { mode: 0o600 });
    } catch (error) { console.error(`Could not write ${path}: ${error.code || error.message}`); }
  };
}
