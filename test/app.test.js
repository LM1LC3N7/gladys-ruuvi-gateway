// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Ruuvi Gateway: the
// devices and states, the pace (never faster than the interval: test button,
// reconnection, saved configuration, restart), the state file (written at
// most once per minute, never the key), the refused key (final), pauses,
// late answers, silent tags never shown alive, motion, the state budget.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RuuviGatewayApp } from '../src/app.js';
import { TICK } from '../src/constants.js';
import { GatewayStore, memoryStorage } from '../src/store.js';
import {
  CAVE,
  CAVE_ID,
  HOST,
  SALON,
  SALON_ID,
  TOKEN,
  createFakeTimers,
  history,
  installFetch,
  json,
  rawV2,
  recordingLogger,
} from './helpers/fakes.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const CONFIG = { host: HOST, token: TOKEN, poll_interval: 2 };

let fake;
afterEach(() => fake?.restore());

/** A storage that records the instant of each write. */
function timedStorage(clock, initial) {
  const inner = memoryStorage(initial);
  const times = [];
  return {
    times,
    load: () => inner.load(),
    save(value) {
      times.push(clock.now);
      inner.save(value);
    },
  };
}

/**
 * The gateway answers with `frames.tags` (options per tag MAC); the
 * sequence numbers move by one at each read unless `frames.frozen`.
 */
async function setup({ config = CONFIG, storage, clock = { now: NOW }, devices, answer } = {}) {
  const frames = { tags: {}, step: 0, frozen: false };
  const state = {
    answer:
      answer ??
      (() => {
        const step = frames.frozen ? frames.step : frames.step++;
        const tags = {};
        for (const [mac, base] of [
          [SALON, 100],
          [CAVE, 500],
        ]) {
          tags[mac] = { sequence: base + step, ...frames.tags[mac] };
        }
        return json(history(clock.now, { tags }));
      }),
  };
  fake = installFetch([[/\/history\?decode=false$/, (c) => state.answer(c)]]);
  const gladys = createFakeGladys({ selector: 'ruuvi-gateway', config, devices });
  const timers = createFakeTimers();
  const logger = recordingLogger();
  const app = new RuuviGatewayApp({
    gladys,
    logger,
    now: () => clock.now,
    timers,
    storage: storage ?? timedStorage(clock),
  });
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  return { app, gladys, timers, clock, state, frames, logger };
}

const reads = () => fake.calls.length;

/** Advance the clock tick by tick for `ms`, running the periodic checks. */
async function advance(ctx, ms) {
  for (let t = 0; t < ms; t += TICK) {
    ctx.clock.now += TICK;
    await ctx.timers.runIntervals();
  }
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

/** Spy on publishChangedStates: every batch handed to the SDK. */
function spyStates(gladys) {
  const batches = [];
  const original = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = (states, options) => {
    batches.push(states);
    return original(states, options);
  };
  return batches;
}

test('the devices of the tags, their values in core units, the status; the key nowhere', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  await ctx.app.start(CONFIG);
  const { gladys } = ctx;
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [SALON_ID, CAVE_ID].sort());
  const salon = gladys.fake.discoveredDevices.find((d) => d.external_id === SALON_ID);
  assert.equal(salon.name, 'Ruuvi AD06');
  assert.deepEqual(
    salon.features.map((f) => f.external_id.split(':').pop()),
    ['temperature', 'humidity', 'pressure', 'motion', 'battery_voltage', 'signal'],
  );
  assert.ok(salon.features.every((f) => f.read_only === true));
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${SALON_ID}:temperature`), 21.5);
  assert.equal(gladys.fake.lastState(`${SALON_ID}:humidity`), 45.5);
  assert.equal(gladys.fake.lastState(`${SALON_ID}:pressure`), 1013.3);
  assert.equal(gladys.fake.lastState(`${SALON_ID}:battery_voltage`), 2.977);
  assert.equal(gladys.fake.lastState(`${SALON_ID}:signal`), -60);
  assert.equal(gladys.fake.lastState(`${CAVE_ID}:temperature`), 12.25);
  assert.equal(
    gladys.fake.lastState(`${SALON_ID}:motion`),
    undefined,
    'no motion from a first measurement',
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /2 RuuviTag\(s\) through the Ruuvi Gateway, read every 2 min/,
  );
  assert.equal(reads(), 1);
  const everything = JSON.stringify([
    ctx.logger.lines,
    gladys.fake.connectionStatuses,
    gladys.fake.discoveredDevices,
    storage.load(),
    fake.calls.map((c) => c.url),
  ]);
  assert.ok(!everything.includes(TOKEN), 'the key is never logged, shown nor written');
  assert.ok(!everything.includes(TOKEN.slice(0, 12)));
});

test('the test button never reads closer than the interval to the last read', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  let answer;
  for (let i = 0; i < 5; i += 1) {
    ctx.clock.now += 10_000;
    answer = await ctx.app.testConnection();
  }
  assert.equal(reads(), 1);
  assert.match(
    answer.en,
    /Ruuvi Gateway F4:D9:16:FE:4F:AD: 2 tag\(s\), next read possible at 18:02 UTC/,
  );
  assert.match(
    answer.en,
    /Ruuvi AD06: temperature 21.5 °C, humidity 45.5 %, pressure 1013.3 hPa, battery 2.977 V/,
  );
  assert.match(answer.fr, /Ruuvi AD06 : température 21,5 °C, humidité 45,5 %/);
  assert.match(answer.fr, /prochaine lecture possible à 18:02 UTC/);
  ctx.clock.now += 2 * 60_000;
  await ctx.app.testConnection();
  assert.equal(reads(), 2, 'once the interval has passed');
});

test('the periodic reads follow the interval', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  await advance(ctx, 60 * 60_000);
  assert.equal(reads(), 31, 'every 2 minutes: 1 + 30 in an hour');
});

test('a reconnection, a saved configuration or Discovery never reads sooner', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  for (const minutes of [2, 1, 5, 10]) {
    ctx.clock.now += 5_000;
    await ctx.app.start({ ...CONFIG, poll_interval: minutes });
    await ctx.gladys.fake.scanRequest();
  }
  assert.equal(reads(), 1);
  assert.ok(ctx.gladys.fake.connectionStatuses.length >= 5);
});

test('a restart 30 s after a read: no call, the Discovery kept, nothing sent again', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const first = await setup({ storage, clock });
  await first.app.start(CONFIG);
  await createAll(first.gladys);
  first.app.shutdown();
  const devices = first.gladys.fake.discoveredDevices;
  fake.restore();
  clock.now += 30_000;
  const second = await setup({ storage, clock, devices });
  const batches = spyStates(second.gladys);
  await second.app.start(CONFIG);
  assert.equal(reads(), 0, 'no call before the interval');
  assert.deepEqual(
    second.gladys.fake.discoveredDevices.map((d) => d.external_id).sort(),
    [SALON_ID, CAVE_ID].sort(),
  );
  // The read after the interval: the same sequence numbers (nothing new).
  second.frames.frozen = true;
  second.frames.step = 0;
  clock.now += 2 * 60_000;
  await second.timers.runIntervals();
  assert.equal(reads(), 1);
  assert.equal(batches.flat().length, 0, 'a measurement already published is never sent again');
});

test('a tag whose sequence stops is never shown alive, even heard by the gateway', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  const batches = spyStates(ctx.gladys);
  // The sensor stops measuring: the same frame, heard again and again.
  ctx.frames.step -= 1;
  ctx.frames.frozen = true;
  await advance(ctx, 30 * 60_000);
  const sent = batches.flat().map((s) => s.device_feature_external_id);
  assert.equal(sent.length, 0, 'the same measurement is never handed over again');
  await advance(ctx, 32 * 60_000);
  assert.equal(batches.flat().length, 0);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /Without value: Ruuvi AD06 \(no recent measurement\), Ruuvi 4E23 \(no recent measurement\)/,
  );
  const answer = await ctx.app.testConnection();
  assert.match(answer.en, /Ruuvi AD06: no recent measurement/);
  // It measures again: published at once as current.
  ctx.frames.frozen = false;
  ctx.frames.step += 1;
  await advance(ctx, 2 * 60_000);
  const after = batches.flat();
  assert.ok(after.some((s) => s.device_feature_external_id === `${SALON_ID}:temperature`));
  assert.ok(after.every((s) => s.created_at === undefined));
});

test('a tag the gateway heard long ago: never published; half an hour ago: dated', async () => {
  const ctx = await setup({
    answer: () =>
      json(
        history(ctx.clock.now, {
          tags: {
            [SALON]: { sequence: 1, heardAt: ctx.clock.now - 2 * 60 * 60_000 },
            [CAVE]: { sequence: 2, heardAt: ctx.clock.now - 30 * 60_000 },
          },
        }),
      ),
  });
  await ctx.app.start(CONFIG);
  const batches = spyStates(ctx.gladys);
  await createAll(ctx.gladys);
  const sent = batches.flat();
  assert.ok(!sent.some((s) => s.device_feature_external_id.startsWith(SALON_ID)));
  const cave = sent.filter((s) => s.device_feature_external_id.startsWith(CAVE_ID));
  assert.ok(cave.length > 0);
  assert.ok(cave.every((s) => s.created_at === new Date(NOW - 30 * 60_000).toISOString()));
});

test('the age is counted on the clock of the gateway, not on the clock of Gladys', async () => {
  const offset = 3 * 60 * 60_000;
  const ctx = await setup({
    answer: () => json(history(ctx.clock.now - offset, { tags: { [SALON]: { sequence: 7 } } })),
  });
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState(`${SALON_ID}:temperature`), 21.5);
  // A frame ahead of the gateway clock by more than 5 minutes is ignored.
  ctx.state.answer = () =>
    json(history(NOW, { tags: { [SALON]: { sequence: 8, heardAt: NOW + 10 * 60_000 } } }));
  ctx.clock.now += 2 * 60_000;
  await ctx.timers.runIntervals();
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /not decoded/);
});

test('motion: the movement counter moved since the previous measurement', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  const motion = () => ctx.gladys.fake.lastState(`${SALON_ID}:motion`);
  assert.equal(motion(), undefined);
  ctx.clock.now += 2 * 60_000;
  await ctx.timers.runIntervals();
  assert.equal(motion(), 0, 'the same counter: no motion');
  ctx.frames.tags[SALON] = { movement: 11 };
  ctx.clock.now += 2 * 60_000;
  await ctx.timers.runIntervals();
  assert.equal(motion(), 1);
  ctx.clock.now += 2 * 60_000;
  await ctx.timers.runIntervals();
  assert.equal(motion(), 0);
  // The counter rolls over (254 -> 0): still a motion.
  ctx.frames.tags[SALON] = { movement: 254 };
  ctx.clock.now += 2 * 60_000;
  await ctx.timers.runIntervals();
  ctx.frames.tags[SALON] = { movement: 0 };
  ctx.clock.now += 2 * 60_000;
  await ctx.timers.runIntervals();
  assert.equal(motion(), 1);
});

test('invalid values (0x8000, 0xFFFF) are unknown, never published as numbers', async () => {
  const ctx = await setup();
  ctx.frames.tags[SALON] = { temperature: null, humidity: null, pressure: null, voltage: null };
  await ctx.app.start(CONFIG);
  const salon = ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === SALON_ID);
  assert.deepEqual(
    salon.features.map((f) => f.external_id.split(':').pop()),
    ['motion', 'signal'],
  );
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState(`${SALON_ID}:temperature`), undefined);
});

test('the frames not decoded are counted in the status; a MAC that does not match is left out', async () => {
  const ctx = await setup({
    answer: () =>
      json(
        history(ctx.clock.now, {
          tags: {
            [SALON]: { data: '0201061BFF990406170C5668C79E007000C90501D9FFCD004C884F00000000' },
            [CAVE]: { data: rawV2({ mac: 'AA:BB:CC:DD:EE:FF' }) },
          },
          extra: {
            'AA:BB:CC:00:00:01': { rssi: -50, timestamp: '1', data: '0201061AFF4C000215' },
          },
        }),
      ),
  });
  await ctx.app.start(CONFIG);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.match(
    ctx.gladys.fake.connectionStatus.message.en,
    /2 Ruuvi frame\(s\) not decoded: data format \(Ruuvi Air \(6\)\)/,
  );
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /2 trame\(s\) Ruuvi non décodée\(s\)/);
});

test('a refused key is final: no periodic read, also after a restart', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock, answer: () => json({}, 401) });
  await ctx.app.start(CONFIG);
  assert.equal(reads(), 1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the API key/);
  await advance(ctx, 3 * 60 * 60_000);
  assert.equal(reads(), 1, 'never tried again on its own');
  // A restart: still refused, without a request.
  ctx.app.shutdown();
  fake.restore();
  const again = await setup({ storage, clock, answer: () => json({}, 401) });
  await again.app.start(CONFIG);
  await advance(again, 60 * 60_000);
  assert.equal(reads(), 0);
  assert.match(again.gladys.fake.connectionStatus.message.en, /access refused/);
  // Saving the same configuration lifts nothing.
  await again.app.start(CONFIG);
  assert.equal(reads(), 0);
  // The test button tries once; still refused, the stop stays.
  await again.app.testConnection();
  assert.equal(reads(), 1);
  await advance(again, 60 * 60_000);
  assert.equal(reads(), 1);
  // Another key is tried at once; it works: the stop is lifted.
  again.state.answer = () => json(history(clock.now));
  await again.app.start({ ...CONFIG, token: 'another-read-only-key' });
  assert.equal(reads(), 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(storage.load().gateway.refused, false);
  assert.equal(storage.load().gateway.fp, '');
});

test('a key changed while the container was stopped is tried at once after a restart', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock, answer: () => json({}, 403) });
  await ctx.app.start(CONFIG);
  ctx.app.shutdown();
  fake.restore();
  clock.now += 60_000;
  // 1 marker in 256 matches by chance: this key is checked not to.
  const store = new GatewayStore({ storage, now: () => clock.now, maxPause: 1 });
  const other = 'yet-another-key-0';
  assert.notEqual(store.fingerprint(`http://${HOST}\n${other}`), store.get().fp);
  const again = await setup({ storage, clock, answer: () => json(history(clock.now)) });
  await again.app.start({ ...CONFIG, token: other });
  assert.equal(reads(), 1);
});

test('no key and the gateway asks for one: the status says how to set it', async () => {
  const ctx = await setup({
    config: { host: HOST },
    answer: () => new Response(null, { status: 302, headers: { location: '/auth.html' } }),
  });
  await ctx.app.start({ host: HOST });
  assert.equal(fake.calls[0].init.headers.Authorization, undefined);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /The gateway asks for a key/);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /La passerelle demande une clé/);
});

test('the marker of a refused key cannot find a short key back', () => {
  const store = new GatewayStore({ storage: memoryStorage(), maxPause: 1 });
  // 8 bits: 300 four-digit keys fall into at most 256 markers, so many keys
  // share each marker and none can be singled out by trying them all.
  const markers = new Set();
  for (let i = 0; i < 300; i += 1) {
    const marker = store.fingerprint(`http://${HOST}\n${String(i).padStart(4, '0')}`);
    assert.match(marker, /^[0-9a-f]{2}$/);
    markers.add(marker);
  }
  assert.ok(markers.size <= 256 && markers.size < 300);
});

test('a 503 pauses the reads (Retry-After), also across a restart', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({
    storage,
    clock,
    answer: () => json({}, 503, { 'retry-after': '1800' }),
  });
  await ctx.app.start(CONFIG);
  assert.equal(reads(), 1);
  await advance(ctx, 20 * 60_000);
  assert.equal(reads(), 1, 'paused 30 minutes');
  ctx.app.shutdown();
  fake.restore();
  const again = await setup({ storage, clock, answer: () => json(history(clock.now)) });
  await again.app.start(CONFIG);
  assert.equal(reads(), 0);
  await advance(again, 11 * 60_000);
  assert.equal(reads(), 1);
});

test('a network failure is retried at the interval, never sooner', async () => {
  const ctx = await setup({
    answer: () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
    },
  });
  await ctx.app.start(CONFIG);
  await advance(ctx, 10 * 60_000);
  assert.equal(reads(), 6);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Ruuvi Gateway \(no answer\)/);
  assert.ok(ctx.logger.lines.some((l) => /EHOSTUNREACH/.test(l)));
});

test('a late answer of an old configuration publishes nothing and sets no status', async () => {
  let release;
  const ctx = await setup({
    answer: () =>
      new Promise((resolve) => {
        release = () => resolve(json(history(NOW)));
      }),
  });
  const starting = ctx.app.start(CONFIG);
  await new Promise((r) => setImmediate(r));
  ctx.app.stop();
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  release();
  await starting;
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.equal(ctx.gladys.fake.connectionStatuses.length, statuses);
});

test('the state file: written before the request, at most once per minute, at a clean stop', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock, config: { ...CONFIG, poll_interval: 1 } });
  await ctx.app.start({ ...CONFIG, poll_interval: 1 });
  await advance(ctx, 10 * 60_000);
  await ctx.timers.runTimeouts();
  // The first read writes twice: its instant before the request, then the
  // new tags at once (a new tag is never left for later); after that, at
  // most once per minute.
  assert.deepEqual(storage.times.slice(0, 2), [NOW, NOW]);
  const later = storage.times.slice(1);
  const gaps = later.slice(1).map((t, i) => t - later[i]);
  assert.ok(gaps.length >= 8 && gaps.every((g) => g >= 60_000), `gaps ${gaps}`);
  const saved = storage.load();
  assert.ok(saved.gateway.lastAttemptAt <= clock.now);
  assert.deepEqual(saved.gateway.tags.map((t) => t.key).sort(), ['c6a5b9e0ad06', 'e375cf374e23']);
  ctx.clock.now += 1_000;
  ctx.app.shutdown();
  assert.equal(storage.times.at(-1), ctx.clock.now, 'written at the clean stop');
});

test('many tags: never more than 250 states a minute, the rest follows', async () => {
  const macs = Array.from(
    { length: 50 },
    (_, i) => `D0:00:00:00:00:${i.toString(16).padStart(2, '0').toUpperCase()}`,
  );
  const ctx = await setup({
    answer: () => {
      const extra = {};
      for (const [i, mac] of macs.entries()) {
        extra[mac] = {
          rssi: -70,
          timestamp: String(Math.floor(ctx.clock.now / 1000) - 1),
          data: rawV2({ mac, sequence: 1000 + i, temperature: 20 + i / 10 }),
        };
      }
      return json({
        data: { timestamp: String(Math.floor(ctx.clock.now / 1000)), gw_mac: '', tags: extra },
      });
    },
  });
  await ctx.app.start(CONFIG);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 50);
  const batches = spyStates(ctx.gladys);
  await createAll(ctx.gladys);
  // 50 tags x 5 features (no motion yet) = 250, then the device creations
  // each publish again: what is over the budget waits.
  const count = () => batches.flat().length;
  assert.ok(count() <= 250, `${count()} states in the first minute`);
  ctx.clock.now += 61_000;
  await ctx.timers.runTimeouts();
  assert.ok(count() >= 250);
});

test('a tag neither heard for a week nor created leaves the Discovery list', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  await ctx.gladys.fake.deviceCreated(
    ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === CAVE_ID),
  );
  ctx.frames.tags[SALON] = { absent: true };
  ctx.frames.tags[CAVE] = { absent: true };
  ctx.clock.now += 8 * 24 * 60 * 60_000;
  await ctx.timers.runIntervals();
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [CAVE_ID],
    'the created one stays',
  );
});

test('not configured, invalid address, invalid key: said at once, nothing sent', async () => {
  for (const [config, pattern] of [
    [{}, /Enter the address of your Ruuvi Gateway/],
    [{ host: 'http://192.168.1.50/history' }, /Address of the gateway not valid/],
    [{ host: HOST, token: 'abc def' }, /API key not valid \(7 characters\)/],
  ]) {
    const ctx = await setup({ config });
    await ctx.app.start(config);
    assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
    assert.match(ctx.gladys.fake.connectionStatus.message.en, pattern);
    assert.match(String((await ctx.app.testConnection()).en), pattern);
    assert.ok(!JSON.stringify(ctx.gladys.fake.connectionStatuses).includes('abc def'));
    assert.equal(reads(), 0);
    fake.restore();
  }
});
