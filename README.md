# weather-display

ESP32 + WS2812B (48 LEDs) wall-art weather station, fed by Home Assistant.

Each LED is one hour of the next 24. The top row is temperature, the bottom
row is sky conditions. "Now" is at the left end of each row; tomorrow at this
time is at the right. Storm hours flash yellow, windy hours shimmer, and the
sunrise and sunset cells breathe.

Home Assistant publishes forecast categories and temperatures over MQTT every
15 minutes. The ESP32 applies the Android app's default color rules from
`include/weather_colors.h`:

- Temperature blends smoothly between color stops at 0, 20, 32, 50, 65, 78
  and 90°F using OKLCH interpolation. Colder/hotter values hold the end colors.
- Conditions use sunny yellow, partly cloudy gold-gray, cloudy blue-gray,
  near-white fog, green rain, teal-blue snow and violet sleet.
- Wet hours use three strengths: buckets 1–3 are light, 4–7 medium, 8–10 heavy.
  The color gets darker as strength increases. Dry conditions keep their color.
- Conditions render the same color day and night. Missing conditions stay off.

Wind and lightning retain their existing LED animations. The strip also retains
its global night brightness setting and HA's 20:00–07:00 night-time estimate.

To update an existing installation, flash the firmware, replace the HA Python
script, then run **Weather Display - Publish Forecast**. Both updates are needed
for smooth temperature colors. Physical LED appearance still needs an on-device
check; these defaults use the same RGB values as the app.

## What you need

- Home Assistant with the **Mosquitto broker** add-on (or any MQTT broker HA
  is connected to)
- A weather entity that supports hourly forecasts. The built-in met.no entity
  (`weather.forecast_home`) works out of the box. Add an NWS entity too and the
  card's **Forecast source** picker switches the wall between them; the switch
  republishes immediately.
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
| `ha/scripts.yaml` | Append to your `scripts.yaml`. Change `weather.forecast_home` and `weather.nws_home` to your met.no and NWS entities. |
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
{"h": [[temp_bucket, cond_code, is_night, precip_bucket, wind_bucket, temperature_f], ... 24 entries]}
```

| Field | Range | Meaning |
|-------|-------|---------|
| `temp_bucket` | 0-7 | `0 unknown, 1 <20°F, 2 20-31, 3 32-49, 4 50-64, 5 65-77, 6 78-89, 7 90+` |
| `cond_code` | 0-13 | Stable HA wire codes mapped to seven visual categories; see below. |
| `is_night` | 0/1 | 20:00-06:59 local. Drives global night brightness and the sunrise/sunset breathing hours. No per-cell dimming. |
| `precip_bucket` | 0-10 | From `precipitation_probability` (10% bands), falling back to amount in mm. Selects light/medium/heavy treatment on wet hours only. |
| `wind_bucket` | 0-8 | Wind speed normalized to mph, then banded. Scales the shimmer amplitude. |
| `temperature_f` | number or null | Actual temperature in °F, converted automatically from °C. Null means no data. |

The first five fields retain their meaning for older firmware. Updated firmware
also accepts older 2-, 3- and 5-field payloads, using the first field's temperature
bucket when the sixth field is absent. Missing precip/wind values default to off.
Temperature, wind and precipitation units are read from the weather entity;
missing units default to °F, mph and mm.

Condition codes: 0 unknown, 1 sunny, 2 clear-night, 3 partlycloudy, 4 cloudy,
5 windy, 6 windy-variant, 7 fog, 8 rainy/pouring, 9 snowy, 10 snowy-rainy,
11 lightning/lightning-rainy, 12 exceptional, 13 hail. Clear-night uses sunny's
color with night treatment. Windy uses sunny, windy-variant uses cloudy, and
hail uses sleet. Thunder uses rain plus lightning. Exceptional has no known
sky category and stays off; it no longer paints an alert-red condition cell.

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

Color rules are in `include/weather_colors.h`; hardware and animations are in
`src/main.cpp`:

- `TEMP_PALETTE`, `CONDITION_PALETTE`, `WET_COLORS`: Android default colors
- `LIGHTNING_BOLT`: animation overlay color
- `renderForecast()` / `renderDemo()`: build the static frame
- `applyBreathing()` / `applyWind()` / `applyLightning()`: per-frame overlays
- `onMqtt()`: parses both topics and handles the mode switch

Keep `COND_MAP` in `ha/python_scripts/weather_display_publish.py` in step with
the condition enum in `src/main.cpp`. A new condition needs both.

## Verification

```bash
pio run -e esp32dev
python3 -m unittest discover -s tests -v
```

The tests compile the portable color rules with a host C++ compiler and exercise
the HA publisher with fake forecast data. No broker or device is contacted.

## Related

The same idea, ported to a phone: [Edgelight Weather](https://play.google.com/store/apps/details?id=com.adamrho.edgelight)
is an Android live wallpaper that renders the 24-hour forecast as a glow
along the screen edges.

## License

MIT. See `LICENSE`.
