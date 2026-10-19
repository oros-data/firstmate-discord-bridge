export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export class Gateway {
  constructor({ token, url, socket = url => new WebSocket(url), onDispatch = async () => {},
    onError = () => {}, onFatal = () => {}, random = Math.random,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    Object.assign(this, { token, url, socket, onDispatch, onError, onFatal, random, setTimer, clearTimer, now });
    this.sequence = null;
    this.committedSequence = null;
    this.session = null;
    this.resumeURL = null;
    this.stopped = true;
    this.failures = 0;
    this.lastIdentify = -Infinity;
    this.dispatches = Promise.resolve();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.acknowledged = true;
    this.ws = this.socket(`${this.resumeURL || this.url}${(this.resumeURL || this.url).includes('?') ? '&' : '?'}v=10&encoding=json`);
    const ws = this.ws;
    ws.addEventListener('message', event => {
      if (ws !== this.ws || this.stopped) return;
      try { this.receive(JSON.parse(event.data)); }
      catch (error) { this.onError(error); this.reconnect(); }
    });
    ws.addEventListener('close', event => {
      if (ws !== this.ws || this.stopped) return;
      if (FATAL_CODES.has(event.code)) {
        this.stop();
        this.onFatal(new Error(`Discord Gateway closed (${event.code}). Check the token and enabled intents.`));
      } else {
        if ([4007, 4009].includes(event.code)) this.clearSession();
        this.reconnect(event.code === 4008 ? 60000 : undefined);
      }
    });
    ws.addEventListener('error', () => { if (ws === this.ws && !this.stopped) this.reconnect(); });
    this.helloTimer = this.setTimer(() => this.reconnect(), 30000);
  }

  send(op, d) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
  }

  heartbeat() {
    if (!this.acknowledged) { this.reconnect(); return; }
    this.acknowledged = false;
    this.send(1, this.sequence);
    this.heartbeatTimer = this.setTimer(() => this.heartbeat(), this.interval);
  }

  receive(packet) {
    if (packet.s != null) this.sequence = packet.s;
    switch (packet.op) {
      case 10:
        this.clearTimer(this.helloTimer);
        this.interval = packet.d.heartbeat_interval;
        if (!Number.isFinite(this.interval) || this.interval <= 0) throw new Error('Invalid Gateway heartbeat interval.');
        this.clearTimer(this.heartbeatTimer);
        this.heartbeatTimer = this.setTimer(() => this.heartbeat(), this.interval * this.random());
        if (this.session && this.committedSequence != null) {
          this.send(6, { token: this.token, session_id: this.session, seq: this.committedSequence });
        } else {
          const identify = () => {
            this.lastIdentify = this.now();
            this.send(2, { token: this.token, intents: INTENTS,
              properties: { os: process.platform, browser: 'firstmate-bridge', device: 'firstmate-bridge' } });
          };
          const wait = Math.max(0, 5000 - (this.now() - this.lastIdentify));
          if (wait) this.identifyTimer = this.setTimer(identify, wait);
          else identify();
        }
        break;
      case 11:
        this.acknowledged = true;
        break;
      case 1:
        this.acknowledged = false;
        this.send(1, this.sequence);
        break;
      case 7:
        this.reconnect(0);
        break;
      case 9:
        if (!packet.d) this.clearSession();
        this.reconnect(1000 + this.random() * 4000);
        break;
      case 0:
        if (packet.t === 'READY') {
          this.session = packet.d.session_id;
          this.resumeURL = packet.d.resume_gateway_url;
        }
        if (['READY', 'RESUMED'].includes(packet.t)) this.failures = 0;
        {
          const session = this.session;
          this.dispatches = this.dispatches.then(async () => {
            while (!this.stopped) {
              try {
                await this.onDispatch(packet.t, packet.d);
                if (session === this.session) this.committedSequence = packet.s;
                break;
              } catch (error) {
                this.onError(error);
                await new Promise(resolve => this.setTimer(resolve, 1000));
              }
            }
          });
        }
        break;
    }
  }

  clearSession() {
    this.session = null;
    this.resumeURL = null;
    this.sequence = null;
    this.committedSequence = null;
  }

  clearTimers() {
    for (const key of ['heartbeatTimer', 'helloTimer', 'identifyTimer', 'reconnectTimer']) this.clearTimer(this[key]);
  }

  reconnect(wait) {
    if (this.stopped) return;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(4000, 'Reconnect');
    const milliseconds = wait ?? Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6)) * (0.5 + this.random());
    this.reconnectTimer = this.setTimer(() => this.connect(), milliseconds);
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'Bridge stopped');
  }
}
