import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, INTENTS } from '../src/gateway.mjs';

function harness(overrides = {}) {
  const sockets = [];
  const timers = new Map();
  const errors = [];
  const fatals = [];
  let timerId = 0;
  const gateway = new Gateway({ token: 'fake-token', url: 'wss://gateway.discord.gg',
    socket: url => {
      const listeners = new Map();
      const ws = { url, readyState: 1, sent: [], closed: [],
        addEventListener: (name, listener) => listeners.set(name, listener),
        send: data => ws.sent.push(JSON.parse(data)),
        close: (...args) => ws.closed.push(args),
        emit: (name, data) => listeners.get(name)?.(data),
        receive: packet => ws.emit('message', { data: JSON.stringify(packet) }),
      };
      sockets.push(ws);
      return ws;
    },
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id), random: () => 0.25, now: () => 10000,
    onError: error => errors.push(error), onFatal: error => fatals.push(error), ...overrides,
  });
  const fire = id => { const timer = timers.get(id); assert.ok(timer); timers.delete(id); timer.fn(); };
  gateway.start();
  return { gateway, sockets, timers, fire, errors, fatals };
}

test('Gateway identifies with exact intents, starts a jittered heartbeat and uses the received sequence', async () => {
  const h = harness();
  const ws = h.sockets[0];
  ws.receive({ op: 10, d: { heartbeat_interval: 40000 } });
  assert.equal(ws.sent[0].op, 2);
  assert.equal(ws.sent[0].d.intents, 33281);
  assert.equal(INTENTS, 33281);
  assert.equal(h.timers.get(h.gateway.heartbeatTimer).ms, 10000);
  ws.receive({ op: 0, t: 'READY', s: 7, d: { session_id: 'session', resume_gateway_url: 'wss://resume.discord.gg' } });
  await h.gateway.dispatches;
  h.fire(h.gateway.heartbeatTimer);
  assert.deepEqual(ws.sent.at(-1), { op: 1, d: 7 });
  ws.receive({ op: 11 });
  h.fire(h.gateway.heartbeatTimer);
  assert.equal(h.sockets.length, 1);
  h.gateway.stop();
  assert.equal(h.timers.size, 0);
});

test('Gateway resumes after drop and a missing heartbeat ACK triggers reconnect', async () => {
  const h = harness();
  const ws = h.sockets[0];
  ws.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  ws.receive({ op: 0, t: 'READY', s: 9, d: { session_id: 'session', resume_gateway_url: 'wss://resume.discord.gg' } });
  await h.gateway.dispatches;
  h.fire(h.gateway.heartbeatTimer);
  h.fire(h.gateway.heartbeatTimer);
  assert.equal(ws.closed[0][0], 4000);
  h.fire(h.gateway.reconnectTimer);
  const next = h.sockets[1];
  next.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.ok(next.url.startsWith('wss://resume.discord.gg'));
  assert.deepEqual(next.sent[0], { op: 6, d: { token: 'fake-token', session_id: 'session', seq: 9 } });
  h.gateway.stop();
});

test('invalid session clears resume data and reconnects with a random delay', async () => {
  const h = harness();
  h.sockets[0].receive({ op: 0, t: 'READY', s: 9, d: { session_id: 'session', resume_gateway_url: 'wss://resume.discord.gg' } });
  await h.gateway.dispatches;
  h.sockets[0].receive({ op: 9, d: false });
  assert.equal(h.gateway.session, null);
  assert.equal(h.gateway.sequence, null);
  assert.equal(h.timers.get(h.gateway.reconnectTimer).ms, 2000);
  h.fire(h.gateway.reconnectTimer);
  h.sockets[1].receive({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(h.sockets[1].sent[0].op, 2);
  h.gateway.stop();
});

test('resumable invalid session keeps session, rate limit waits, and fatal intents stop reconnect', async () => {
  const h = harness();
  h.sockets[0].receive({ op: 0, t: 'READY', s: 9, d: { session_id: 'session', resume_gateway_url: 'wss://resume.discord.gg' } });
  await h.gateway.dispatches;
  h.sockets[0].receive({ op: 9, d: true });
  assert.equal(h.gateway.session, 'session');
  h.fire(h.gateway.reconnectTimer);
  h.sockets[1].emit('close', { code: 4008 });
  assert.equal(h.timers.get(h.gateway.reconnectTimer).ms, 60000);
  h.fire(h.gateway.reconnectTimer);
  h.sockets[2].emit('close', { code: 4014 });
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0].message, /4014/);
  assert.equal(h.timers.size, 0);
});

test('server-requested heartbeat and reconnect work, and old socket events do not reconnect twice', async () => {
  const h = harness();
  const ws = h.sockets[0];
  ws.receive({ op: 1 });
  assert.deepEqual(ws.sent.at(-1), { op: 1, d: null });
  ws.receive({ op: 7 });
  assert.equal(h.timers.get(h.gateway.reconnectTimer).ms, 0);
  const timer = h.gateway.reconnectTimer;
  ws.emit('close', { code: 1006 });
  assert.equal(h.gateway.reconnectTimer, timer);
  h.fire(timer);
  assert.equal(h.sockets.length, 2);
  h.gateway.stop();
});

test('resume starts at the last committed event, not an event still being saved', async () => {
  let finish;
  const h = harness({ onDispatch: async type => {
    if (type === 'MESSAGE_CREATE') await new Promise(resolve => { finish = resolve; });
  } });
  const ws = h.sockets[0];
  ws.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', resume_gateway_url: 'wss://resume.discord.gg' } });
  await h.gateway.dispatches;
  ws.receive({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} });
  await Promise.resolve();
  ws.emit('close', { code: 1006 });
  h.fire(h.gateway.reconnectTimer);
  h.sockets[1].receive({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(h.sockets[1].sent[0].d.seq, 1);
  finish();
  await h.gateway.dispatches;
  h.gateway.stop();
});
