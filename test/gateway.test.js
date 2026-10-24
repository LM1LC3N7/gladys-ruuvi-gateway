// -----------------------------------------------------------------------------
// The client of the local API (GET /history), the HTTP layer (bounded body,
// no redirection followed, the key only in its header) and the address and
// key of the configuration.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress, isConfigured } from '../src/config.js';
import { macKeyOf, readHistory, unixMs } from '../src/gateway.js';
import { retryAfterMs } from '../src/http.js';
import { GW_MAC, SALON, TOKEN, history, installFetch, json, keyOf } from './helpers/fakes.js';

const BASE = 'http://192.168.1.50';
let fake;
afterEach(() => fake?.restore());

test('GET /history?decode=false with the key in the Authorization header only', async () => {
  const now = Date.parse('2026-10-20T18:00:00Z');
  fake = installFetch([[/\/history\?decode=false$/, () => json(history(now))]]);
  const answer = await readHistory({ base: BASE, token: TOKEN });
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.url, `${BASE}/history?decode=false`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.redirect, 'manual');
  assert.ok(!call.url.includes(TOKEN));
  assert.equal(answer.gwMac, keyOf(GW_MAC));
  assert.equal(answer.gwTime, now);
  assert.deepEqual([...answer.tags.keys()].sort(), ['c6a5b9e0ad06', 'e375cf374e23']);
  assert.equal(answer.tags.get(keyOf(SALON)).ts, now - 2_000);
  assert.equal(answer.tags.get(keyOf(SALON)).rssi, -60);
  // Without a key: no Authorization header at all.
  await readHistory({ base: BASE, token: '' });
  assert.equal(fake.calls[1].init.headers.Authorization, undefined);
});

test('the error kinds: refused, redirection, pause, invalid, failed', async () => {
  const cases = [
    [() => json({}, 401), 'refused'],
    [() => json({}, 403), 'refused'],
    [() => new Response(null, { status: 302, headers: { location: '/auth.html' } }), 'refused'],
    [() => json({}, 429, { 'retry-after': '120' }), 'limited'],
    [() => json({}, 503), 'busy'],
    [() => json({}, 404), 'failed'],
    [() => new Response('<html>'), 'invalid'],
    [() => json({ data: { tags: [] } }), 'invalid'],
    [() => json([]), 'invalid'],
    [
      () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
      'failed',
    ],
  ];
  for (const [answer, kind] of cases) {
    fake?.restore();
    fake = installFetch([[/\/history/, answer]]);
    await assert.rejects(readHistory({ base: BASE, token: TOKEN }), (err) => {
      assert.equal(err.kind, kind);
      assert.ok(!err.message.includes(TOKEN));
      return true;
    });
  }
  fake.restore();
  fake = installFetch([[/\/history/, () => json({}, 429, { 'retry-after': '120' })]]);
  await assert.rejects(readHistory({ base: BASE, token: TOKEN }), (err) => {
    assert.equal(err.retryAfterMs, 120_000);
    return true;
  });
});

test('an answer too large is abandoned', async () => {
  fake = installFetch([[/\/history/, () => new Response('x'.repeat(1024 * 1024 + 1))]]);
  await assert.rejects(readHistory({ base: BASE, token: TOKEN }), /answer too large/);
});

test('entries are checked: MAC form, duplicates, bounded frames, no prototype', async () => {
  const now = Date.parse('2026-10-20T18:00:00Z');
  const body = history(now, {
    extra: {
      'not-a-mac': { rssi: -1, timestamp: '1', data: '00' },
      'FF:FF:FF:FF:FF:FF': { rssi: -1, timestamp: '1', data: '00' },
      'c6-a5-b9-e0-ad-06': { rssi: -1, timestamp: '1', data: '00' },
      'AA:BB:CC:DD:EE:01': { rssi: 'x', timestamp: 'later', data: '00'.repeat(300) },
      'AA:BB:CC:DD:EE:02': { rssi: 999, timestamp: 1_700_000_000, data: '0201' },
    },
  });
  const text = JSON.stringify(body).replace('"tags":{', '"tags":{"__proto__":{"data":"00"},');
  fake = installFetch([[/\/history/, () => new Response(text)]]);
  const answer = await readHistory({ base: BASE, token: TOKEN });
  assert.deepEqual([...answer.tags.keys()].sort(), [
    'aabbccddee02',
    'c6a5b9e0ad06',
    'e375cf374e23',
  ]);
  assert.equal(answer.tags.get(keyOf(SALON)).rssi, -60, 'the first spelling of a MAC is kept');
  assert.equal(answer.tags.get('aabbccddee02').rssi, null);
  assert.equal(answer.tags.get('aabbccddee02').ts, 1_700_000_000_000, 'an integer timestamp');
  assert.equal({}.data, undefined);
});

test('MAC keys and Unix times', () => {
  assert.equal(macKeyOf('C6:A5:B9:E0:AD:06'), 'c6a5b9e0ad06');
  assert.equal(macKeyOf('c6-a5-b9-e0-ad-06'), 'c6a5b9e0ad06');
  assert.equal(macKeyOf('00:00:00:00:00:00'), null);
  assert.equal(macKeyOf('C6:A5:B9:E0:AD'), null);
  assert.equal(macKeyOf('C6:A5:B9:E0:AD:06\n'), null);
  assert.equal(unixMs('1698727580'), 1_698_727_580_000);
  assert.equal(unixMs(1698727580), 1_698_727_580_000);
  assert.equal(unixMs(''), null);
  assert.equal(unixMs('-1'), null);
  assert.equal(unixMs(1.5), null);
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(retryAfterMs(''), undefined);
});

test('the address of the gateway: hosts and ports taken, anything else refused', () => {
  const ok = [
    ['192.168.1.50', 'http://192.168.1.50'],
    [' 192.168.1.50:8080 ', 'http://192.168.1.50:8080'],
    ['http://192.168.1.50/', 'http://192.168.1.50'],
    ['HTTPS://Ruuvi-GW.local', 'https://ruuvi-gw.local'],
    ['ruuvigateway', 'http://ruuvigateway'],
    ['[fd00::1]:81', 'http://[fd00::1]:81'],
  ];
  for (const [text, base] of ok) {
    assert.equal(parseAddress(text)?.base, base, text);
  }
  const refused = [
    '',
    'ftp://192.168.1.50',
    '192.168.1.50/history',
    '192.168.1.50?x=1',
    'user@192.168.1.50',
    '192.168.1.50:0',
    '192.168.1.50:70000',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.251',
    '239.255.255.250',
    '192.168.1.256',
    '010.1.1.1',
    '1.2.3',
    'host name',
    'host\nname',
    '[::]',
    '[ff02::1]',
    '-bad.example',
    'a'.repeat(301),
  ];
  for (const text of refused) {
    assert.equal(parseAddress(text), null, JSON.stringify(text));
  }
});

test('the configuration: an invalid key is never sent nor shown, the interval bounded', () => {
  const config = normalizeConfig({ host: '192.168.1.50', token: ` ${TOKEN} `, poll_interval: '5' });
  assert.equal(config.token, TOKEN);
  assert.equal(config.pollMinutes, 5);
  assert.ok(isConfigured(config));
  assert.ok(isConfigured(normalizeConfig({ host: '192.168.1.50' })), 'a key is optional');
  for (const token of ['a b', 'abc\r\nX-Evil: 1', 'é', 'x'.repeat(257)]) {
    const bad = normalizeConfig({ host: '192.168.1.50', token });
    assert.equal(bad.invalidToken, true, token);
    assert.equal(isConfigured(bad), false);
  }
  assert.equal(normalizeConfig({ host: 'http://x/y' }).invalidHost, true);
  assert.equal(normalizeConfig({}).pollMinutes, 2);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollMinutes, 2, 'empty is the default');
  assert.equal(normalizeConfig({ poll_interval: 0 }).pollMinutes, 1);
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollMinutes, 60);
  assert.equal(normalizeConfig({ poll_interval: '1e3' }).pollMinutes, 2);
});
