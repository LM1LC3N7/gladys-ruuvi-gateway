// -----------------------------------------------------------------------------
// The RuuviTag frames, decoded after the data formats published by Ruuvi
// (https://docs.ruuvi.com/communication/bluetooth-advertisements). Pure: no
// clock, no network, no Bluetooth (the Ruuvi Gateway listens to the tags and
// relays each Bluetooth advertisement as a hex string).
//
// The relayed string is a whole advertisement: a list of AD structures
// (length, type, data). The Ruuvi data is the "manufacturer specific data"
// (type 0xFF) of the manufacturer 0x0499, sent least significant byte first
// (99 04). Its first byte is the data format:
//
//   0x05 RAWv2 (RuuviTag, in production): 24 bytes
//   0xC5 Cut-RAWv2 (RuuviTag, beta): RAWv2 without the acceleration, 18 bytes
//   0x03 RAWv1 (RuuviTag, deprecated): 14 bytes, no sequence number, 0 for
//        "not available" (see decodeRawV1)
//
// Any other format (6 and E1 of Ruuvi Air, 8 encrypted, 4 URL...) is told
// apart and left out. Every field is checked: the "not available" values of
// the formats (0x8000 signed, 0xFFFF / 0xFF unsigned, 2047 and 31 in the
// power field, a MAC of all ones) give null, never a number.
// -----------------------------------------------------------------------------

import { MAX_FRAME_HEX } from './constants.js';

/** The Bluetooth SIG company id of Ruuvi Innovations, as it travels (LSB first). */
const RUUVI_ID = [0x99, 0x04];

/** A hex string -> bytes, or null (odd length, a non-hex character, too long). */
export function hexToBytes(hex) {
  if (
    typeof hex !== 'string' ||
    hex.length === 0 ||
    hex.length > MAX_FRAME_HEX ||
    hex.length % 2 !== 0 ||
    !/^[0-9A-Fa-f]+$/.test(hex)
  ) {
    return null;
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/**
 * The Ruuvi manufacturer data of an advertisement (without the company id):
 * `{ payload }`, `{ truncated: true }` when an AD structure runs past the end
 * of the frame (a cut frame, never read past its end), or null when there is
 * no Ruuvi data (a length of 0 ends the significant part, as in Bluetooth).
 */
export function ruuviPayload(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const length = bytes[i];
    if (length === 0) {
      return null;
    }
    if (i + 1 + length > bytes.length) {
      return { truncated: true };
    }
    const type = bytes[i + 1];
    if (
      type === 0xff &&
      length >= 4 &&
      bytes[i + 2] === RUUVI_ID[0] &&
      bytes[i + 3] === RUUVI_ID[1]
    ) {
      return { payload: bytes.subarray(i + 4, i + 1 + length) };
    }
    i += 1 + length;
  }
  return null;
}

const u8 = (b, at) => b[at];
const u16 = (b, at) => (b[at] << 8) | b[at + 1];
const i16 = (b, at) => {
  const v = u16(b, at);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A signed 16-bit field, 0x8000 = not available. */
const signed = (b, at, scale) => {
  const v = i16(b, at);
  return v === -0x8000 ? null : v * scale;
};
/** An unsigned 16-bit field, 0xFFFF = not available. */
const unsigned = (b, at) => {
  const v = u16(b, at);
  return v === 0xffff ? null : v;
};

/** Six bytes as "aabbccddeeff", or null when all ones (not available) or all zeros. */
const macOf = (b, at) => {
  const part = b.subarray(at, at + 6);
  if (part.every((x) => x === 0xff) || part.every((x) => x === 0)) {
    return null;
  }
  return Buffer.from(part).toString('hex');
};

/** The power field of RAWv2 and Cut-RAWv2: 11 bits of battery, 5 bits of TX power. */
function power(b, at) {
  const v = u16(b, at);
  const battery = v >>> 5;
  const tx = v & 0x1f;
  return {
    voltage: battery === 2047 ? null : round((1600 + battery) / 1000, 3),
    txPower: tx === 31 ? null : -40 + tx * 2,
  };
}

function decodeRawV2(p) {
  const humidity = unsigned(p, 3);
  const pressure = unsigned(p, 5);
  const movement = u8(p, 15);
  const sequence = unsigned(p, 16);
  const temperature = signed(p, 1, 0.005);
  return {
    format: 5,
    temperature: temperature === null ? null : round(temperature, 3),
    humidity: humidity === null ? null : round(humidity * 0.0025, 4),
    pressure: pressure === null ? null : pressure + 50_000,
    accelerationX: signed(p, 7, 0.001),
    accelerationY: signed(p, 9, 0.001),
    accelerationZ: signed(p, 11, 0.001),
    ...power(p, 13),
    movement: movement === 0xff ? null : movement,
    sequence,
    mac: macOf(p, 18),
  };
}

function decodeCutRawV2(p) {
  const humidity = unsigned(p, 3);
  const pressure = unsigned(p, 5);
  const movement = u8(p, 9);
  const temperature = signed(p, 1, 0.005);
  return {
    format: 0xc5,
    temperature: temperature === null ? null : round(temperature, 3),
    humidity: humidity === null ? null : round(humidity * 0.0025, 4),
    pressure: pressure === null ? null : pressure + 50_000,
    ...power(p, 7),
    movement: movement === 0xff ? null : movement,
    sequence: unsigned(p, 10),
    mac: macOf(p, 12),
  };
}

/**
 * RAWv1: the temperature is a sign bit, 7 bits of whole degrees and a byte
 * of hundredths (0 to 99). The format page gives no specific "not
 * available" value and suggests sending 0: a humidity of 0, a raw pressure
 * of 0 (50 000 Pa) and a voltage of 0 are taken as not available; a
 * temperature of 0 °C is plausible and kept, unless the raw humidity and
 * the raw pressure are both 0 too (no environment sensor). A fraction above 99 is refused too.
 */
function decodeRawV1(p) {
  const fraction = u8(p, 3);
  const whole = u8(p, 2) & 0x7f;
  const negative = (u8(p, 2) & 0x80) !== 0;
  const humidity = u8(p, 1);
  const pressure = u16(p, 4);
  const noSensor = humidity === 0 && pressure === 0;
  const temperature =
    fraction > 99 || noSensor ? null : (negative ? -1 : 1) * (whole + fraction / 100);
  const voltage = u16(p, 12);
  return {
    format: 3,
    temperature: temperature === null ? null : round(temperature, 2),
    humidity: humidity === 0 ? null : humidity * 0.5,
    pressure: pressure === 0 ? null : pressure + 50_000,
    accelerationX: i16(p, 6) / 1000,
    accelerationY: i16(p, 8) / 1000,
    accelerationZ: i16(p, 10) / 1000,
    voltage: voltage === 0 ? null : voltage / 1000,
    txPower: null,
    movement: null,
    sequence: null,
    mac: null,
  };
}

/** [format byte, exact payload length, decoder]. */
const FORMATS = [
  [0x05, 24, decodeRawV2],
  [0xc5, 18, decodeCutRawV2],
  [0x03, 14, decodeRawV1],
];

/**
 * A relayed advertisement (hex) -> { ok: true, measure } or { ok: false,
 * why }: `why` is `frame` (not a valid hex frame, or an AD structure cut
 * short), `other` (no Ruuvi data), `short` / `long` (a Ruuvi payload not of
 * the exact length of its format) or `format:<n>` (a format this
 * integration does not decode, such as 6, 225 = E1 or 8).
 */
export function decodeFrame(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes) {
    return { ok: false, why: 'frame' };
  }
  const found = ruuviPayload(bytes);
  if (found?.truncated) {
    return { ok: false, why: 'frame' };
  }
  const payload = found?.payload;
  if (!payload || payload.length === 0) {
    return { ok: false, why: 'other' };
  }
  const format = FORMATS.find(([id]) => id === payload[0]);
  if (!format) {
    return { ok: false, why: `format:${payload[0]}` };
  }
  if (payload.length !== format[1]) {
    return { ok: false, why: payload.length < format[1] ? 'short' : 'long' };
  }
  return { ok: true, measure: format[2](payload) };
}

/** Decode a bare Ruuvi payload (the format byte first): the test vectors of the docs. */
export function decodePayload(hex) {
  const bytes = hexToBytes(hex);
  const format = bytes && FORMATS.find(([id]) => id === bytes[0]);
  return format && bytes.length === format[1] ? format[2](bytes) : null;
}
