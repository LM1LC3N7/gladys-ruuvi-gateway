// -----------------------------------------------------------------------------
// The decoder against the test vectors published by Ruuvi in its data format
// pages (https://docs.ruuvi.com/communication/bluetooth-advertisements, data
// formats 5, C5 and 3, themselves based on the tests of ttu/ruuvitag-sensor),
// and against the advertisements of the gateway examples of the docs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, decodePayload, hexToBytes, ruuviPayload } from '../src/ruuvitag.js';

const close = (actual, expected, digits = 3, label = '') =>
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 10 ** -digits,
    `${label}: ${actual} != ${expected}`,
  );

test('data format 5 (RAWv2): the valid data vector of the docs', () => {
  const m = decodePayload('0512FC5394C37C0004FFFC040CAC364200CDCBB8334C884F');
  assert.equal(m.format, 5);
  close(m.temperature, 24.3, 3, 'temperature');
  assert.equal(m.pressure, 100044);
  close(m.humidity, 53.49, 4, 'humidity');
  close(m.accelerationX, 0.004, 6, 'x');
  close(m.accelerationY, -0.004, 6, 'y');
  close(m.accelerationZ, 1.036, 6, 'z');
  assert.equal(m.txPower, 4);
  assert.equal(m.voltage, 2.977);
  assert.equal(m.movement, 66);
  assert.equal(m.sequence, 205);
  assert.equal(m.mac, 'cbb8334c884f');
});

test('data format 5: the maximum and minimum vectors of the docs', () => {
  const max = decodePayload('057FFFFFFEFFFE7FFF7FFF7FFFFFDEFEFFFECBB8334C884F');
  close(max.temperature, 163.835, 3, 'temperature');
  assert.equal(max.pressure, 115534);
  close(max.humidity, 163.835, 4, 'humidity');
  close(max.accelerationX, 32.767, 6, 'x');
  assert.equal(max.txPower, 20);
  assert.equal(max.voltage, 3.646);
  assert.equal(max.movement, 254);
  assert.equal(max.sequence, 65534);
  const min = decodePayload('058001000000008001800180010000000000CBB8334C884F');
  close(min.temperature, -163.835, 3, 'temperature');
  assert.equal(min.pressure, 50000);
  assert.equal(min.humidity, 0);
  close(min.accelerationZ, -32.767, 6, 'z');
  assert.equal(min.txPower, -40);
  assert.equal(min.voltage, 1.6);
  assert.equal(min.movement, 0);
  assert.equal(min.sequence, 0);
});

test('data format 5: the invalid values vector gives null everywhere, never a number', () => {
  const m = decodePayload('058000FFFFFFFF800080008000FFFFFFFFFFFFFFFFFFFFFF');
  for (const field of [
    'temperature',
    'humidity',
    'pressure',
    'accelerationX',
    'accelerationY',
    'accelerationZ',
    'voltage',
    'txPower',
    'movement',
    'sequence',
    'mac',
  ]) {
    assert.equal(m[field], null, field);
  }
});

test('data format C5 (Cut-RAWv2): the vectors of the docs, format byte C5', () => {
  // The vectors of the C5 page start with 05 (a copy of the RAWv2 page): the
  // byte of the format is C5 per the table of the same page.
  const m = decodePayload('C512FC5394C37CAC364200CDCBB8334C884F');
  assert.equal(m.format, 0xc5);
  close(m.temperature, 24.3, 3, 'temperature');
  assert.equal(m.pressure, 100044);
  close(m.humidity, 53.49, 4, 'humidity');
  assert.equal(m.txPower, 4);
  assert.equal(m.voltage, 2.977);
  assert.equal(m.movement, 66);
  assert.equal(m.sequence, 205);
  assert.equal(m.mac, 'cbb8334c884f');
  const max = decodePayload('C57FFFFFFEFFFEFFDEFEFFFECBB8334C884F');
  assert.equal(max.voltage, 3.646);
  assert.equal(max.txPower, 20);
  assert.equal(max.sequence, 65534);
  const min = decodePayload('C58001000000000000000000CBB8334C884F');
  close(min.temperature, -163.835, 3, 'temperature');
  assert.equal(min.voltage, 1.6);
  assert.equal(min.txPower, -40);
  const invalid = decodePayload('C58000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
  for (const field of ['temperature', 'humidity', 'pressure', 'voltage', 'txPower']) {
    assert.equal(invalid[field], null, field);
  }
  assert.equal(invalid.movement, null);
  assert.equal(invalid.sequence, null);
  assert.equal(invalid.mac, null);
});

test('data format 3 (RAWv1): the vectors of the docs', () => {
  const m = decodePayload('03291A1ECE1EFC18F94202CA0B53');
  assert.equal(m.format, 3);
  assert.equal(m.temperature, 26.3);
  assert.equal(m.pressure, 102766);
  assert.equal(m.humidity, 20.5);
  assert.equal(m.accelerationX, -1);
  assert.equal(m.accelerationY, -1.726);
  assert.equal(m.accelerationZ, 0.714);
  assert.equal(m.voltage, 2.899);
  assert.equal(m.sequence, null, 'no sequence number in RAWv1');
  assert.equal(m.movement, null);
  const max = decodePayload('03FF7F63FFFF7FFF7FFF7FFFFFFF');
  assert.equal(max.temperature, 127.99);
  assert.equal(max.pressure, 115535);
  assert.equal(max.humidity, 127.5);
  assert.equal(max.voltage, 65.535);
  const min = decodePayload('0300FF6300008001800180010000');
  assert.equal(min.temperature, -127.99);
  assert.equal(min.pressure, 50000);
  assert.equal(min.voltage, 0);
  // The doc example of a negative temperature: 0x8145 is -1.69 °C.
  assert.equal(decodePayload('03298145CE1EFC18F94202CA0B53').temperature, -1.69);
  // A fraction above 99 is not a temperature.
  assert.equal(decodePayload('03291A64CE1EFC18F94202CA0B53').temperature, null);
});

test('the advertisements of the gateway examples of the docs', () => {
  // GET /history examples: the values the gateway decoded itself, for the
  // same frames.
  const cases = [
    [
      '0201061BFF990405164D77BDC74A03FCFF34FFFC87D6DA63CAE375CF374E23',
      { temperature: 28.545, humidity: 76.6325, pressure: 101018, voltage: 2.686 },
      { movement: 218, sequence: 25546, mac: 'e375cf374e23' },
    ],
    [
      '0201061BFF99040517C166ACC78C00540004041C8756086435C6A5B9E0AD06',
      { temperature: 30.405, humidity: 65.71, pressure: 101084, voltage: 2.682 },
      { movement: 8, sequence: 25653, mac: 'c6a5b9e0ad06' },
    ],
    [
      '0201061BFF99040515EF481EC6630038001003F08376502051F4C6462C3EB4',
      { temperature: 28.075, humidity: 46.155, voltage: 2.651 },
      { movement: 80, sequence: 8273, mac: 'f4c6462c3eb4' },
    ],
  ];
  for (const [frame, values, exact] of cases) {
    const result = decodeFrame(frame);
    assert.equal(result.ok, true);
    for (const [field, expected] of Object.entries(values)) {
      close(result.measure[field], expected, 3, field);
    }
    for (const [field, expected] of Object.entries(exact)) {
      assert.equal(result.measure[field], expected, field);
    }
  }
  // The gateway examples also give a decoded `txPower` of -32 dBm where the
  // power field of the frames says +4 dBm (22 steps of 2 dBm above -40, the
  // rule of the format page): the integration follows the format page.
  assert.equal(decodeFrame(cases[0][0]).measure.txPower, 4);
  // The decoded pressure of that third example of the docs (150787) is the
  // raw field + 100000: the frame says 0xC663 + 50000 = 100787 Pa, the value
  // of the format page. The integration decodes the frame itself.
  assert.equal(
    decodeFrame('0201061BFF99040515EF481EC6630038001003F08376502051F4C6462C3EB4').measure.pressure,
    100787,
  );
});

test('frames are bounded and walked strictly: nothing is read past the end', () => {
  assert.deepEqual(decodeFrame(''), { ok: false, why: 'frame' });
  assert.deepEqual(decodeFrame('0201061'), { ok: false, why: 'frame' }, 'odd length');
  assert.deepEqual(decodeFrame('zz'), { ok: false, why: 'frame' });
  assert.deepEqual(decodeFrame('00'.repeat(300)), { ok: false, why: 'frame' }, 'too long');
  assert.deepEqual(decodeFrame(42), { ok: false, why: 'frame' });
  // An AD length running past the end.
  assert.deepEqual(decodeFrame('0201061BFF990405'), { ok: false, why: 'other' });
  // Another manufacturer (Apple 0x004C).
  assert.deepEqual(decodeFrame('0201061AFF4C000215'.padEnd(62, '0')), {
    ok: false,
    why: 'other',
  });
  // A zero length stops the walk.
  assert.deepEqual(decodeFrame('000201'), { ok: false, why: 'other' });
  // A Ruuvi payload cut short for its format.
  assert.deepEqual(decodeFrame('0201060AFF99040512FC5394C37C'), { ok: false, why: 'short' });
  // Formats left out: 6 and E1 (Ruuvi Air), 8 (encrypted).
  assert.deepEqual(decodeFrame('0201061BFF990406170C5668C79E007000C90501D9FFCD004C884F00000000'), {
    ok: false,
    why: 'format:6',
  });
  assert.equal(decodeFrame('0201060EFF9904E100000000000000000000').why, 'format:225');
  assert.equal(decodeFrame('0201060EFF99040800000000000000000000').why, 'format:8');
  // A payload found after other AD structures.
  const bytes = hexToBytes(
    '03190000' + '0201061BFF99040512FC5394C37C0004FFFC040CAC364200CDCBB8334C884F',
  );
  assert.equal(ruuviPayload(bytes)[0], 5);
  assert.equal(decodePayload('06'), null);
  assert.equal(decodePayload('05FFFF'), null);
});
