# weather-display

ESP32 + WS2812B (48 LEDs) wall-art weather station, fed by Home Assistant.

Each LED is one hour of the next 24. The top row is temperature, the bottom
row is sky conditions. "Now" is at the left end of each row; tomorrow at this
time is at the right. Storm hours flash yellow, windy hours shimmer, and the
sunrise and sunset cells breathe.

Home Assistant classifies the forecast into small integer buckets and
publishes them over MQTT every 15 minutes. The ESP32 owns every color and
animation. Tuning the palette means editing `src/main.cpp` and reflashing;
nothing on the HA side changes.

## What you need

- Home Assistant with the **Mosquitto broker** add-on (or any MQTT broker HA
  is connected to)
- A weather entity that supports hourly forecasts. The built-in met.no entity
  (`weather.forecast_home`) works out of the box.
- An ESP32 dev board (`esp32dev` in `platformio.ini`; change `board` for other
  modules)
- A 48-LED WS2812B / SK6812 strip, mounted as two rows of 24 (see Layout)
- 5V supply for the strip, GND common with the ESP32
- [PlatformIO](https://platformio.org/) to build and flash

## Setup

### 1. Home Assistant

Everything HA needs is in `ha/`:

| File | Where it goes |
|------|---------------|
| `ha/python_scripts/weather_display_publish.py` | `/config/python_scripts/` (create the folder if needed) |
| `ha/scripts.yaml` | Append to your `scripts.yaml`. Change `weather.forecast_home` to your weather entity. |
| `ha/automations.yaml` | Append to your `automations.yaml`. |
| `ha/configuration.yaml` | Add `python_script:` to `configuration.yaml`. The `mqtt: sensor:` block is optional. |

Restart HA. Then run the script **Weather Display - Publish Forecast** once
from Settings > Automations & Scenes > Scripts. You should see a retained
message on the `weather/hourly` topic (MQTT add-on > Configure > Listen to a
topic).

### 2. Firmware

```bash
cp include/secrets.h.example include/secrets.h   # WiFi + MQTT credentials
pio run -t upload && pio device monitor            # first flash over USB
```

The first flash installs an ArduinoOTA listener. After that, flash over WiFi:

```bash
pio run -e esp32dev-ota -t upload
```

Set the device IP in `platformio_local.ini` (gitignored, see the comment in
`platformio.ini`). Reserve the IP in your router so it doesn't move. OTA is
dual-bank, so a failed flash leaves the previous firmware intact, and the
firmware blanks the LEDs during an OTA so FastLED isn't fighting the flash.

### 3. First boot

The strip shows a slow blue breath on LED 0 until the first MQTT message
arrives. Once the retained payload lands (a second or two after connecting)
the full forecast appears.

## Layout

The strip is snaked into two rows of 24:

```
Top row    (LEDs  0..23): physically L -> R  = temperature, hour h at LED h
Bottom row (LEDs 24..47): physically R -> L  = conditions,  hour h at LED (47 - h)
```

Hour 0 is the current hour; hour 23 is 23 hours out. Data is on GPIO 18
(`DATA_PIN` in `src/main.cpp`).

## MQTT topics

### `weather/hourly` (retained, published by HA)

```json
{"h": [[temp_bucket, cond_code, is_night, precip_bucket, wind_bucket], ... 24 entries]}
```

| Field | Range | Meaning |
|-------|-------|---------|
| `temp_bucket` | 0-7 | `0 unknown, 1 <20°F, 2 20-31, 3 32-49, 4 50-64, 5 65-77, 6 78-89, 7 90+` |
| `cond_code` | 0-12 | HA condition string mapped by `COND_MAP` in the python script: sunny, clear-night, partlycloudy, cloudy, windy, windy-variant, fog, rainy/pouring, snowy, snowy-rainy, lightning(-rainy), hail/exceptional |
| `is_night` | 0/1 | 20:00-06:59 local. The firmware dims night cells so cloudy nights don't wash out the strip. |
| `precip_bucket` | 0-10 | From `precipitation_probability` (10% bands), falling back to amount in mm. Scales brightness on wet hours. |
| `wind_bucket` | 0-8 | Wind speed normalized to mph, then banded. Scales the shimmer amplitude. |

Temperature buckets assume °F. If your HA is metric the temperatures arrive in
°C; edit `temp_bucket()` in the python script to taste. Wind and precipitation
units are read from the weather entity and converted automatically.

Older 3-tuple payloads still render (precip and wind default to off).

### `weather/display/mode` (retained, plain string)

`"forecast"` or `"demo"`. Demo mode walks every palette color side by side so
you can check wiring and color order. The publish script sets `forecast` on
every refresh, so a device left in demo returns to the forecast within 15
minutes.

## Animations

- **Sunrise / sunset breathe.** The temperature cells at the day/night
  transitions dip and recover once every 6 seconds.
- **Wind shimmer.** Windy hours flow with Perlin-noise brightness; amplitude
  scales with `wind_bucket`.
- **Lightning.** Storm hours render as rain with a yellow bolt blended on top
  on a ~12.7 second cycle (rumble, build, peak, flicker, decay).

## Firmware structure

All in `src/main.cpp`:

- `TEMP_PALETTE`, `CONDITION_PALETTE`, `LIGHTNING_BOLT`: every color the device
  can show
- `renderForecast()` / `renderDemo()`: build the static frame
- `applyBreathing()` / `applyWind()` / `applyLightning()`: per-frame overlays
- `onMqtt()`: parses both topics and handles the mode switch

Keep `COND_MAP` in `ha/python_scripts/weather_display_publish.py` in step with
the condition enum in `src/main.cpp`. A new condition needs both.

## Related

The same idea, ported to a phone: [Edgelight Weather](https://play.google.com/store/apps/details?id=com.adamrho.edgelight)
is an Android live wallpaper that renders the 24-hour forecast as a glow
along the screen edges.

## License

MIT. See `LICENSE`.
