# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real Ruuvi Gateway (polling mode,
      read-only bearer key) and real RuuviTags: the devices of the Discovery
      tab, their values, motion, the status, the test button, a wrong key, a
      gateway with a password and no key, a tag taken out of range. Never
      done yet.
- [ ] Run the store validator with the image check once the image is
      published.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm on a real gateway

- [ ] What `GET /history` answers without a key, or with a wrong one, for
      each LAN access mode (`lan_auth_default`, `lan_auth_ruuvi`, `basic`,
      `digest`, `deny`): 401, 403 or a redirection to the sign-in page (all
      are taken as refused, final).
- [ ] Whether `decode=false` is accepted by every firmware still in use
      (older ones should ignore it).
- [ ] Whether the gateway keeps the last frame of a silent tag in
      `/history`, and for how long (a frozen sequence number or an old
      timestamp both end as "no recent measurement" after an hour).
- [ ] The `timestamp` fields without time synchronisation (the gateway
      clock may start at 1970): the age is counted between two instants of
      the gateway, so it should still hold.
- [ ] The "without timestamps" mode of the gateway (a `counter` instead of
      a `timestamp` per tag): the age is then counted from the first time
      the integration saw the measurement.
- [ ] The decoded `txPower` of the examples of the docs (-32 dBm) differs
      from what the power field of the same frames gives per the format
      page (+4 dBm). Not published, so no impact; noted for the record.

## Later

- [ ] Ruuvi Air (formats 6 and E1): CO2, PM2.5, VOC and NOx indexes,
      luminosity. Only counted in the status today.
- [ ] Acceleration (x, y, z) and the raw movement counter, if asked for.

## Decisions

- **SDK `^0.16.0`** (2026-10-27, migration wave 3): 0.16.0 is on npm since
  2026-10-25 (a stale npm cache said otherwise); it adds the ai, tts and music
  types; no effect here (`poll_frequency` unused). `keywords`, `countries`
  and `gladys_version >= 5.3.0` wait until Gladys 5.3 is widespread.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-ruuvi-gateway:0.1.0`); the first patch release
  gives 0.1.1.
- **No library ported.** `aioruuvigateway` (the library of Home Assistant)
  has had no release since 0.1.0 (2023-04): the local API and the data
  formats were written from the official Ruuvi documentation
  (https://github.com/ruuvi/docs, commit a03d2c2 of 2026-09-16, cloned read
  only in `~/code/ref/lot15/ruuvi-docs`). That repository has no license
  file: no text of it is reproduced, its pages are cited
  (`THIRD_PARTY_NOTICES.md`, docs), its test vectors (hex frames and values)
  are used in `test/ruuvitag.test.js`.
- **Neighbour module**: gladys-sensorpush (pace and state file under
  `/data`, measurements told apart by their source mark, dated states,
  state budget, devices that never lose a feature).
- **`decode=false`**: the integration decodes the frames itself; the
  decoded fields of the gateway are never read (the docs show one with a
  pressure off by 50 000 Pa and a TX power that does not match its frame).
- **Formats**: 5 (RAWv2), C5 (Cut-RAWv2) and 3 (RAWv1) for the RuuviTag.
  The C5 test vectors of the docs start with `05`: the byte of the format
  is `C5` per the table of the same page; the tests use `C5`.
- **External ids**: `tag:<MAC of the tag, 12 lowercase hex digits>`, the MAC
  under which the gateway files the frame (it must equal the MAC inside a
  RAWv2 or C5 frame). Feature keys `temperature`, `humidity`, `pressure`,
  `motion`, `battery_voltage`, `signal`. Frozen.
- **Freshness**: a measurement is told apart by its sequence number (RAWv2,
  C5), else by the instant the gateway heard it (RAWv1), else by the frame
  itself; the same mark never makes a tag look alive. Its age is counted on
  the clock of the gateway. Without its instants (no timestamps, or a clock
  before 2020: the firmware then returns its whole table, review r1), a mark
  seen first gives no value; only a mark that changed since the previous
  read of the process is published, as measured since that read.
- **Waiting states** keep the instant of their measurement and are judged
  when they leave: dropped past an hour, dated past `recentMs()` (review r1).
- **RAWv1 "not available"**: humidity 0, raw pressure 0 and voltage 0 are
  unknown; a temperature of 0 only when the whole frame is 0 (review r1).
- **Frame lengths**: the exact length of each format (24, 18, 14 bytes);
  a cut AD structure counts as `frame` (review r1).
- **Places** (50 tags): created tags first, then known, then new; a created
  tag takes the place of the non-created tag heard the longest ago.
- **Motion**: binary, 1 when the movement counter differs from the one of
  the previous measurement (at most an hour before, in memory only), 0
  otherwise; no value for a first measurement. A motion sensor never acts
  on anything: no command at all in this integration.
- **Battery**: the voltage only (`unknown`, the unit in the name, as in
  gladys-sensorpush): a percentage would be a guess.
- **The key**: optional (a gateway open on the LAN needs none), printable
  ASCII without space, at most 256 characters; sent only in the
  `Authorization: Bearer` header. The gateway speaks plain HTTP on port 80
  (Ruuvi docs, open ports): said plainly in the manifest and the docs;
  `https://` accepted for a reverse proxy with a valid certificate.
  Redirections are never followed.
- **Refusal**: 401, 403 or a redirection is final (no automatic retry, even
  after a restart); the test button tries once after the interval and lifts
  it only on success. The file keeps an 8-bit marker of a salted scrypt
  hash of address + key while refused (a short key cannot be found back:
  tested), so another key is tried at once after a restart.
- **Interval**: 2 minutes by default (1 to 60).
- **Bluetooth**: none in the container; the gateway listens to the tags.
