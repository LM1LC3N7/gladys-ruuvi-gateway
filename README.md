# gladys-ruuvi-gateway

[Gladys Assistant](https://gladysassistant.com) external integration for the
**RuuviTag** sensors heard by a **Ruuvi Gateway**: temperature, humidity,
pressure, motion, battery voltage and signal, read through the local HTTP
API of the gateway (`GET /history`, read-only bearer key; no cloud, no
Bluetooth in Gladys). Read only. **Unofficial, not affiliated with Ruuvi.
Never tested with a real gateway yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (RuuviGatewayApp)  what is due, pauses, refusal, tags, motion, states, status, test
                 ├─ src/gateway.js            GET /history?decode=false, error kinds, MAC keys
                 ├─ src/ruuvitag.js           RuuviTag frames: formats 5 (RAWv2), C5, 3 (pure)
                 ├─ src/fields.js             measures -> values in core units, devices, states (pure)
                 ├─ src/store.js              pace, pause, refusal, tags met, persisted in /data
                 ├─ src/config.js             DEFAULT_CONFIG + address and key checks
                 └─ src/http.js               fetch, timeout, no redirection, bounded body
```

- **One request per read**: `GET /history?decode=false` with
  `Authorization: Bearer <key>`; the frames are decoded by the integration
  (the decoded fields of the gateway are never read).
- **Frames**: the AD structures are walked strictly, the Ruuvi manufacturer
  data (0x0499) decoded after the published formats; "not available" values
  (0x8000, 0xFFFF, 2047, 31, 255, a MAC of all ones) give null; a frame whose
  MAC differs from its key is left out; formats 6, E1 (Ruuvi Air), 8 and the
  URL formats are counted, not decoded.
- **Measurements**: told apart by their sequence number (else the instant
  heard, else the frame), kept under `/data`, handed to Gladys once; the age
  counted on the clock of the gateway; current if at most max(5 min,
  interval + 2 min) old, dated (`created_at`) up to 1 hour, never older; the
  signal only with a new measurement. A tag whose sequence stops is never
  shown alive. Motion: the movement counter moved since the previous
  measurement (at most an hour before).
- **Pace**: 2 minutes by default; never faster than the interval since the
  last request (persisted before it leaves, written at most once per
  minute), test button, reconnections and restarts included.
- **Refused key** (401/403 or a redirection): final (no automatic read, even
  after a restart) until the address or the key change or the test button
  is pressed; persisted with an 8-bit marker only. **429/5xx** →
  `Retry-After`, else 5 minutes doubling, between 1 minute and 6 hours,
  persisted.
- **Devices**: `tag:<MAC, 12 lowercase hex digits>`, then a feature key of
  this integration (`temperature`, `motion`...). Units of the core only. A
  feature once created is never dropped from the Discovery list. 250 states
  a minute at most.

No runtime dependency besides the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, no network, no disk
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

Written from the developer documentation of Ruuvi
([docs.ruuvi.com](https://docs.ruuvi.com), repository
[ruuvi/docs](https://github.com/ruuvi/docs)); no code of another project is
ported. The pages used are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0 ([LICENSE](LICENSE)). Ruuvi, RuuviTag and Ruuvi Gateway are
trademarks of Ruuvi Innovations Ltd.
