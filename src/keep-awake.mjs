import { spawn } from 'node:child_process';

export class KeepAwake {
  constructor(seconds, { platform = process.platform, starter = spawn, onError = () => {} } = {}) {
    Object.assign(this, { seconds, platform, starter, onError });
    this.child = null;
  }

  start() {
    if (!this.seconds || this.platform !== 'darwin') return;
    this.stop();
    try {
      this.child = this.starter('caffeinate', ['-i', '-s', '-t', String(this.seconds)], { detached: true, stdio: 'ignore' });
      this.child.once?.('error', error => { this.child = null; this.onError(error); });
      this.child.unref?.();
    } catch (error) {
      this.child = null;
      this.onError(error);
    }
  }

  stop() {
    if (!this.child) return;
    try { this.child.kill(); } catch (error) { this.onError(error); }
    this.child = null;
  }
}
