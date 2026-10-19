import { execFile } from 'node:child_process';

export class Firstmate {
  constructor(config) { this.config = config; }

  call(args, savedOnExit3 = false) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, FM_HOME: this.config.home };
      for (const key of ['DISCORD_BOT_TOKEN', 'FM_STATE_OVERRIDE', 'FM_DATA_OVERRIDE', 'FM_CONFIG_OVERRIDE']) delete env[key];
      execFile(this.config.inbox, args, {
        cwd: this.config.home,
        env,
        maxBuffer: 16 * 1024 * 1024, timeout: 60000,
      }, (error, stdout) => {
        if (error && !(savedOnExit3 && error.code === 3)) {
          reject(new Error(`Firstmate inbox failed (${error.code ?? 'unknown'}). Check the firstmate home and inbox command.`));
          return;
        }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('Firstmate inbox returned invalid JSON.')); }
      });
    });
  }

  async note(messageId, text) {
    const result = await this.call(['note', '--request-id', `discord:${messageId}`, '--json', '--', text], true);
    if (result.schema !== 'fm-inbox-note.v1' || !result.saved || !result.id) throw new Error('Firstmate did not save the note.');
    return result;
  }

  async receipts(cursor) {
    const result = await this.call(['receipts', ...(cursor ? ['--after', cursor] : [])]);
    if (result.schema !== 'fm-inbox-receipts.v1' || !Array.isArray(result.replies)
      || typeof result.reply_cursor !== 'string') throw new Error('Invalid firstmate receipts.');
    return result;
  }
}
