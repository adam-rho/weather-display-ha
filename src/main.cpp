// weather_display -- ESP32 + WS2812B (48 LEDs), HA-fed via MQTT.
//
// Layout (snaked strip):
//   Top row    LEDs  0..23  (physically L->R) = temperature, hour h at LED h
//   Bottom row LEDs 24..47  (physically R->L) = precipitation, hour h at LED (47 - h)
//
// Overlays:
//   breathing  -> "now" cells (LED 0 + LED 47) pulse with a sine envelope
//   lightning  -> precip LEDs of lightning hours hold storm-blue + flash amber
//
// MQTT (retained, published by HA every 15 min):
//   weather/hourly  {"h":[[temp_bucket, cond_code, intensity], ... 24 entries]}
//
// HA just classifies. All color logic lives in this file (see PALETTES below).

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
#define BRIGHTNESS  140       // overall ceiling, 0-255
CRGB leds[NUM_LEDS];

inline uint8_t tempLed(uint8_t hour)   { return hour; }            // 0..23 LTR
inline uint8_t precipLed(uint8_t hour) { return 47 - hour; }       // snake-reversed

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

// --- Condition codes (matches HA-side enum; keep in sync) ---
enum Condition {
  COND_UNKNOWN          = 0,
  COND_SUNNY            = 1,
  COND_CLEAR_NIGHT      = 2,
  COND_PARTLYCLOUDY     = 3,
  COND_CLOUDY           = 4,
  COND_FOG              = 5,
  COND_WINDY            = 6,
  COND_EXCEPTIONAL      = 7,
  COND_RAINY            = 8,
  COND_SNOWY            = 9,
  COND_SNOWY_RAINY      = 10,
  COND_HAIL             = 11,
  COND_LIGHTNING        = 12,
  COND_LIGHTNING_RAINY  = 13,
};

// Atmospheric (non-precip) palette. Precip conditions (rainy/snowy/etc) ignore
// these entries and use the precip-intensity ramp below.
const CRGB CONDITION_PALETTE[] = {
  CRGB(  0,   0,   0),   // 0  unknown        off
  CRGB(255, 180,  20),   // 1  sunny          saturated gold
  CRGB( 10,  10,  80),   // 2  clear-night    navy
  CRGB( 90, 100, 120),   // 3  partlycloudy   cool blue-gray
  CRGB( 40,  45,  55),   // 4  cloudy         dim cool gray
  CRGB(160, 170, 180),   // 5  fog            pale gray-white
  CRGB( 40, 200, 180),   // 6  windy          teal
  CRGB(255,  40,   0),   // 7  exceptional    red alert
  CRGB(  0,   0,   0),   // 8  rainy          (uses precip ramp)
  CRGB(  0,   0,   0),   // 9  snowy          (uses snow color)
  CRGB(  0,   0,   0),   // 10 snowy-rainy    (uses severe color)
  CRGB(  0,   0,   0),   // 11 hail           (uses severe color)
  CRGB(  0,   0,   0),   // 12 lightning      (uses precip ramp + flash)
  CRGB(  0,   0,   0),   // 13 lightning-rain (uses precip ramp + flash)
};
const uint8_t CONDITION_PALETTE_LEN = sizeof(CONDITION_PALETTE) / sizeof(CONDITION_PALETTE[0]);

// Precipitation INTENSITY ramp -- radar reflectivity style. HA buckets the
// NWS `precipitation` field (in/hr) into 0..6 and sends that index.
//   0  none / trace
//   1  light green    mist, drizzle, very light rain   (< 0.02 in/h)
//   2  dark green     steady light rain                (< 0.10 in/h)
//   3  yellow         moderate rain                    (< 0.30 in/h)
//   4  orange         heavy rain                       (< 0.60 in/h)
//   5  red            torrential, street flooding      (< 1.20 in/h)
//   6  pink/purple    extreme rate                     (>= 1.20 in/h)
const CRGB PRECIP_RAMP[] = {
  CRGB(  0,   0,   0),   // 0 none
  CRGB( 80, 255,  80),   // 1 light green
  CRGB(  0, 180,  20),   // 2 dark green
  CRGB(255, 220,   0),   // 3 yellow
  CRGB(255, 120,   0),   // 4 orange
  CRGB(255,  20,   0),   // 5 red
  CRGB(255,   0, 200),   // 6 pink/purple
};
const uint8_t PRECIP_RAMP_LEN = sizeof(PRECIP_RAMP) / sizeof(PRECIP_RAMP[0]);

// Snow + severe-mix base colors. Intensity scales their brightness.
const CRGB SNOW_COLOR  ( 60, 130, 255);   // pure blue
const CRGB SEVERE_COLOR(200,   0, 255);   // pink-purple for sleet / hail

// --- Overlay colors ---
const CRGB LIGHTNING_BOLT(255, 140, 0);  // amber flash overlay for storm hours

// ==============================================================
// END PALETTES
// ==============================================================

inline bool isLightning(uint8_t cond) {
  return cond == COND_LIGHTNING || cond == COND_LIGHTNING_RAINY;
}

CRGB tempColor(uint8_t bucket) {
  if (bucket >= TEMP_PALETTE_LEN) return CRGB::Black;
  return TEMP_PALETTE[bucket];
}

// Brightness scaling for snow/severe types (intensity 1..6 -> dim..bright).
inline uint8_t intensityBrightness(uint8_t intensity) {
  if (intensity == 0) return 0;
  if (intensity >= 6) return 255;
  return 80 + (intensity * 30);  // 1->110, 2->140, ... 5->230
}

CRGB precipColor(uint8_t cond, uint8_t intensity) {
  // Clamp intensity to ramp range
  if (intensity >= PRECIP_RAMP_LEN) intensity = PRECIP_RAMP_LEN - 1;

  switch (cond) {
    case COND_RAINY:
    case COND_LIGHTNING_RAINY:
      return PRECIP_RAMP[intensity];

    case COND_LIGHTNING:
      // Pure lightning (no rain). Give the flash something to land on by
      // forcing the floor to at least light-green; otherwise use the ramp.
      return PRECIP_RAMP[intensity == 0 ? 1 : intensity];

    case COND_SNOWY: {
      uint8_t bri = intensityBrightness(intensity);
      if (bri == 0) return CRGB::Black;
      CRGB c = SNOW_COLOR;
      c.nscale8(bri);
      return c;
    }

    case COND_SNOWY_RAINY:
    case COND_HAIL: {
      uint8_t bri = intensityBrightness(intensity);
      if (bri == 0) return CRGB::Black;
      CRGB c = SEVERE_COLOR;
      c.nscale8(bri);
      return c;
    }

    default:
      // Non-precip: atmospheric palette
      if (cond < CONDITION_PALETTE_LEN) return CONDITION_PALETTE[cond];
      return CRGB::Black;
  }
}

// ---------- mode / forecast state ----------
enum Mode { MODE_FORECAST, MODE_DEMO };
Mode currentMode = MODE_FORECAST;

struct Hour { uint8_t tempBucket; uint8_t cond; uint8_t intensity; };
Hour hourly[24];
bool anyLightning  = false;
bool gotFirstFrame = false;

// ---------- net ----------
WiFiClient   net;
PubSubClient mqtt(net);

// ---------- helpers ----------
void renderForecast() {
  for (uint8_t h = 0; h < 24; h++) {
    leds[tempLed(h)]   = tempColor(hourly[h].tempBucket);
    leds[precipLed(h)] = precipColor(hourly[h].cond, hourly[h].intensity);
  }
}

// Demo mode: paints the full palette across the strip so you can see every
// color side by side. Top row = TEMP_PALETTE, 3 LEDs per bucket (8 * 3 = 24).
// Bottom row = PRECIP_RAMP[0..6] then snow, severe (snowy-rainy/hail),
// lightning-rainy + pure lightning samples, then atmospheric non-precip
// colors. The hour-slot at each position lets the lightning flash overlay
// hit the right LED in demo mode.
struct DemoSlot { uint8_t cond; uint8_t intensity; };
const DemoSlot DEMO_SLOTS[] = {
  { COND_RAINY,           0 },  // 0  none/trace          (off)
  { COND_RAINY,           1 },  // 1  light green
  { COND_RAINY,           2 },  // 2  dark green
  { COND_RAINY,           3 },  // 3  yellow
  { COND_RAINY,           4 },  // 4  orange
  { COND_RAINY,           5 },  // 5  red
  { COND_RAINY,           6 },  // 6  pink/purple extreme
  { COND_SNOWY,           4 },  // 7  snow
  { COND_SNOWY_RAINY,     4 },  // 8  sleet (severe)
  { COND_HAIL,            4 },  // 9  hail  (severe)
  { COND_LIGHTNING_RAINY, 3 },  // 10 lightning-rainy + flash
  { COND_LIGHTNING,       0 },  // 11 pure lightning + flash
  { COND_SUNNY,           0 },  // 12 sunny
  { COND_CLEAR_NIGHT,     0 },  // 13 clear-night
  { COND_PARTLYCLOUDY,    0 },  // 14 partlycloudy
  { COND_CLOUDY,          0 },  // 15 cloudy
  { COND_FOG,             0 },  // 16 fog
  { COND_WINDY,           0 },  // 17 windy
  { COND_EXCEPTIONAL,     0 },  // 18 exceptional
  { COND_UNKNOWN,         0 },  // 19 unknown (off)
};
const uint8_t DEMO_SLOTS_LEN = sizeof(DEMO_SLOTS) / sizeof(DEMO_SLOTS[0]);

void renderDemo() {
  fill_solid(leds, NUM_LEDS, CRGB::Black);

  // Temperature gradient across the top row, painted left to right
  // in palette order: bucket 0 at LEDs 0-2, bucket 1 at LEDs 3-5, etc.
  for (uint8_t i = 0; i < TEMP_PALETTE_LEN && i < 8; i++) {
    for (uint8_t k = 0; k < 3; k++) {
      leds[i * 3 + k] = TEMP_PALETTE[i];
    }
  }

  // Precip/condition demo across the bottom row from the "now" position.
  // Also load the demo slots into hourly[] so applyLightning() picks up the
  // lightning slots for the flash overlay.
  for (uint8_t i = 0; i < DEMO_SLOTS_LEN && i < 24; i++) {
    leds[precipLed(i)] = precipColor(DEMO_SLOTS[i].cond, DEMO_SLOTS[i].intensity);
  }
}

void applyBreathing() {
  // 2.4s breath cycle on the two "now" cells (top-left + bottom-left after snake)
  float phase = (millis() % 2400) / 2400.0f;
  float env   = 0.5f * (1.0f - cosf(phase * 2.0f * PI));  // 0..1
  uint8_t mul = 80 + (uint8_t)(env * 175);                 // floor 80, ceiling 255
  leds[tempLed(0)].nscale8(mul);
  leds[precipLed(0)].nscale8(mul);
}

// Thunderbolt envelope. Period = LIGHTNING_PERIOD_MS. Within each period,
// the first LIGHTNING_DURATION ms run a multi-flash sequence; for the
// remainder, lightning LEDs just show their storm-blue base.
#define LIGHTNING_PERIOD_MS  5000
#define LIGHTNING_DURATION    320

struct LK { uint16_t t; uint8_t v; };
const LK lightningEnv[] = {
  {   0,   0 },
  {   8, 255 },   // primary stroke up
  {  40, 255 },   // hold at peak
  {  90,  20 },   // fast decay
  { 110, 220 },   // secondary stroke
  { 140, 220 },
  { 180,  10 },
  { 210, 120 },   // faint tertiary echo
  { 240,  10 },
  { 320,   0 },
};
const uint8_t lightningEnvLen = sizeof(lightningEnv) / sizeof(lightningEnv[0]);

uint8_t lightningIntensity(uint32_t tMs) {
  if (tMs >= LIGHTNING_DURATION) return 0;
  for (uint8_t i = 1; i < lightningEnvLen; i++) {
    if (tMs <= lightningEnv[i].t) {
      uint16_t t0 = lightningEnv[i - 1].t;
      uint16_t t1 = lightningEnv[i].t;
      int16_t  v0 = lightningEnv[i - 1].v;
      int16_t  v1 = lightningEnv[i].v;
      uint32_t span = t1 - t0;
      uint32_t off  = tMs - t0;
      return (uint8_t)((int32_t)v0 + ((v1 - v0) * (int32_t)off) / (int32_t)span);
    }
  }
  return 0;
}

void applyLightning() {
  // Always run in demo mode (so the demo flash visible). In forecast mode,
  // only run if any forecast hour is flagged.
  if (currentMode == MODE_FORECAST && !anyLightning) return;

  uint32_t phase = millis() % LIGHTNING_PERIOD_MS;
  if (phase >= LIGHTNING_DURATION) return;

  uint8_t v = lightningIntensity(phase);
  if (v == 0) return;

  // Blend amber over whatever color is currently on the LED (the precip-ramp
  // base for that lightning hour). v=0 -> all base, v=255 -> pure amber.
  if (currentMode == MODE_DEMO) {
    for (uint8_t i = 0; i < DEMO_SLOTS_LEN && i < 24; i++) {
      if (!isLightning(DEMO_SLOTS[i].cond)) continue;
      uint8_t pos = precipLed(i);
      leds[pos] = blend(leds[pos], LIGHTNING_BOLT, v);
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
  JsonArray h = doc["h"];
  for (uint8_t i = 0; i < 24 && i < h.size(); i++) {
    JsonArray e = h[i];
    hourly[i].tempBucket = e[0].as<uint8_t>();
    hourly[i].cond       = e[1].as<uint8_t>();
    hourly[i].intensity  = e[2].as<uint8_t>();
    if (isLightning(hourly[i].cond)) anyLightning = true;
  }
  gotFirstFrame = true;
  Serial.printf("mqtt: received forecast, anyLightning=%d\n", anyLightning);
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
    applyLightning();
  } else if (!gotFirstFrame) {
    // boot/idle indicator: dim breath on LED 0 until the first forecast arrives
    fill_solid(leds, NUM_LEDS, CRGB::Black);
    leds[0] = CHSV(160, 200, beatsin8(30, 10, 60));
  } else {
    renderForecast();
    applyBreathing();
    applyLightning();
  }

  FastLED.show();
  FastLED.delay(16);    // ~60fps
}
