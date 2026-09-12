#pragma once
#include <ArduinoJson.h>
#include <array>
#include <string>
#include <functional>
#include "weather_colors.h"

namespace Display {
using Frame = std::array<uint32_t, 48>;

inline std::string hex(uint32_t color) {
    char text[8];
    snprintf(text, sizeof(text), "#%06X", unsigned(color));
    return text;
}
inline uint32_t rgb(JsonVariantConst value) {
    const char* s = value.as<const char*>();
    return s ? strtoul(s + 1, nullptr, 16) : 0;
}
inline bool validColor(JsonVariantConst value) {
    const char* s = value.as<const char*>();
    if (!s || strlen(s) != 7 || s[0] != '#') return false;
    for (int i = 1; i < 7; ++i) if (!isxdigit(s[i])) return false;
    return true;
}
inline bool number(JsonVariantConst v, double low, double high) {
    return v.is<double>() && std::isfinite(v.as<double>()) &&
        v.as<double>() >= low && v.as<double>() <= high;
}
inline bool channel(JsonVariantConst v, bool both = false) {
    return v == "temperature" || v == "conditions" || (both ? v == "both" : v == "off");
}
inline bool equal(JsonVariantConst a, JsonVariantConst b) {
    if (a.is<double>() && b.is<double>()) return std::abs(a.as<double>()-b.as<double>()) < .000001;
    if (a.is<JsonObjectConst>()) {
        if (!b.is<JsonObjectConst>() || a.size() != b.size()) return false;
        for (JsonPairConst p : a.as<JsonObjectConst>())
            if (!equal(p.value(), b[p.key().c_str()])) return false;
        return true;
    }
    if (a.is<JsonArrayConst>()) {
        if (!b.is<JsonArrayConst>() || a.size() != b.size()) return false;
        for (size_t i = 0; i < a.size(); ++i) if (!equal(a[i], b[i])) return false;
        return true;
    }
    return a == b;
}
inline JsonDocument defaults() {
    JsonDocument d;
    d["version"] = 1; d["top"] = "temperature"; d["bottom"] = "conditions";
    for (int i = 0; i < 7; ++i) {
        auto stop = d["temperature"].add<JsonObject>();
        stop["value"] = WeatherColors::TEMP_STOPS[i];
        stop["color"] = hex(WeatherColors::TEMP_PALETTE[i+1]);
        d["conditions"].add(hex(WeatherColors::CONDITION_PALETTE[i+1]));
    }
    d["wet"] = true;
    d["dayBrightness"] = 100; d["nightBrightness"] = 100.0 * 128 / 255;
    for (const char* name : {"breathing", "wind", "lightning"}) {
        auto effect = d["animations"][name].to<JsonObject>();
        effect["enabled"] = true; effect["speed"] = 1; effect["strength"] = 100;
    }
    d["animations"]["wind"]["target"] = "conditions";
    d["animations"]["wind"]["threshold"] = 10;
    d["animations"]["lightning"]["color"] = "#FFFF38";
    return d;
}
inline std::string validate(JsonVariantConst c) {
    if (c["version"] != 1) return "Unsupported settings version";
    if (!channel(c["top"]) || !channel(c["bottom"])) return "Invalid edge assignment";
    auto stops = c["temperature"].as<JsonArrayConst>();
    if (stops.size() < 2 || stops.size() > 16) return "Use 2 to 16 temperature stops";
    double previous = -61;
    for (JsonVariantConst stop : stops) {
        if (!number(stop["value"], -60, 140) || stop["value"].as<double>() <= previous ||
            !validColor(stop["color"])) return "Temperature stops must have ordered values and valid colors";
        previous = stop["value"];
    }
    if (c["conditions"].size() != 7) return "Seven condition colors are required";
    for (JsonVariantConst color : c["conditions"].as<JsonArrayConst>())
        if (!validColor(color)) return "Invalid condition color";
    if (!c["wet"].is<bool>()) return "Invalid treatment toggle";
    if (!number(c["dayBrightness"], 0, 100) || !number(c["nightBrightness"], 0, 100))
        return "Brightness must be 0 to 100%";
    for (const char* name : {"breathing", "wind", "lightning"}) {
        auto a = c["animations"][name];
        if (!a["enabled"].is<bool>() || !number(a["speed"], .25, 4) ||
            !number(a["strength"], 0, 100)) return "Invalid animation settings";
    }
    auto wind = c["animations"]["wind"];
    if (!channel(wind["target"], true)) return "Invalid wind target";
    bool threshold = false;
    for (int mph : {5, 10, 15, 20, 30, 40, 50}) if (wind["threshold"] == mph) threshold = true;
    if (!threshold) return "Invalid wind threshold";
    if (!validColor(c["animations"]["lightning"]["color"])) return "Invalid lightning color";
    return "";
}
inline uint32_t scale(uint32_t c, double amount) {
    uint32_t result = 0;
    for (int shift : {0, 8, 16}) result |= uint32_t(WeatherColors::byte(((c >> shift) & 255)*amount)) << shift;
    return result;
}
inline uint32_t blend(uint32_t c, uint32_t target, double amount) {
    uint32_t result = 0;
    for (int shift : {0, 8, 16}) {
        int from = (c >> shift) & 255, to = (target >> shift) & 255;
        result |= uint32_t(WeatherColors::byte(from+(to-from)*amount)) << shift;
    }
    return result;
}
inline uint32_t temperature(JsonArrayConst stops, double value) {
    if (!std::isfinite(value)) return 0;
    if (value <= stops[0]["value"].as<double>()) return rgb(stops[0]["color"]);
    for (size_t i = 1; i < stops.size(); ++i) {
        double a = stops[i-1]["value"], b = stops[i]["value"];
        if (value == b) return rgb(stops[i]["color"]);
        if (value < b) return WeatherColors::interpolate(rgb(stops[i-1]["color"]),
            rgb(stops[i]["color"]), float((value-a)/(b-a)));
    }
    return rgb(stops[stops.size()-1]["color"]);
}
inline uint32_t wetColor(uint32_t color, int precip) {
    double r = ((color >> 16)&255)/255.0, g = ((color >> 8)&255)/255.0, b = (color&255)/255.0;
    double mx = std::fmax(r, std::fmax(g,b)), mn = std::fmin(r, std::fmin(g,b)), delta = mx-mn;
    int level = precip <= 3 ? 0 : precip <= 7 ? 1 : 2;
    const double saturation[] = {1,.73,.59}, lightness[] = {.74,.38,.21};
    if (delta == 0) return scale(0xFFFFFF, lightness[level]);
    double h = mx == r ? std::fmod((g-b)/delta, 6) : mx == g ? (b-r)/delta+2 : (r-g)/delta+4;
    if (h < 0) h += 6;
    double c = (1-std::abs(2*lightness[level]-1))*saturation[level];
    double x = c*(1-std::abs(std::fmod(h,2)-1)), m = lightness[level]-c/2;
    double rr = h < 1 || h >= 5 ? c : h < 2 || h >= 4 ? x : 0;
    double gg = h < 1 ? x : h < 3 ? c : h < 4 ? x : 0;
    double bb = h < 2 ? 0 : h < 3 ? x : h < 5 ? c : x;
    return (uint32_t(WeatherColors::byte((rr+m)*255))<<16) |
        (uint32_t(WeatherColors::byte((gg+m)*255))<<8) | WeatherColors::byte((bb+m)*255);
}
// Portable gradient noise: the browser uses the same hash and fade, with a fixed
// seed. Retains the LED's per-hour gust signature without browser randomness.
inline double noise(double x, double y) {
    int xi = int(std::floor(x)), yi = int(std::floor(y));
    double xf = x-xi, yf = y-yi;
    auto fade = [](double t) { return t*t*t*(t*(t*6-15)+10); };
    auto grad = [](int xx, int yy, double dx, double dy) {
        uint32_t h = uint32_t(xx)*374761393u + uint32_t(yy)*668265263u;
        h = (h ^ (h >> 13))*1274126177u;
        h ^= h >> 16;
        return ((h & 1) ? dx : -dx) + ((h & 2) ? dy : -dy);
    };
    double u = fade(xf), v = fade(yf);
    double a = grad(xi,yi,xf,yf), b = grad(xi+1,yi,xf-1,yf);
    double c = grad(xi,yi+1,xf,yf-1), d = grad(xi+1,yi+1,xf-1,yf-1);
    return (a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;
}
inline double lightning(double time) {
    double t = std::fmod(time, 12702)-10000;
    if (t < 0) return 0;
    if (t < 533) return std::fmax(30,std::fmin(150,127+noise(t*.008,0)*42))/255;
    if (t < 792) return (120+(t-533)*135/259)/255;
    if (t < 1104) return 1;
    if (t < 2125) {
        double in = std::fmod(t-1104,255);
        return (in < 127 ? 255-in*204/127 : 51+(in-127)*204/128)/255;
    }
    return std::fmax(0,std::fmin(255,180-(t-2125)*180/577+noise(t*.008,0)*32))/255;
}
inline uint32_t animate(uint32_t color, JsonVariantConst config, JsonArrayConst hours,
                        int h, int led, JsonVariantConst channelId, double time) {
    auto e = hours[h];
    bool condition = channelId == "conditions", temp = channelId == "temperature";
    if ((!condition && !temp) || (condition && !WeatherColors::conditionBucket(e[1].as<uint8_t>()))) return color;
    auto a = config["animations"]["breathing"];
    if (temp && a["enabled"] == true && h > 0 && e[2] != hours[h-1][2]) {
        // Only the first sunrise and first sunset, matching the physical display.
        bool first = true;
        for (int i = 1; i < h; ++i) if (hours[i][2] == e[2] && hours[i][2] != hours[i-1][2]) first = false;
        double t = std::fmod(time*a["speed"].as<double>(),6000);
        if (first && t < 3000) color = scale(color,1-.6*a["strength"].as<double>()/100*
            .5*(1-std::cos(t/3000*2*WeatherColors::PI_VALUE)));
    }
    a = config["animations"]["wind"];
    const int thresholds[] = {0,0,5,10,15,20,30,40,50};
    int wb = e[4] | 0;
    bool windy = wb >= 1 && wb <= 8 ? thresholds[wb] >= a["threshold"].as<int>() : e[1] == 5 || e[1] == 6;
    if (windy && a["enabled"] == true && (a["target"] == "both" || a["target"] == channelId)) {
        // Cutoff, not a ramp: any hour at or above the threshold shimmers with the same amplitude.
        double n = 128+noise(led*1.25,time*a["speed"].as<double>()/1024)*80;
        double mul = std::fmax(30,std::fmin(255,140+(n-128)*6))/255;
        color = scale(color,1+(mul-1)*a["strength"].as<double>()/100);
    }
    a = config["animations"]["lightning"];
    if (condition && e[1] == 11 && a["enabled"] == true)
        color = blend(color,rgb(a["color"]),lightning(time*a["speed"].as<double>())*a["strength"].as<double>()/100);
    return color;
}
inline Frame render(JsonVariantConst config, JsonVariantConst forecast, double elapsed) {
    Frame frame{};
    auto hours = forecast["h"].as<JsonArrayConst>();
    for (int row = 0; row < 2; ++row) {
        auto assignment = config[row == 0 ? "top" : "bottom"];
        for (int h = 0; h < 24 && h < int(hours.size()); ++h) {
            auto e = hours[h];
            uint32_t color = 0;
            if (assignment == "temperature") {
                if (e.size() >= 6) {
                    if (e[5].is<double>()) color = temperature(config["temperature"], e[5]);
                } else if (e[0].as<int>() >= 1 && e[0].as<int>() <= 7) {
                    color = temperature(config["temperature"], WeatherColors::TEMP_STOPS[e[0].as<int>()-1]);
                }
            } else if (assignment == "conditions") {
                auto bucket = WeatherColors::conditionBucket(e[1].as<uint8_t>());
                if (bucket) {
                    color = rgb(config["conditions"][bucket-1]);
                    int precip = e[3] | 0;
                    if (config["wet"] == true && bucket >= 5 && precip >= 1 && precip <= 10)
                        color = wetColor(color, precip);
                }
            }
            int led = row == 0 ? 47-h : h;
            color = animate(color, config, hours, h, led, assignment, elapsed);
            frame[led] = scale(color,
                config[hours[0][2] == 1 ? "nightBrightness" : "dayBrightness"].as<double>()/100);
        }
    }
    return frame;
}

// Commands are the public boundary. Persistence must succeed before state changes.
class Device {
    JsonDocument accepted;
public:
    Device() {
        accepted["revision"] = 0;
        accepted["requestId"] = "";
        accepted["config"].set(defaults());
    }
    const JsonDocument& state() const { return accepted; }
    bool restore(const std::string& saved) {
        JsonDocument candidate;
        if (deserializeJson(candidate, saved) || !candidate["revision"].is<unsigned>() ||
            !candidate["requestId"].is<const char*>() || !validate(candidate["config"]).empty()) return false;
        accepted.set(candidate); return true;
    }
    JsonDocument apply(JsonVariantConst command, std::function<bool(const std::string&)> persist) {
        JsonDocument reply;
        const char* id = command["id"] | "";
        reply["id"] = id;
        reply["status"] = "rejected";
        reply["revision"] = accepted["revision"];
        std::string error;
        if (strlen(id) < 1 || strlen(id) > 64) error = "Invalid request ID";
        else if (accepted["requestId"] == id) {
            // Only identical retries are idempotent.
            if (equal(command["config"], accepted["config"])) reply["status"] = "accepted";
            else error = "Request ID already used";
        } else if (!command["expectedRevision"].is<unsigned>() ||
                   command["expectedRevision"] != accepted["revision"]) error = "Configuration changed; reload before applying";
        else error = validate(command["config"]);
        if (error.empty() && reply["status"] != "accepted") {
            JsonDocument next;
            next["revision"] = accepted["revision"].as<unsigned>()+1;
            next["requestId"] = id; next["config"].set(command["config"]);
            std::string saved; serializeJson(next, saved);
            if (!persist(saved)) error = "Device could not save settings";
            else { accepted.set(next); reply["status"] = "accepted"; reply["revision"] = next["revision"]; }
        }
        if (!error.empty()) reply["error"] = error;
        return reply;
    }
    Frame render(JsonVariantConst forecast, double elapsed) const {
        return Display::render(accepted["config"], forecast, elapsed);
    }
};
}
