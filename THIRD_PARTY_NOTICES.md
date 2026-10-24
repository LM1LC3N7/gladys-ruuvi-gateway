# Third-party notices

This integration is licensed under Apache-2.0 (see `LICENSE`). It ports no
code of another project: no library of the Ruuvi Gateway is used (the
Python library `aioruuvigateway` has had no release since 2023-04). The
local API of the gateway and the RuuviTag data formats were implemented from
the official documentation of Ruuvi, cited below.

## Ruuvi developer documentation

- Source: https://docs.ruuvi.com, published from the repository
  https://github.com/ruuvi/docs (read at commit a03d2c2 of 2026-09-16).
- Author: Ruuvi Innovations Ltd.
- License: the repository holds no license file. No text, table, image nor
  example of it is reproduced in this integration or its documentation: the
  pages are cited by their address. The integration implements the
  published specification (field offsets, scales and "not available"
  values), and its tests check the decoder against the test vectors listed
  in the data format pages (hexadecimal frames and their expected values),
  which the docs say are based on the tests of the
  [ttu/ruuvitag-sensor](https://github.com/ttu/ruuvitag-sensor) project.
- Pages used:
  - Polling mode of the gateway (`GET /history`, bearer key):
    https://docs.ruuvi.com/ruuvi-gateway-firmware/examples/polling-mode
  - Format of the answer of `GET /history` and the `decode=false` parameter:
    https://docs.ruuvi.com/ruuvi-gateway-firmware/data-formats/http-get-history-with-timestamps-and-decoding
  - Access settings from the LAN (read-only API key):
    https://docs.ruuvi.com/ruuvi-gateway-firmware/gateway-web-ui/access-settings-from-lan
  - Open ports and services of the gateway (plain HTTP on port 80):
    https://docs.ruuvi.com/ruuvi-gateway-firmware/gw-open-ports-services
  - Bluetooth advertisements (AD structures, manufacturer id 0x0499):
    https://docs.ruuvi.com/communication/bluetooth-advertisements
  - Data format 5 (RAWv2):
    https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5-rawv2
  - Data format C5 (Cut-RAWv2):
    https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-c5-rawv2
  - Data format 3 (RAWv1):
    https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-3-rawv1

Ruuvi, RuuviTag and Ruuvi Gateway are trademarks of Ruuvi Innovations Ltd;
this connector is free, unofficial and not affiliated with Ruuvi.
