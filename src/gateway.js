// -----------------------------------------------------------------------------
// The local HTTP API of the Ruuvi Gateway, read only, and its error kinds,
// after the official documentation of Ruuvi
// (https://docs.ruuvi.com/ruuvi-gateway-firmware/examples/polling-mode and
// .../data-formats/http-get-history-with-timestamps-and-decoding):
//
//   GET /history?decode=false   Authorization: Bearer <read-only API key>
//   -> { data: { coordinates, timestamp, gw_mac,
//                tags: { <MAC>: { rssi, timestamp, data } } } }
//
// `decode=false`: the raw frames only, decoded by this integration
// (src/ruuvitag.js); the decoded fields some firmwares add are never read.
// The key is the "read-only access" bearer key of the Access settings page
// of the gateway; nothing is ever written to the gateway.
// -----------------------------------------------------------------------------

import { MAX_ENTRIES, MAX_FRAME_HEX } from './constants.js';
import { NetworkError, getText } from './http.js';

/**
 * kind: refused (401/403 or a redirection: the key is refused or needed),
 * limited (429), busy (5xx), invalid (not an answer of a Ruuvi Gateway),
 * failed (network, another status).
 */
export class SourceError extends Error {
  constructor(kind, detail = '', { retryAfterMs, status } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'SourceError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** An own field of an object (never a field of its prototype). */
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

const MAC =
  /^([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})$/;

/**
 * A MAC address as the gateway writes it ("C6:A5:B9:E0:AD:06") -> the
 * platform id of its Gladys device, 12 lowercase hex digits
 * ("c6a5b9e0ad06"). Null for another form, and for the broadcast and null
 * addresses (never taken as a tag).
 */
export function macKeyOf(value) {
  const m = typeof value === 'string' ? MAC.exec(value) : null;
  if (!m) {
    return null;
  }
  const key = m.slice(1).join('').toLowerCase();
  return key === 'ffffffffffff' || key === '000000000000' ? null : key;
}

/** "c6a5b9e0ad06" -> "C6:A5:B9:E0:AD:06". */
export const macText = (key) => key.toUpperCase().match(/../g).join(':');

/**
 * A Unix time in seconds, as a string of digits or an integer (the docs show
 * both) -> ms, or null.
 */
export function unixMs(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1e11) {
    return value * 1000;
  }
  if (typeof value === 'string' && /^\d{1,11}$/.test(value)) {
    return Number(value) * 1000;
  }
  return null;
}

const rssiOf = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= -127 && value <= 20
    ? value
    : null;

function statusError({ status, retryAfterMs }) {
  if (status === 429) {
    return new SourceError('limited', 'HTTP 429', { retryAfterMs, status });
  }
  if (status >= 500) {
    return new SourceError('busy', `HTTP ${status}`, { retryAfterMs, status });
  }
  // 401/403: the key is refused, or needed. A redirection: the gateway sends
  // to its sign-in page (a password protected gateway without a key).
  if (status === 401 || status === 403 || (status >= 300 && status <= 399)) {
    return new SourceError('refused', `HTTP ${status}`, { status });
  }
  return new SourceError('failed', `HTTP ${status}`, { status });
}

/**
 * Read the last frame of every tag the gateway heard: { gwMac, gwTime,
 * tags: Map(key -> { rssi, ts, data }) }. `gwTime` (the instant the gateway
 * wrote the answer) and `ts` (the instant it heard the frame) are in ms on
 * the clock of the gateway, null when missing or unreadable. `data` is the
 * relayed advertisement (hex, bounded), decoded by src/ruuvitag.js.
 */
export async function readHistory({ base, token }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let response;
  try {
    response = await getText(`${base}/history?decode=false`, { headers });
  } catch (err) {
    throw new SourceError('failed', err instanceof NetworkError ? err.message : 'network failed');
  }
  if (response.status < 200 || response.status > 299) {
    throw statusError(response);
  }
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    throw new SourceError('invalid', 'not JSON');
  }
  const data = own(body, 'data');
  const tags = own(data, 'tags');
  if (!isObject(tags)) {
    throw new SourceError('invalid', 'no tags');
  }
  const gwMac = macKeyOf(own(data, 'gw_mac'));
  const result = new Map();
  for (const name of Object.keys(tags).slice(0, MAX_ENTRIES)) {
    const key = macKeyOf(name);
    const entry = tags[name];
    const frame = own(entry, 'data');
    // The same tag written twice (C6:A5... and c6-a5...) is ambiguous: the
    // first one is kept.
    if (!key || result.has(key) || typeof frame !== 'string' || frame.length > MAX_FRAME_HEX) {
      continue;
    }
    result.set(key, {
      rssi: rssiOf(own(entry, 'rssi')),
      ts: unixMs(own(entry, 'timestamp')),
      data: frame,
    });
  }
  return { gwMac, gwTime: unixMs(own(data, 'timestamp')), tags: result };
}
