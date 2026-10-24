// -----------------------------------------------------------------------------
// Fakes for the tests: fetch (routes requests to handlers, records every call,
// fails loudly on an unexpected URL), answers of a Ruuvi Gateway (after the
// examples of the official docs) and timers (nothing fires by itself). No
// test touches the network nor the disk.
// -----------------------------------------------------------------------------

import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const HOST = '192.168.1.50';
export const TOKEN = 'Uj+4tj24unVekco/lTLTRyxUfv1J8M6U+sbNsKTWRr0=';
export const GW_MAC = 'F4:D9:16:FE:4F:AD';

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The MAC of a tag -> its 12 hex digits (the platform id). */
export const keyOf = (mac) => mac.replaceAll(':', '').toLowerCase();

const hex4 = (v) => (v & 0xffff).toString(16).padStart(4, '0');
const hex2 = (v) => (v & 0xff).toString(16).padStart(2, '0');

/**
 * A RAWv2 advertisement (flags, then the Ruuvi manufacturer data), as the
 * gateway relays it: `0201061BFF9904` + the 24-byte payload.
 */
export function rawV2({
  mac,
  temperature = 21.5,
  humidity = 45.5,
  pressure = 101325,
  voltage = 2.977,
  tx = 4,
  movement = 10,
  sequence = 100,
}) {
  const t = temperature === null ? 0x8000 : Math.round(temperature / 0.005);
  const h = humidity === null ? 0xffff : Math.round(humidity / 0.0025);
  const p = pressure === null ? 0xffff : pressure - 50_000;
  const b = voltage === null ? 2047 : Math.round(voltage * 1000) - 1600;
  const power = (b << 5) | ((tx + 40) / 2);
  const payload =
    '05' +
    hex4(t) +
    hex4(h) +
    hex4(p) +
    hex4(4) +
    hex4(-4) +
    hex4(1036) +
    hex4(power) +
    hex2(movement === null ? 0xff : movement) +
    hex4(sequence === null ? 0xffff : sequence) +
    keyOf(mac);
  return `0201061BFF9904${payload}`.toUpperCase();
}

export const SALON = 'C6:A5:B9:E0:AD:06';
export const CAVE = 'E3:75:CF:37:4E:23';
export const SALON_ID = `ext:ruuvi-gateway:tag:${keyOf(SALON)}`;
export const CAVE_ID = `ext:ruuvi-gateway:tag:${keyOf(CAVE)}`;

/**
 * GET /history?decode=false: the answer of the gateway at `ms` (its clock),
 * each tag heard `heardAgo` ms before, with the given frame options.
 */
export function history(ms, { tags = {}, heardAgo = 2_000, extra = {} } = {}) {
  const seconds = (t) => String(Math.floor(t / 1000));
  const all = {
    [SALON]: { sequence: 100, ...tags[SALON] },
    [CAVE]: { sequence: 500, temperature: 12.25, humidity: 81, ...tags[CAVE] },
  };
  const entries = {};
  for (const [mac, options] of Object.entries(all)) {
    if (options.absent) {
      continue;
    }
    entries[mac] = {
      rssi: options.rssi ?? -60,
      timestamp: seconds(options.heardAt ?? ms - heardAgo),
      data: options.data ?? rawV2({ mac, ...options }),
    };
  }
  return {
    data: {
      coordinates: '',
      timestamp: seconds(ms),
      gw_mac: GW_MAC,
      tags: { ...entries, ...extra },
    },
  };
}

/** Install a fake fetch; `routes` is a list of [RegExp, handler(call)]. */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const call = { url, init };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${url}`);
    }
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = nextId++;
    pending.set(id, { id, kind, fn, ms });
    return id;
  };
  return {
    pending,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    async runIntervals() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'interval')) {
        await t.fn();
      }
    },
    async runTimeouts() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'timeout')) {
        pending.delete(t.id);
        await t.fn();
      }
    },
  };
}

/** A logger that keeps every line, to check that no secret reaches it. */
export function recordingLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => String(a?.message ?? a)).join(' ')}`);
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}
