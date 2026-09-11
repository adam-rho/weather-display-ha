#pragma once
#include <cmath>
#include <cstdint>

// Android defaults: ColorStopStore, ColorStopScale, WeatherPalette and
// SkyColorComputer. Packed sRGB keeps this code testable without LED hardware.
namespace WeatherColors {
constexpr double PI_VALUE = 3.14159265358979323846;
constexpr int TEMP_STOPS[] = {0, 20, 32, 50, 65, 78, 90};
constexpr uint32_t TEMP_PALETTE[] = {
    0, 0x2D60C8, 0x5B8DEF, 0x74C7E8, 0xF2D36B, 0xF0974A, 0xE85D5D, 0xCD2E39
};
constexpr uint32_t CONDITION_PALETTE[] = {
    0, 0xFFD34E, 0xC3B47A, 0x8795A6, 0xF2F4F5, 0x43C47E, 0x9BE0E8, 0xA66BFF
};
inline uint8_t byte(double value) {
    return static_cast<uint8_t>(std::lround(value < 0 ? 0 : value > 255 ? 255 : value));
}
inline double linear(uint32_t color, int shift) {
    double c = ((color >> shift) & 255) / 255.0;
    return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4);
}
struct Oklch { double l, c, h; };
inline Oklch toOklch(uint32_t color) {
    double r = linear(color, 16), g = linear(color, 8), b = linear(color, 0);
    double l = std::cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
    double m = std::cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
    double s = std::cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
    double a = 1.9779984951*l - 2.4285922050*m + .4505937099*s;
    double bb = .0259040371*l + .7827717662*m - .8086757660*s;
    return {.2104542553*l + .7936177850*m - .0040720468*s,
            std::sqrt(a*a + bb*bb), std::atan2(bb, a)};
}
inline uint8_t srgb(double c) {
    return byte(255 * (c <= .0031308 ? 12.92*c : 1.055*std::pow(c, 1.0/2.4) - .055));
}
inline uint32_t interpolate(uint32_t from, uint32_t to, float amount) {
    Oklch a = toOklch(from), b = toOklch(to);
    double hueA = a.c < .0001 ? b.h : a.h;
    double hueB = b.c < .0001 ? hueA : b.h;
    double delta = std::fmod(hueB - hueA + PI_VALUE*3, PI_VALUE*2) - PI_VALUE;
    double lightness = a.l + (b.l-a.l)*amount;
    double chroma = a.c + (b.c-a.c)*amount;
    double hue = hueA + delta*amount;
    double aa = chroma*std::cos(hue), bb = chroma*std::sin(hue);
    double l = std::pow(lightness + .3963377774*aa + .2158037573*bb, 3);
    double m = std::pow(lightness - .1055613458*aa - .0638541728*bb, 3);
    double s = std::pow(lightness - .0894841775*aa - 1.2914855480*bb, 3);
    return (uint32_t(srgb(4.0767416621*l - 3.3077115913*m + .2309699292*s)) << 16) |
           (uint32_t(srgb(-1.2684380046*l + 2.6097574011*m - .3413193965*s)) << 8) |
           srgb(-.0041960863*l - .7034186147*m + 1.7076147010*s);
}
inline uint32_t temperature(float fahrenheit) {
    if (!std::isfinite(fahrenheit)) return 0;
    if (fahrenheit <= TEMP_STOPS[0]) return TEMP_PALETTE[1];
    for (int i = 1; i < 7; ++i) {
        if (fahrenheit == TEMP_STOPS[i]) return TEMP_PALETTE[i+1];
        if (fahrenheit < TEMP_STOPS[i])
            return interpolate(TEMP_PALETTE[i], TEMP_PALETTE[i+1],
                (fahrenheit-TEMP_STOPS[i-1]) / (TEMP_STOPS[i]-TEMP_STOPS[i-1]));
    }
    return TEMP_PALETTE[7];
}
inline uint32_t legacyTemperature(uint8_t bucket) {
    return bucket < 8 ? TEMP_PALETTE[bucket] : 0;
}
// Absent sixth field is legacy; explicit null is missing temperature.
template <typename JsonHour>
inline uint32_t forecastTemperature(JsonHour hour) {
    if (hour.size() < 6) return legacyTemperature(hour[0].template as<uint8_t>());
    return hour[5].template is<float>() ? temperature(hour[5].template as<float>()) : 0;
}
// Keep HA wire codes stable; only the seven visual categories are collapsed.
// Clear night/windy use Sunny; windy-variant uses Cloudy. Exceptional has no
// known sky category. Hail (new code 13) shares Sleet's frozen-mix color.
inline uint8_t conditionBucket(uint8_t code) {
    constexpr uint8_t buckets[] = {0, 1, 1, 2, 3, 1, 3, 4, 5, 6, 7, 5, 0, 7};
    return code < sizeof(buckets) ? buckets[code] : 0;
}
// SkyColorComputer's HSL levels: saturation 1/.73/.59, lightness .74/.38/.21.
// Precomputed for the fixed default rain, snow and sleet hues.
constexpr uint32_t WET_COLORS[][3] = {
    {0x7AFFB7, 0x1AA85B, 0x165533},
    {0x7AF1FF, 0x1A99A8, 0x164F55},
    {0xAF7AFF, 0x531AA8, 0x2F1655},
};
inline uint32_t condition(uint8_t code, uint8_t precip = 0, bool night = false) {
    uint8_t bucket = conditionBucket(code);
    if (!bucket) return 0;
    uint32_t color = CONDITION_PALETTE[bucket];
    if (bucket >= 5 && precip >= 1 && precip <= 10)
        color = WET_COLORS[bucket-5][precip <= 3 ? 0 : precip <= 7 ? 1 : 2];
    if (!night) return color;
    uint32_t result = 0;
    const int tint[] = {70, 25, 15};
    for (int i = 0; i < 3; ++i) {
        int dimmed = byte(((color >> (i*8)) & 255) * (115.0/255));
        result |= uint32_t(byte(dimmed + (tint[i]-dimmed)*(50.0/255))) << (i*8);
    }
    return result;
}
} // namespace WeatherColors
