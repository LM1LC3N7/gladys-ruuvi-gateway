# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Integration SDK 0.16 (no change for the devices).

## [0.1.1] - 2026-10-24

### Added

- Your RuuviTag sensors in Gladys, read only, through the local HTTP API of a
  Ruuvi Gateway (polling mode, `GET /history`, read-only API key): no cloud,
  no Bluetooth in Gladys. Fifty tags at most.
- One device per tag (its MAC address as the id): temperature, humidity,
  pressure, motion (the movement counter of the tag moved since its previous
  measurement), battery voltage and signal, in the units Gladys lists (°C,
  %, hPa).
- The frames are decoded by the integration after the data formats published
  by Ruuvi: 5 (RAWv2), C5 (Cut-RAWv2) and 3 (RAWv1), checked against the test
  vectors of the docs; "not available" values are left out; the formats of
  Ruuvi Air (6, E1), 8 and URL are counted in the status, not decoded.
- Each measurement is handed to Gladys once, told apart by its sequence
  number, also across a restart: a tag that stops measuring is never shown
  alive, even while the gateway still hears its last frame. Its age is
  counted on the clock of the gateway; older than an hour, it is never sent.
- Read every 2 minutes by default, never faster: not by the test button, a
  reconnection, a saved configuration, the Discovery tab nor a restart (the
  instant of the last request is kept under `/data`, written at most once
  per minute). At most 250 values a minute are sent to Gladys.
- A refused key stops the reads for good, also after a restart, until you
  change the address or the key or press the test button. A 429 or 5xx
  pauses the reads (Retry-After, else 5 minutes doubling, between 1 minute
  and 6 hours), also across a restart. The key is never written under
  `/data`, in the logs nor in a status.
- A test button that shows the last values of each tag and when the next
  read can happen.
- A gateway without timestamps, or whose clock is not set, never makes an old
  frame look like a current measurement: a tag gets values once its
  measurement changes between two reads.
- A value that waited (full budget, Gladys unreachable) is dated, or dropped
  past an hour, when it is finally sent.

[Unreleased]: https://github.com/LM1LC3N7/gladys-ruuvi-gateway/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-ruuvi-gateway/releases/tag/v0.1.1
