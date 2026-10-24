// -----------------------------------------------------------------------------
// The pace against clocks that behave like real ones: timers that fire in
// the order of their deadlines (a deferred write of /data and the next tick
// due at the same millisecond, the write first), a clock that moves at every
// call, and a real clock against a real local HTTP server.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RuuviGatewayApp } from '../src/app.js';
import { setFetch } from '../src/http.js';
import { memoryStorage } from '../src/store.js';
import { HOST, TOKEN, history, installFetch, json, recordingLogger } from './helpers/fakes.js';

let fake;
afterEach(() => fake?.restore());

/**
 * Timers on a virtual clock, fired in the order of their deadlines; at the
 * same deadline, a timeout fires before an interval (the order that hid a
 * read every other minute). The clock moves 1 ms at every reading too.
 */
function orderedTimers(start) {
  let clock = start;
  let seq = 0;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = ++seq;
    pending.set(id, { id, kind, fn, ms, at: clock + Math.max(0, ms) });
    return id;
  };
  return {
    now: () => (clock += 1),
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    async runUntil(end) {
      for (;;) {
        const next = [...pending.values()].sort(
          (a, b) =>
            a.at - b.at || (a.kind === b.kind ? a.id - b.id : a.kind === 'timeout' ? -1 : 1),
        )[0];
        if (!next || next.at > end) {
          clock = Math.max(clock, end);
          return;
        }
        clock = Math.max(clock, next.at);
        if (next.kind === 'interval') {
          next.at += next.ms;
        } else {
          pending.delete(next.id);
        }
        await next.fn();
        // Let what the timer started run before time moves on, as it would.
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('a read every minute at 1 minute, never every other one (deferred writes in the way)', async () => {
  const start = Date.parse('2026-10-20T18:00:00Z');
  const timers = orderedTimers(start);
  const reads = [];
  let step = 0;
  fake = installFetch([
    [
      /\/history/,
      () => {
        reads.push(timers.now());
        step += 1;
        return json(history(timers.now(), { tags: { 'C6:A5:B9:E0:AD:06': { sequence: step } } }));
      },
    ],
  ]);
  const config = { host: HOST, token: TOKEN, poll_interval: 1 };
  const gladys = createFakeGladys({ selector: 'ruuvi-gateway', config });
  await gladys.connect();
  const app = new RuuviGatewayApp({
    gladys,
    logger: recordingLogger(),
    now: timers.now,
    timers,
    storage: memoryStorage(),
  });
  await app.start(config);
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
  await timers.runUntil(start + 4 * 60_000 + 20_000);
  app.shutdown();
  assert.equal(reads.length, 5, `reads at ${reads.map((t) => Math.round((t - start) / 1000))} s`);
  const gaps = reads.slice(1).map((t, i) => t - reads[i]);
  assert.ok(
    gaps.every((g) => g >= 60_000 && g < 76_000),
    `gaps ${gaps}`,
  );
});

test('with a real clock and real timers, a read leaves for a real local gateway', async () => {
  let hits = 0;
  let auth;
  const server = createServer((req, res) => {
    hits += 1;
    auth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(history(Date.now())));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const previous = setFetch((...args) => globalThis.fetch(...args));
  const config = { host: `127.0.0.1:${port}`, token: TOKEN, poll_interval: 1 };
  const gladys = createFakeGladys({ selector: 'ruuvi-gateway', config });
  await gladys.connect();
  const app = new RuuviGatewayApp({ gladys, logger: recordingLogger(), storage: memoryStorage() });
  try {
    await app.start(config);
    assert.equal(hits, 1, 'one read at the start');
    assert.equal(auth, `Bearer ${TOKEN}`);
    assert.equal(gladys.fake.discoveredDevices.length, 2);
    assert.equal(gladys.fake.connectionStatus.connected, true);
  } finally {
    app.shutdown();
    setFetch(previous);
    await new Promise((resolve) => server.close(resolve));
  }
});
