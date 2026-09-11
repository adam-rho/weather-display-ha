#include <cassert>
#include <cstdio>
#include <ArduinoJson.h>
#include "weather_colors.h"
using namespace WeatherColors;

int main(int argc, char**) {
    if (argc > 1) {
        for (int code : {8, 9, 10})
            for (int precip : {1, 4, 8})
                std::printf("%06x\n", unsigned(condition(code, precip)));
        return 0;
    }
    for (int i = 0; i < 7; ++i) assert(temperature(TEMP_STOPS[i]) == TEMP_PALETTE[i+1]);
    assert(temperature(-100) == 0x2D60C8);
    assert(temperature(150) == 0xCD2E39);
    assert(temperature(NAN) == 0);
    assert(temperature(60) != temperature(61));
    // Independent OKLCH reference used by Android's ColorStopScaleTest.
    uint32_t mid = interpolate(0x0000FF, 0xFFFF00, .5f);
    for (int shift : {0, 8, 16})
        assert(std::abs(int((mid >> shift) & 255) - int((0x00CFBD >> shift) & 255)) <= 1);
    for (int code : {0, 12, 255}) assert(condition(code, 10, true) == 0);
    for (int code : {1, 2, 3, 4, 5, 6, 7})
        assert(condition(code, 10) == condition(code, 0));
    assert(condition(1) == 0xFFD34E);
    assert(condition(2) == condition(1));
    assert(condition(3) == 0xC3B47A);
    assert(condition(4) == 0x8795A6);
    assert(condition(7) == 0xF2F4F5);
    assert(condition(13, 5) == condition(10, 5));
    for (int code : {8, 9, 10, 11, 13}) {
        assert(condition(code, 1) == condition(code, 3));
        assert(condition(code, 4) == condition(code, 7));
        assert(condition(code, 8) == condition(code, 10));
        assert(condition(code, 3) != condition(code, 4));
        assert(condition(code, 7) != condition(code, 8));
        assert(condition(code, 11) == condition(code, 0));
        assert(condition(code, 5, true) != condition(code, 5));
    }
    assert(condition(11, 5) == condition(8, 5));
    assert(condition(1, 0, true) == 0x5F512A); // dim then cool tint, rounded per channel
    for (const char* json : {"[4,1]", "[4,1,0]", "[4,1,0,0,0]"}) {
        JsonDocument doc;
        assert(!deserializeJson(doc, json));
        assert(forecastTemperature(doc.as<JsonArray>()) == 0xF2D36B);
    }
    for (const char* json : {"[4,1,0,0,0,50]", "[4,1,0,0,0,50.0]"}) {
        JsonDocument doc;
        assert(!deserializeJson(doc, json));
        assert(forecastTemperature(doc.as<JsonArray>()) == temperature(50));
    }
    for (const char* json : {"[4,1,0,0,0,null]", "[4,1,0,0,0,\"bad\"]", "[99,1]"}) {
        JsonDocument doc;
        assert(!deserializeJson(doc, json));
        assert(forecastTemperature(doc.as<JsonArray>()) == 0);
    }
}
