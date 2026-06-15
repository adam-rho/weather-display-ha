// weather_display -- ESP32 + WS2812B (48 LEDs), HA-fed via MQTT.
//
// Layout (snaked strip):
//   Top row    LEDs  0..23  (physically L->R) = temperature, hour h at LED h
//   Bottom row LEDs 24..47  (physically R->L) = precipitation, hour h at LED (47 - h)
//
// Overlays:
//   breathing  -> "now" cells (LED 0 + LED 47) pulse with a sine envelope
//   wind       -> windy / windy-variant cells flow with Perlin-noise brightness
//   lightning  -> lightning-rainy cells flash amber every ~5s
//
// MQTT (retained, published by HA every 15 min):
//   weather/hourly  {"h":[[temp_bucket, cond_code], ... 24 entries]}
//
// Condition codes match the HA NWS integration's twelve possible outputs.
// HA only classifies. All color logic lives in this file (see PALETTES below).

#include <Arduino.h>
#include <FastLED.h>
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#include "secrets.h"

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

// ==============================================================
// PALETTES -- single source of truth for all weather colors.
// Tune these and reflash. HA only sends category indices.
// ==============================================================

// --- Temperature buckets (matches HA-side bucketer; keep in sync) ---
// Bucket | Range (°F)
//   0    | no data
//   1    | < 20    deep cold
//   2    | 20-31   cold
//   3    | 32-49   cool
//   4    | 50-64   mild
//   5    | 65-77   warm
//   6    | 78-89   hot
//   7    | 90+     very hot
const CRGB TEMP_PALETTE[] = {
  CRGB(0x00, 0x00, 0x00),   // 0  no data
  CRGB(0x00, 0x00, 0x80),   // 1  <20    deep navy
  CRGB(0x00, 0x40, 0xFF),   // 2  20-31  cold blue
  CRGB(0x40, 0xC8, 0xFF),   // 3  32-49  cool cyan
  CRGB(0xFF, 0xD8, 0x80),   // 4  50-64  warm pale
  CRGB(0xFF, 0xC8, 0x00),   // 5  65-77  amber
  CRGB(0xFF, 0x40, 0x00),   // 6  78-89  red-orange
  CRGB(0xFF, 0x00, 0x00),   // 7  90+    pure red
};
const uint8_t TEMP_PALETTE_LEN = sizeof(TEMP_PALETTE) / sizeof(TEMP_PALETTE[0]);

// --- Condition codes ---
// Twelve real outputs of the HA NWS integration (plus 0 = unknown).
// `pouring`, `lightning` (bare), and `hail` are intentionally omitted -- NWS
// never emits them through this integration. Keep this enum in lockstep with
// COND_MAP in /config/python_scripts/weather_display_publish.py.
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
};

const CRGB CONDITION_PALETTE[] = {
  CRGB(  0,   0,   0),   // 0  unknown        off
  CRGB(235, 186,  52),   // 1  sunny          warm gold
  CRGB(32, 10, 73),   // 2  clear-night    deep purple
  CRGB(174, 184, 132),   // 3  partlycloudy   pale teal
  CRGB(181, 181, 181),   // 4  cloudy         neutral gray
  CRGB(235, 186,  52),   // 5  windy          warm gold + wind anim
  CRGB( 32, 181, 184),   // 6  windy-variant  teal + wind anim
  CRGB(107, 230, 255),   // 7  fog            icy cyan
  CRGB(0, 255, 12),   // 8  rainy          radar green
  CRGB(0, 120, 247),   // 9  snowy          electric blue
  CRGB( 12, 245, 191),   // 10 snowy-rainy    mint
  CRGB( 50, 237, 106),   // 11 lightning-rainy radar green + lightning anim
  CRGB(230, 21, 21),   // 12 exceptional    alert red
};
const uint8_t CONDITION_PALETTE_LEN = sizeof(CONDITION_PALETTE) / sizeof(CONDITION_PALETTE[0]);

// --- Overlay colors ---
const CRGB LIGHTNING_BOLT(224, 242, 24);  // yellow-green flash overlay

// ==============================================================
// END PALETTES
// ==============================================================

inline bool isLightning(uint8_t cond) {
  return cond == COND_LIGHTNING_RAINY;
}

inline bool isWindy(uint8_t cond) {
  return cond == COND_WINDY || cond == COND_WINDY_VARIANT;
}

CRGB tempColor(uint8_t bucket) {
  if (bucket >= TEMP_PALETTE_LEN) return CRGB::Black;
  return TEMP_PALETTE[bucket];
}

CRGB condColor(uint8_t cond) {
  if (cond >= CONDITION_PALETTE_LEN) return CRGB::Black;
  return CONDITION_PALETTE[cond];
}

// ---------- mode / forecast state ----------
enum Mode { MODE_FORECAST, MODE_DEMO };
Mode currentMode = MODE_FORECAST;

struct Hour { uint8_t tempBucket; uint8_t cond; uint8_t isNight; };
Hour hourly[24];

// Global brightness at night. Applied to the whole strip via
// FastLED.setBrightness() at sunset, restored to BRIGHTNESS at sunrise.
// Driven by hourly[0].isNight from the HA payload (flips at the hour
// boundary that contains sunrise/sunset).
#define NIGHT_BRIGHTNESS 128

// Night wash. After dimming, every night cell gets blended toward a cool
// moonlight blue so the strip reads as "night sky" instead of "dim gray
// with one purple LED". Higher NIGHT_TINT_AMT = more uniformly blue.
const CRGB NIGHT_TINT(15, 25, 70);
#define NIGHT_TINT_AMT 140  // 0-255 blend strength (~55%)

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

// ---------- helpers ----------
void renderForecast() {
  for (uint8_t h = 0; h < 24; h++) {
    // Temperature row always renders full-color -- temp reads the same day or
    // night. Night dim + blue tint apply only to the condition (bottom) row,
    // which is where the "white sea of cloudy" problem was.
    leds[tempLed(h)]   = tempColor(hourly[h].tempBucket);
    leds[precipLed(h)] = condColor(hourly[h].cond);
    if (hourly[h].isNight) {
      // Color identity only -- blend toward moonlight blue. Global
      // brightness is handled in loop() via FastLED.setBrightness().
      nblend(leds[precipLed(h)], NIGHT_TINT, NIGHT_TINT_AMT);
    }
  }
}

// Demo mode: temp gradient on top (3 LEDs per bucket), then the 12 conditions
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
  COND_EXCEPTIONAL,      // slot 11
};
const uint8_t DEMO_COND_LEN = sizeof(DEMO_COND) / sizeof(DEMO_COND[0]);

// LEDs occupied by demo slot i: precipLed(i*2) and precipLed(i*2+1).
inline uint8_t demoLedA(uint8_t slot) { return precipLed(slot * 2); }
inline uint8_t demoLedB(uint8_t slot) { return precipLed(slot * 2 + 1); }

void renderDemo() {
  fill_solid(leds, NUM_LEDS, CRGB::Black);

  // Temperature gradient across the top row, painted left to right in palette
  // order: bucket 0 at top-left, bucket 7 at top-right. tempLed() handles the
  // snake mapping so we just walk i*3+k as a logical 0..23 index.
  for (uint8_t i = 0; i < TEMP_PALETTE_LEN && i < 8; i++) {
    for (uint8_t k = 0; k < 3; k++) {
      leds[tempLed(i * 3 + k)] = TEMP_PALETTE[i];
    }
  }

  // Twelve conditions across the bottom row (2 LEDs each = 24 LEDs).
  for (uint8_t i = 0; i < DEMO_COND_LEN; i++) {
    CRGB c = condColor(DEMO_COND[i]);
    leds[demoLedA(i)] = c;
    leds[demoLedB(i)] = c;
  }
}

void applyBreathing() {
  // Pulse the temp-row LEDs at the upcoming sunrise and sunset hours so the
  // strip telegraphs when day breaks and when night falls. Big swing (near
  // black -> full) at ~1.6s cycle so the markers are unmistakable against
  // the static temperature row.
  if (sunriseIdx < 0 && sunsetIdx < 0) return;
  float phase = (millis() % 3000) / 3000.0f;
  float env   = 0.5f * (1.0f - cosf(phase * 2.0f * PI));   // 0..1
  uint8_t mul = 10 + (uint8_t)(env * 245);                  // floor 10, ceiling 255
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
  // color never fully disappears.
  uint16_t tMs = millis() >> 2;  // ~250 noise-steps/sec, ~1s gust period

  auto modulate = [&](uint8_t ledIdx) {
    int n   = (int)inoise8((uint16_t)ledIdx * 320, tMs);
    int amp = (n - 128) * 3;     // stretch the noise variance
    int mul = 140 + amp;
    if (mul < 30)  mul = 30;
    if (mul > 255) mul = 255;
    leds[ledIdx].nscale8((uint8_t)mul);
  };

  if (currentMode == MODE_DEMO) {
    for (uint8_t i = 0; i < DEMO_COND_LEN; i++) {
      if (!isWindy(DEMO_COND[i])) continue;
      modulate(demoLedA(i));
      modulate(demoLedB(i));
    }
    return;
  }

  for (uint8_t h = 0; h < 24; h++) {
    if (!isWindy(hourly[h].cond)) continue;
    modulate(precipLed(h));
  }
}

// Lightning envelope. Each 15s cycle is split into:
//   0..10000 ms : quiet (LED shows the storm base color)
//   10000..15000 ms : 5-second flash sequence
//
// The flash sequence has five phases:
//   A  0..1500 ms : rumble at ~40% blend, with noise jitter
//   B  1500..1700 ms : fast build to 100%
//   C  1700..2200 ms : hold at 100% (the big strike, 0.5s)
//   D  2200..3200 ms : three quick down-pulses to 20% and back
//   E  3200..5000 ms : noisy fade-out from ~70% down to 0%
#define LIGHTNING_PERIOD_MS    15000
#define LIGHTNING_DURATION      5000   // length of the active flash window
#define LIGHTNING_QUIET_MS    (LIGHTNING_PERIOD_MS - LIGHTNING_DURATION)

// Blend amount 0..255 -- 0 = pure base color, 255 = pure LIGHTNING_BOLT.
uint8_t lightningIntensity(uint32_t t) {
  // Phase A: rumble in around 40% blend (102/255), noise jitter
  if (t < 1500) {
    int base  = 102;
    int noise = (int)inoise8((uint16_t)(t * 8)) - 128;  // -128..+127
    int v     = base + noise / 3;
    if (v < 30)  v = 30;
    if (v > 150) v = 150;
    return (uint8_t)v;
  }

  // Phase B: fast build from ~120 to 255 over 200 ms
  if (t < 1700) {
    return 120 + (uint8_t)((t - 1500) * 135 / 200);
  }

  // Phase C: hold at peak for 500 ms (the main strike)
  if (t < 2200) return 255;

  // Phase D: three quick dip-and-recover pulses 100% -> 20% -> 100%
  // 1000 ms total, ~333 ms per cycle.
  if (t < 3200) {
    uint32_t off   = t - 2200;
    uint32_t cycle = off / 333;
    uint32_t in    = off - cycle * 333;
    // Triangle: 255 -> 51 (20%) at the midpoint, back to 255
    if (in < 166) {
      return 255 - (uint8_t)(in * (255 - 51) / 166);
    } else {
      return 51 + (uint8_t)((in - 166) * (255 - 51) / 167);
    }
  }

  // Phase E: noisy fade out from ~180 down to 0 over 1800 ms
  if (t < 5000) {
    int progress = (int)(t - 3200);   // 0..1800
    int base     = 180 - (progress * 180 / 1800);
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
  uint32_t tFlash = phase - LIGHTNING_QUIET_MS; // 0..5000 ms within the flash

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

  StaticJsonDocument<2048> doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    Serial.printf("mqtt: json parse failed: %s\n", err.c_str());
    return;
  }

  anyLightning = false;
  anyWindy     = false;
  JsonArray h = doc["h"];
  for (uint8_t i = 0; i < 24 && i < h.size(); i++) {
    JsonArray e = h[i];
    hourly[i].tempBucket = e[0].as<uint8_t>();
    hourly[i].cond       = e[1].as<uint8_t>();
    // is_night is optional (3rd tuple element). Defaults to 0 for backward
    // compatibility with older 2-tuple retained payloads.
    hourly[i].isNight    = (e.size() >= 3) ? e[2].as<uint8_t>() : 0;
    if (isLightning(hourly[i].cond)) anyLightning = true;
    if (isWindy(hourly[i].cond))     anyWindy     = true;
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
  if (mqtt.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS)) {
    Serial.println("ok");
    mqtt.subscribe("weather/hourly");
    mqtt.subscribe("weather/display/mode");
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

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
  mqtt.setBufferSize(2048);

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
    renderForecast();
    applyBreathing();
    applyWind();
    applyLightning();
  }

  // Day/night global brightness. Forecast mode only; demo stays at full.
  uint8_t target = BRIGHTNESS;
  if (currentMode == MODE_FORECAST && gotFirstFrame && hourly[0].isNight) {
    target = NIGHT_BRIGHTNESS;
  }
  FastLED.setBrightness(target);

  FastLED.show();
  FastLED.delay(16);    // ~60fps
}
