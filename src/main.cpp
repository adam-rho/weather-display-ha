// weather_display -- ESP32 + WS2812B (48 LEDs), HA-fed via MQTT.
//
// Layout (snaked strip):
//   Top row    LEDs  0..23  (physically L->R) = temperature, hour h at LED h
//   Bottom row LEDs 24..47  (physically R->L) = precipitation, hour h at LED (47 - h)
//
// Overlays:
//   breathing  -> sunrise/sunset temp-row cells dip-and-recover once per 6s
//   wind       -> windy / windy-variant cells flow with Perlin-noise brightness
//   lightning  -> storm cells flash yellow over a rain base on a ~12.7s cycle
//
// MQTT (retained, published by HA every 15 min):
//   weather/hourly  {"h":[[temp_bucket, cond_code, is_night, precip_bucket, wind_bucket, temperature_f], ... 24 entries]}
//     - precip_bucket (0..10, optional): selects light/medium/heavy wet colors.
//     - wind_bucket   (0..8,  optional): scales the wind-shimmer amplitude.
//   Older 3-tuple payloads still render (precip/wind default to 0 = off, no crash).
//
// HA sends condition codes and normalized temperature. Color rules live in
// include/weather_colors.h.

#include <Arduino.h>
#include <FastLED.h>
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#include "secrets.h"
#include "weather_colors.h"
#include "display_engine.h"

// ---------- hardware ----------
#define NUM_LEDS    48
#define DATA_PIN    18
#define LED_TYPE    WS2812B
#define COLOR_ORDER GRB
#define BRIGHTNESS  255       // overall ceiling, 0-255
CRGB leds[NUM_LEDS];

// Physical layout (after final wall mount): LED 0 is bottom-left, the strip
// snakes up at the right edge, and LED 47 is top-left. So:
//   bottom row (precip):   LEDs 0..23  L->R    hour h at LED h
//   top row    (temp):     LEDs 24..47 R->L    hour h at LED (47 - h)
inline uint8_t tempLed(uint8_t hour)   { return 47 - hour; }       // snake-reversed (top)
inline uint8_t precipLed(uint8_t hour) { return hour; }            // 0..23 LTR (bottom)

// HA condition wire codes. Keep in sync with COND_MAP in the publisher and
// WeatherColors::conditionBucket; wire codes are not palette indices.
enum Condition {
  COND_UNKNOWN          = 0,
  COND_SUNNY            = 1,
  COND_CLEAR_NIGHT      = 2,
  COND_PARTLYCLOUDY     = 3,
  COND_CLOUDY           = 4,
  COND_WINDY            = 5,
  COND_WINDY_VARIANT    = 6,
  COND_FOG              = 7,
  COND_RAINY            = 8,
  COND_SNOWY            = 9,
  COND_SNOWY_RAINY      = 10,
  COND_LIGHTNING_RAINY  = 11,
  COND_EXCEPTIONAL      = 12,
  COND_HAIL             = 13,
};

// --- Overlay colors ---
const CRGB LIGHTNING_BOLT(255, 255,  56);  // pure yellow (FFFF38), tuned in the app's Animation Lab

// ==============================================================
// END PALETTES
// ==============================================================

inline bool isLightning(uint8_t cond) {
  return cond == COND_LIGHTNING_RAINY;
}

inline bool isWindy(uint8_t cond) {
  return cond == COND_WINDY || cond == COND_WINDY_VARIANT;
}

CRGB condColor(uint8_t cond) {
  return CRGB(WeatherColors::condition(cond));
}

// ---------- mode / forecast state ----------
enum Mode { MODE_FORECAST, MODE_DEMO };
Mode currentMode = MODE_FORECAST;

struct Hour {
  CRGB temperatureColor;
  uint8_t cond;
  uint8_t isNight;
  uint8_t precipBucket;   // 0..10, 0 = no data -> unmodified condition color
  uint8_t windBucket;     // 0..8,  0 = calm / no data      -> no shimmer amp scaling
};
Hour hourly[24];

// Amplitude scale factor d in [0..1] derived from the wind bucket. Mirrors
// the reference's ampScale = 1.0 + 2.0*d formula in
// edgelight-weather-esp32/src/render.cpp applyWind, remapped from raw mph to
// the HA build's bucketed payload. Bucket 3 (~10-14 mph) is the windy
// threshold and gives d=0 (ampScale=1.0); bucket >=8 (>=50 mph) tops out at
// d=1.0 (ampScale=3.0).
inline float windAmpD(uint8_t bucket) {
  if (bucket < 3)  return 0.0f;
  if (bucket >= 8) return 1.0f;
  return (float)(bucket - 3) / 5.0f;
}

// Global brightness at night. Applied to the whole strip via
// FastLED.setBrightness() at sunset, restored to BRIGHTNESS at sunrise.
// Driven by hourly[0].isNight from the HA payload (flips at the hour
// boundary that contains sunrise/sunset).
#define NIGHT_BRIGHTNESS 128

// Sunrise/sunset hour indices, derived from the is_night transitions in the
// MQTT payload. -1 means "no transition found in the next 24h" (rare edge:
// polar conditions, or all 24 hours fall on the same side of the line).
int8_t sunriseIdx = -1;
int8_t sunsetIdx  = -1;
bool anyLightning  = false;
bool anyWindy      = false;
bool gotFirstFrame = false;

// ---------- net ----------
WiFiClient   net;
PubSubClient mqtt(net);
Display::Device displayDevice;
Preferences displayStorage;
JsonDocument displayForecast;
bool displayStorageReady = false;

bool publishJson(const char* topic, JsonVariantConst value, bool retained) {
  std::string payload;
  serializeJson(value, payload);
  return mqtt.publish(topic, payload.c_str(), retained);
}

void reportDisplay() {
  publishJson("weather/display/config/state", displayDevice.state(), true);
}

// ---------- helpers ----------
void renderForecast() {
  for (uint8_t h = 0; h < 24; h++) {
    // Temperature row always renders full-color -- temp reads the same day or
    // night. Night dim + blue tint apply only to the condition (bottom) row,
    // which is where the "white sea of cloudy" problem was.
    leds[tempLed(h)] = hourly[h].temperatureColor;
    leds[precipLed(h)] = CRGB(WeatherColors::condition(
        hourly[h].cond, hourly[h].precipBucket, hourly[h].isNight));
  }
}

// Demo mode: continuous temperature gradient on top, then 12 condition examples
// on the bottom (2 LEDs per condition), in enum order. Keeping conditions in
// fixed slots so the animation overlays know which LEDs to hit.
const uint8_t DEMO_COND[] = {
  COND_SUNNY,            // slot 0
  COND_CLEAR_NIGHT,      // slot 1
  COND_PARTLYCLOUDY,     // slot 2
  COND_CLOUDY,           // slot 3
  COND_WINDY,            // slot 4
  COND_WINDY_VARIANT,    // slot 5
  COND_FOG,              // slot 6
  COND_RAINY,            // slot 7
  COND_SNOWY,            // slot 8
  COND_SNOWY_RAINY,      // slot 9
  COND_LIGHTNING_RAINY,  // slot 10
  COND_HAIL,             // slot 11
};
const uint8_t DEMO_COND_LEN = sizeof(DEMO_COND) / sizeof(DEMO_COND[0]);

// LEDs occupied by demo slot i: precipLed(i*2) and precipLed(i*2+1).
inline uint8_t demoLedA(uint8_t slot) { return precipLed(slot * 2); }
inline uint8_t demoLedB(uint8_t slot) { return precipLed(slot * 2 + 1); }

void renderDemo() {
  fill_solid(leds, NUM_LEDS, CRGB::Black);

  // Continuous 0..90°F ramp, matching Android's default temperature scale.
  for (uint8_t h = 0; h < 24; h++) {
    leds[tempLed(h)] = CRGB(WeatherColors::temperature(90.0f * h / 23));
  }

  // Twelve conditions across the bottom row (2 LEDs each = 24 LEDs).
  for (uint8_t i = 0; i < DEMO_COND_LEN; i++) {
    CRGB c = condColor(DEMO_COND[i]);
    leds[demoLedA(i)] = c;
    leds[demoLedB(i)] = c;
  }
}

void applyBreathing() {
  // Rest-full, dip-and-recover (shared curve with the app's BreathingParams +
  // the esp32 firmware -- keep in sync): the sunrise/sunset LEDs sit at their
  // normal temp color and, once per 6s, do a single 3s gentle dip to ~40%
  // brightness and back, then hold at full for 3s. minMul 102 = 0.4 * 255.
  if (sunriseIdx < 0 && sunsetIdx < 0) return;
  uint32_t t = millis() % 6000;
  uint8_t mul;
  if (t >= 3000) {
    mul = 255;                                              // hold at full
  } else {
    float phase = t / 3000.0f;
    float env   = 0.5f * (1.0f - cosf(phase * 2.0f * PI));  // 0 -> 1 -> 0
    mul = 255 - (uint8_t)(env * (255 - 102));               // dip full -> 40% -> full
  }
  if (sunriseIdx >= 0) leds[tempLed(sunriseIdx)].nscale8(mul);
  if (sunsetIdx  >= 0) leds[tempLed(sunsetIdx)].nscale8(mul);
}

// Wind animation: Perlin-noise-driven brightness modulation. Each affected
// LED gets its own noise value computed from position + slow time, so the
// effect looks like a continuous gust traveling along the strip rather than
// uniform pulsing.
void applyWind() {
  if (currentMode == MODE_FORECAST && !anyWindy) return;

  // FastLED inoise8 typically returns values clustered in ~70..180. We
  // amplify around the midpoint so the visible brightness swing is large
  // enough to read as motion, then clamp to a 30..255 range so the base
  // color never fully disappears. Amplitude also scales with wind bucket:
  // at d=0 (low wind) the base (n-128)*3 stretch is preserved, and at d=1
  // (>=50 mph) it triples, so 40+ mph hours shimmer visibly harder than
  // 10-15 mph hours.
  uint16_t tMs = millis() >> 2;  // ~250 noise-steps/sec, ~1s gust period

  auto modulate = [&](uint8_t ledIdx, float d) {
    int   n       = (int)inoise8((uint16_t)ledIdx * 320, tMs);
    float ampMul  = 1.0f + 2.0f * d;      // 1.0x at low wind, 3.0x at 40+ mph
    int   amp     = (int)((n - 128) * 3 * ampMul);
    int   mul     = 140 + amp;
    if (mul < 30)  mul = 30;
    if (mul > 255) mul = 255;
    leds[ledIdx].nscale8((uint8_t)mul);
  };

  if (currentMode == MODE_DEMO) {
    // Demo slots don't carry a wind bucket -- use d=0.5 (midrange, ~2.0x amp)
    // matching the reference's legacy isWindy-only demo behavior.
    for (uint8_t i = 0; i < DEMO_COND_LEN; i++) {
      if (!isWindy(DEMO_COND[i])) continue;
      modulate(demoLedA(i), 0.5f);
      modulate(demoLedB(i), 0.5f);
    }
    return;
  }

  for (uint8_t h = 0; h < 24; h++) {
    uint8_t wb = hourly[h].windBucket;
    // Windy trigger: condition is windy OR wind bucket >= 3 (~10 mph).
    // Mirrors the reference's (isWindy || windMph >= 12) translated to
    // buckets.
    bool windy = isWindy(hourly[h].cond) || wb >= 3;
    if (!windy) continue;
    // If we only have the cond signal (bucket < 3), fall back to d=0.5 to
    // preserve the pre-v3 fixed-amplitude behavior on legacy 3-tuple payloads.
    float d = (wb >= 3) ? windAmpD(wb) : 0.5f;
    modulate(precipLed(h), d);
  }
}

// Lightning envelope (shared curve with the app's LightningParams + the esp32
// firmware -- keep in sync). Each 12702ms cycle: 10s quiet, then a 2702ms flash
// window split into rumble 533 / build 259 / peak-hold 312 / 4 flicker cycles
// over 1021 / decay 577.
#define LIGHTNING_PERIOD_MS    12702
#define LIGHTNING_DURATION      2702   // length of the active flash window
#define LIGHTNING_QUIET_MS    (LIGHTNING_PERIOD_MS - LIGHTNING_DURATION)

// Blend amount 0..255 -- 0 = pure base color, 255 = pure LIGHTNING_BOLT.
uint8_t lightningIntensity(uint32_t t) {
  if (t < 533) {                                 // rumble: base 127 + noise, clamp [30..150]
    int base  = 127;
    int noise = (int)inoise8((uint16_t)(t * 8)) - 128;
    int v     = base + noise / 3;
    if (v < 30)  v = 30;
    if (v > 150) v = 150;
    return (uint8_t)v;
  }
  if (t < 792)  return 120 + (uint8_t)((t - 533) * 135 / 259);   // build 120 -> 255
  if (t < 1104) return 255;                                      // peak hold (main strike)
  if (t < 2125) {                                                // flicker: 4 cycles, len 255
    uint32_t off = t - 1104, cycle = off / 255, in = off - cycle * 255;
    if (in < 127) return 255 - (uint8_t)(in * (255 - 51) / 127);
    return 51 + (uint8_t)((in - 127) * (255 - 51) / 128);
  }
  if (t < 2702) {                                                // decay 180 -> 0 + noise
    int progress = (int)(t - 2125);
    int base     = 180 - (progress * 180 / 577);
    int noise    = (int)inoise8((uint16_t)(t * 8)) - 128;
    int v        = base + noise / 4;
    if (v < 0)   v = 0;
    if (v > 255) v = 255;
    return (uint8_t)v;
  }
  return 0;
}

void applyLightning() {
  // Demo always runs the flash (so it's visible during palette inspection).
  // Forecast mode only runs if at least one hour is a storm.
  if (currentMode == MODE_FORECAST && !anyLightning) return;

  uint32_t phase = millis() % LIGHTNING_PERIOD_MS;
  if (phase < LIGHTNING_QUIET_MS) return;       // still in the 10s quiet stretch
  uint32_t tFlash = phase - LIGHTNING_QUIET_MS; // 0..2702 ms within the flash

  uint8_t v = lightningIntensity(tFlash);
  if (v == 0) return;

  // Blend amber over the cell's current color. v=0 -> all base, v=255 -> pure amber.
  if (currentMode == MODE_DEMO) {
    for (uint8_t i = 0; i < DEMO_COND_LEN; i++) {
      if (!isLightning(DEMO_COND[i])) continue;
      leds[demoLedA(i)] = blend(leds[demoLedA(i)], LIGHTNING_BOLT, v);
      leds[demoLedB(i)] = blend(leds[demoLedB(i)], LIGHTNING_BOLT, v);
    }
    return;
  }

  for (uint8_t h = 0; h < 24; h++) {
    if (!isLightning(hourly[h].cond)) continue;
    uint8_t pos = precipLed(h);
    leds[pos] = blend(leds[pos], LIGHTNING_BOLT, v);
  }
}

// ---------- MQTT ----------
void onMqtt(char* topic, byte* payload, unsigned int len) {
  if (!strcmp(topic, "weather/display/config/set")) {
    JsonDocument command;
    if (deserializeJson(command, payload, len)) return;
    auto reply = displayDevice.apply(command, [](const std::string& saved) {
      return displayStorageReady && displayStorage.putString("settings", saved.c_str()) == saved.size();
    });
    reportDisplay();
    publishJson("weather/display/config/result", reply, false);
    return;
  }
  // Mode-switch topic: payload is "demo" or "forecast" (no JSON)
  if (!strcmp(topic, "weather/display/mode")) {
    char buf[32] = {0};
    unsigned int n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
    memcpy(buf, payload, n);
    if (!strcmp(buf, "demo")) {
      currentMode = MODE_DEMO;
      Serial.println("mode: demo");
    } else if (!strcmp(buf, "forecast")) {
      currentMode = MODE_FORECAST;
      Serial.println("mode: forecast");
    } else {
      Serial.printf("mode: unknown payload '%s'\n", buf);
    }
    return;
  }

  if (strcmp(topic, "weather/hourly")) return;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    Serial.printf("mqtt: json parse failed: %s\n", err.c_str());
    return;
  }
  if (!doc["h"].is<JsonArray>() || doc["h"].size() != 24) return;
  for (JsonVariantConst hour : doc["h"].as<JsonArrayConst>()) {
    if (!hour.is<JsonArrayConst>() || hour.size() < 2) return;
  }
  displayForecast.set(doc);

  anyLightning = false;
  anyWindy     = false;
  JsonArray h = doc["h"];
  for (uint8_t i = 0; i < 24 && i < h.size(); i++) {
    JsonArray e = h[i];
    // Sixth field is normalized °F. Explicit null means missing; absent means
    // a retained legacy payload, whose first-field temperature bucket still works.
    hourly[i].temperatureColor = CRGB(WeatherColors::forecastTemperature(e));
    hourly[i].cond         = e[1].as<uint8_t>();
    // is_night is optional (3rd tuple element). Defaults to 0 for backward
    // compatibility with older 2-tuple retained payloads.
    hourly[i].isNight      = (e.size() >= 3) ? e[2].as<uint8_t>() : 0;
    // precip_bucket (0..10) and wind_bucket (0..8) are optional 4th/5th tuple
    // elements. Default to 0 for older 3-tuple payloads -- 0 means "no data",
    // which the render path treats as "no brightness scaling / no shimmer
    // amp scaling". Legacy categories use the updated palette.
    hourly[i].precipBucket = (e.size() >= 4) ? e[3].as<uint8_t>() : 0;
    hourly[i].windBucket   = (e.size() >= 5) ? e[4].as<uint8_t>() : 0;
    if (isLightning(hourly[i].cond)) anyLightning = true;
    // Drive the wind animation when the condition is windy OR the bucketed
    // wind speed exceeds the ~10 mph threshold. Matches applyWind()'s trigger.
    if (isWindy(hourly[i].cond) || hourly[i].windBucket >= 3) anyWindy = true;
  }
  // Locate the next sunrise (night -> day) and sunset (day -> night) in the
  // forecast. We compare each hour to the previous one, so h=0 transitions
  // can't be detected -- but the breathing animation just shows nothing for
  // that single tick, which is fine.
  sunriseIdx = -1;
  sunsetIdx  = -1;
  for (uint8_t h = 1; h < 24; h++) {
    if (sunriseIdx < 0 && hourly[h - 1].isNight && !hourly[h].isNight) sunriseIdx = h;
    if (sunsetIdx  < 0 && !hourly[h - 1].isNight && hourly[h].isNight) sunsetIdx  = h;
    if (sunriseIdx >= 0 && sunsetIdx >= 0) break;
  }

  gotFirstFrame = true;
  Serial.printf("mqtt: received forecast, windy=%d lightning=%d sunrise=%d sunset=%d\n",
                anyWindy, anyLightning, sunriseIdx, sunsetIdx);

  // Debug echo back to the broker so we can verify what the device actually
  // computed without needing the USB serial line.
  char dbg[128];
  snprintf(dbg, sizeof(dbg),
           "{\"sunrise\":%d,\"sunset\":%d,\"windy\":%d,\"lightning\":%d}",
           sunriseIdx, sunsetIdx, anyWindy ? 1 : 0, anyLightning ? 1 : 0);
  mqtt.publish("weather/display/debug", dbg, true);
}

void ensureMqtt() {
  if (mqtt.connected()) return;
  Serial.print("mqtt: connecting... ");
  if (mqtt.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS,
                   "weather/display/availability", 1, true, "offline")) {
    Serial.println("ok");
    mqtt.subscribe("weather/hourly");
    mqtt.subscribe("weather/display/mode");
    mqtt.subscribe("weather/display/config/set");
    reportDisplay();
    mqtt.publish("weather/display/availability", "online", true);
  } else {
    Serial.printf("failed, state=%d\n", mqtt.state());
    delay(2000);
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("wifi: connecting to ");
  Serial.print(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print('.');
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" ok, ip=");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(" timeout");
  }
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  delay(200);

  FastLED.addLeds<LED_TYPE, DATA_PIN, COLOR_ORDER>(leds, NUM_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  fill_solid(leds, NUM_LEDS, CRGB::Black);
  FastLED.show();

  ensureWifi();

  displayStorageReady = displayStorage.begin("edgelight", false);
  if (displayStorageReady) displayDevice.restore(displayStorage.getString("settings", "").c_str());

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
  mqtt.setBufferSize(8192);

  // ---- OTA (ArduinoOTA over WiFi) ----
  ArduinoOTA.setHostname("weather-display");
  // Optional: protect with a password. Match upload_flags in platformio.ini.
  // ArduinoOTA.setPassword("change-me");
  ArduinoOTA.onStart([]() {
    Serial.println("ota: start");
    // Blank the strip so we don't fight FastLED during the flash.
    fill_solid(leds, NUM_LEDS, CRGB::Black);
    FastLED.show();
  });
  ArduinoOTA.onEnd([]() { Serial.println("\nota: end"); });
  ArduinoOTA.onProgress([](unsigned int p, unsigned int t) {
    Serial.printf("ota: %u%%\r", (p * 100) / t);
  });
  ArduinoOTA.onError([](ota_error_t e) {
    Serial.printf("ota: error %u\n", e);
  });
  ArduinoOTA.begin();
  Serial.println("ota: ready");
}

// Output gamma correction (device-only). WS2812B strips are ~linear in PWM
// duty, but every color here -- the HA config palette, condition colors, the
// display engine's interpolated stops -- is authored in sRGB. Feeding sRGB
// straight to a linear strip over-drives each channel's low end, so saturated
// colors wash toward white (red reads salmon, deep yellow near-white). Fix:
// linearize the whole frame once, right before FastLED.show(). The sRGB display
// engine (include/weather_colors.h) and the app editor preview stay untouched,
// so WYSIWYG holds; only the bytes clocked to the strip are corrected.
// GAMMA8[i] = round(255 * sRGB_to_linear(i/255)), the exact inverse of the
// sRGB encoding used to author the palette.
static const uint8_t GAMMA8[256] = {
  0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7,
  8, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 12, 12, 12, 13,
  13, 13, 14, 14, 15, 15, 16, 16, 17, 17, 17, 18, 18, 19, 19, 20,
  20, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 27, 27, 28, 29, 29,
  30, 30, 31, 32, 32, 33, 34, 35, 35, 36, 37, 37, 38, 39, 40, 41,
  41, 42, 43, 44, 45, 45, 46, 47, 48, 49, 50, 51, 51, 52, 53, 54,
  55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70,
  71, 72, 73, 74, 76, 77, 78, 79, 80, 81, 82, 84, 85, 86, 87, 88,
  90, 91, 92, 93, 95, 96, 97, 99, 100, 101, 103, 104, 105, 107, 108, 109,
  111, 112, 114, 115, 116, 118, 119, 121, 122, 124, 125, 127, 128, 130, 131, 133,
  134, 136, 138, 139, 141, 142, 144, 146, 147, 149, 151, 152, 154, 156, 157, 159,
  161, 163, 164, 166, 168, 170, 171, 173, 175, 177, 179, 181, 183, 184, 186, 188,
  190, 192, 194, 196, 198, 200, 202, 204, 206, 208, 210, 212, 214, 216, 218, 220,
  222, 224, 226, 229, 231, 233, 235, 237, 239, 242, 244, 246, 248, 250, 253, 255,
};
static inline void applyGamma(CRGB* px, int n) {
  for (int i = 0; i < n; ++i) {
    px[i].r = GAMMA8[px[i].r];
    px[i].g = GAMMA8[px[i].g];
    px[i].b = GAMMA8[px[i].b];
  }
}

void loop() {
  ensureWifi();
  ArduinoOTA.handle();
  ensureMqtt();
  mqtt.loop();

  if (currentMode == MODE_DEMO) {
    renderDemo();
    applyWind();
    applyLightning();
  } else if (!gotFirstFrame) {
    // boot/idle indicator: dim breath on LED 0 until the first forecast arrives
    fill_solid(leds, NUM_LEDS, CRGB::Black);
    leds[tempLed(0)] = CHSV(160, 200, beatsin8(30, 10, 60));
  } else {
    auto frame = displayDevice.render(displayForecast, millis());
    for (int i = 0; i < 48; ++i) leds[i] = CRGB(frame[i]);
  }

  // Day/night global brightness. Forecast mode only; demo stays at full.
  uint8_t target = BRIGHTNESS;
  // Forecast renderer already includes the user's global brightness.
  FastLED.setBrightness(target);

  applyGamma(leds, NUM_LEDS);
  FastLED.show();
  FastLED.delay(16);    // ~60fps
}
