# weather-display

ESP32 + WS2812B (48 LEDs) wall-art weather station. Pulls forecast categories
from Home Assistant via MQTT and renders them with breathing + thunderbolt
lightning animations. All color logic lives on the device.

## Architecture

- **HA** classifies the next 24 hours into category tuples and publishes them
  to MQTT topic `weather/hourly` (retained) every 15 minutes. Source:
  `python_script.weather_display_publish`, fired by the HA script
  `weather_display_publish_forecast` on a 15-minute automation.
- **ESP32** subscribes to `weather/hourly` plus `weather/display/mode`. The
  FastLED loop (~60fps) renders the static forecast frame plus animated
  overlays (breathing on the "now" cells, multi-pulse amber flashes on
  lightning hours).

HA owns the data shape. The device owns every color. Tuning the palette =
edit `src/main.cpp` and reflash. No HA roundtrip needed.

## Layout

LED strip is snaked into two rows of 24:

```
Top row    (LEDs  0..23): physically L -> R  = temperature, hour h at LED h
Bottom row (LEDs 24..47): physically R -> L  = precipitation, hour h at LED (47 - h)
```

"Now" = LED 0 (top-left) and LED 47 (bottom-left, after the snake flip). Hour
0 is the current hour; hour 23 is 23 hours out.

## Setup

1. Copy the secrets template and fill in WiFi SSID/pass and MQTT broker
   creds:
   ```bash
   cp include/secrets.h.example include/secrets.h
   ```

2. Flash (first time, USB):
   ```bash
   pio run -t upload && pio device monitor
   ```
   This installs the ArduinoOTA listener. After this, the USB cable can be
   removed for good (unless you ever brick it and need recovery).

3. Flash (subsequent, OTA over WiFi):
   ```bash
   pio run -e esp32dev-ota -t upload
   ```
   Pushes the firmware to `192.168.2.75:3232` (the ESP32's `weather-display`
   hostname). If the IP changes, edit `upload_port` in `platformio.ini`.
   Reserving the IP in your router DHCP table is recommended.

   Notes on OTA:
   - The mDNS form (`weather-display.local`) tends to fail with espota on
     macOS, so we pin the raw IP instead.
   - The firmware blanks the LEDs when an OTA starts so FastLED isn't
     fighting the flash.
   - OTA is dual-bank: a failed flash leaves the previous firmware intact.

4. On boot the strip shows a slow blue breath on LED 0 while waiting for the
   first MQTT message. Once the retained payload arrives (within a second or
   two of connecting) the full forecast appears.

## MQTT topics

### `weather/hourly` (retained, published by HA)

```json
{
  "h": [
    [temp_bucket, cond_code, intensity],   // hour 0 (now)
    [temp_bucket, cond_code, intensity],   // hour 1
    ...                                    // 24 entries total
    [temp_bucket, cond_code, intensity]    // hour 23
  ]
}
```

- `temp_bucket` (0-7): one slot in the temperature gradient. Enum in
  `weather_display_publish.py`:
  `0 unknown, 1 <20F, 2 20-31, 3 32-49, 4 50-64, 5 65-77, 6 78-89, 7 90+`.
  Rendered via `TEMP_PALETTE` in firmware (deep navy → red).
- `cond_code` (0-13): NWS condition enum. Atmospheric codes (sunny,
  cloudy, fog, windy, partlycloudy, clear-night, exceptional) render
  straight from `CONDITION_PALETTE`. Precip codes (rainy, pouring, snowy,
  snowy-rainy, hail, lightning, lightning-rainy) route through
  `precipColor()` to use the intensity ramp instead.
- `intensity` (0-6): radar-style ramp for precip cells.
  `0 none, 1 light green (drizzle), 2 dark green (steady light),
   3 yellow (moderate), 4 orange (heavy), 5 red (torrential),
   6 pink/purple (severe mix)`. Snow uses a dedicated blue scaled by
  intensity. Hail / snowy-rainy use a dedicated severe purple.

NWS only exposes `precipitation_probability` (not mm/hr), so the python
script derives `intensity` from probability + condition severity (e.g.
`pouring` bumps the bucket by 2, `lightning-rainy` by 1).

### `weather/display/mode` (non-JSON, published by HA scripts)

Plain string payload: `"demo"` or `"forecast"`. Fires from the HA scripts
`weather_display_demo` and `weather_display_publish_forecast` (the latter
sets `forecast` mode before publishing the payload). Demo mode renders a
hand-curated palette walk so you can eyeball all colors side-by-side.

## Animations

- **Breathing.** Sine envelope on LEDs 0 and 47 (the "now" cells) so the
  current hour subtly pulses.
- **Lightning flash.** When any forecast hour has cond_code in
  {lightning, lightning-rainy}, the flagged precip LEDs hold their radar
  base color and flash amber every ~5s with a multi-pulse thunderbolt
  envelope (bright spike, quick dim, second spike, decay).

## Hardware

- ESP32 dev board (esp32dev in `platformio.ini`; adjust `board` for other
  modules)
- 48-LED WS2812B / SK6812 strip (snake-mounted in two rows of 24)
- Data on GPIO 18 (set by `DATA_PIN` in `src/main.cpp`)
- Power: external 5V to the strip, GND common with the ESP32

## Firmware structure

All in `src/main.cpp`:

- `TEMP_PALETTE`, `CONDITION_PALETTE`, `PRECIP_RAMP`, `SNOW_COLOR`,
  `SEVERE_COLOR`, `LIGHTNING_BOLT`: every color the device can show.
- `precipColor(cond, intensity)`: routes precip codes through the ramp,
  atmospheric codes through the palette.
- `renderForecast()` / `renderDemo()`: build the static frame.
- `applyBreathing()` / `applyLightning()`: per-frame overlays.
- `onMqtt()`: parses both topics, handles mode switch.

## HA pieces (lives under `/config/` on the HA host)

- `python_scripts/weather_display_publish.py`: classifies forecast into the
  category tuples and publishes to `weather/hourly`.
- `scripts.yaml`:
  - `weather_display_publish_forecast`: pulls NWS hourly forecast, sets
    mode to `forecast`, calls the python_script.
  - `weather_display_demo`: sets mode to `demo`.
- An automation runs `weather_display_publish_forecast` every 15 minutes.

Keep the COND_MAP in `weather_display_publish.py` in lockstep with the
`Condition` enum in `src/main.cpp`. If you add a new condition, both files
need the new code.
