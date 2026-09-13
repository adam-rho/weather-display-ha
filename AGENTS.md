# Working in this repo

## Layout

- `src/`, `include/`: ESP32 firmware (PlatformIO, FastLED). `weather_colors.h` owns the palette; `display_engine.h` owns settings and rendering.
- `ha/`: everything Home Assistant needs. YAML templates use placeholder entity ids (`weather.forecast_home`, `weather.nws_home`).
- `web/`: the Lovelace card (Lit, no build step beyond a copy). `scripts/build.mjs` copies it to `dist/` for the installer.
- `tests/`: `test_weather.py` (publisher), `editor.test.mjs` + `tests/browser/` (card, Playwright), `*.cpp` (firmware color/render parity).
- `docs/history/`: specs and handoff notes from past features. Context only; not maintained.

## Commands

- `python3 -m unittest tests/test_weather.py` -- publisher tests. `FirmwareColorsTest` compiles the C++ tests and needs `.pio/libdeps` present (`pio run` once).
- `npm test` / `npx playwright test` -- card tests. `node scripts/serve.mjs` serves `web/demo.html` on :8766 with a fake `hass`.
- `pio run -t upload` (USB) / `pio run -e esp32dev-ota -t upload` (OTA; IP in gitignored `platformio_local.ini`).
- `npm run build && python3 scripts/install-ha.py --host user@ha --dashboard <storage-suffix> --install` -- deploys card, tab, HA package, publisher.

## Hazards

- `install-ha.py` stops HA core for ~30s to edit dashboard storage. It only replaces the Edgelight tab's `cards`; other tab edits survive.
- The card imports `./vendor/lit-core.min.js` relative to its own URL; every deployed asset directory must contain `vendor/`. HA caches `/local` 404s for 31 days, so a missing file needs a new asset path, not a re-copy.
- Publisher and firmware share the `weather/hourly` tuple layout and `COND_MAP`/`COND_*` enums. Change both or neither.
- Weather integrations differ in timestamp offsets (NWS local, met.no UTC) and units. Normalize in the publisher, never in firmware.

## Conventions

- Hardware shape is fixed at 48 LEDs in two rows of 24 (firmware, card, and preview all assume it). The wiring corner and snake direction are device config (`layout`), mapped by `ledFor` in `display_engine.h` and `display-model.js`; both must agree, and the parity test checks all eight.
- Commit directly to `main`; feature branches only for gated multi-commit work.
