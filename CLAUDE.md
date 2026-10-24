# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads the RuuviTag sensors heard by a Ruuvi Gateway, read only, through the
local HTTP API of the gateway, written from the official Ruuvi documentation
(https://docs.ruuvi.com; no library ported).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/ruuvitag.test.js              # one file
node --test --test-name-pattern "RAWv2"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `test` and
`npm audit` on Node 22 and 24, and builds the Docker image: run them before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        RuuviGatewayApp: due time, pauses, refusal, tags, motion, states, status, test
src/gateway.js                    GET /history?decode=false, error kinds, MAC keys
src/ruuvitag.js                   RuuviTag frames: AD structures, formats 5, C5, 3 (pure)
src/fields.js                     measures -> values in core units, devices, states (pure)
src/store.js                      pace, pause, refusal, tags met, persisted in /data (never the key)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + address and key checks
src/http.js                       fetch with timeout, no redirection followed, bounded body
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **Read only.** Only `GET /history?decode=false` on the gateway; never a
  configuration, firmware or any other route. No Bluetooth.
- **Frames.** Decoded only after the published Ruuvi formats (5, C5, 3),
  bounded (`MAX_FRAME_HEX`), AD structures walked strictly; "not available"
  values give null, never a number; a frame whose MAC differs from its key
  is left out. New formats need the format page and its test vectors in
  `test/ruuvitag.test.js`.
- **Secrets.** The API key travels only in the `Authorization: Bearer` header
  to the configured gateway. Never in a URL, a log, an error, a status nor
  `/data` (only an 8-bit marker of a salted hash of a refused address + key,
  while it is refused). An invalid key is never shown back. Never describe a
  secret field as "encrypted": Gladys keeps it in clear in its database
  (`test/manifest.test.js` checks the manifest and the docs).
- **A refused key is final** (401, 403 or a redirection): no automatic read
  until the address or the key change or the test button is pressed.
- **Measurements are told apart by their mark** (sequence number, else the
  instant heard, else the frame; kept under `/data`) and handed to Gladys
  once; the age on the clock of the gateway; current only when recent,
  dated up to 1 hour, never older; the signal only with a new measurement.
  A tag whose sequence stops is never shown alive.
- **Pace.** Never read before the last request + the interval (test button,
  reconnection, saved configuration, Discovery, restart); the instant of a
  request is written to `/data` before it leaves, at most once per minute.
  A generation is checked after every await: a late answer publishes
  nothing and sets no status. 250 states a minute at most.
- **External ids are forever**: `tag:<MAC of the tag, 12 lowercase hex
digits>`, then the feature keys of this integration (`temperature`,
  `humidity`, `pressure`, `motion`, `battery_voltage`, `signal`). The same
  goes for every key users store: manifest `config_schema`, `actions`.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`), and never
  drop a feature of a created device from the Discovery list.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the first version, 0.1.0, was set by hand once, see TODO.md).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
