#include <cassert>
#include <iostream>
#include "display_engine.h"

int main() {
    Display::Device device;
    JsonDocument forecast;
    auto hours = forecast["h"].to<JsonArray>();
    for (int h = 0; h < 24; ++h) {
        auto hour = hours.add<JsonArray>();
        hour.add(4); hour.add(h == 0 ? 8 : 1); hour.add(0);
        hour.add(0); hour.add(0); hour.add(h == 0 ? 0 : 90);
    }
    auto frame = device.render(forecast, 0);
    assert(frame[47] == 0x2D60C8 && frame[24] == 0xCD2E39);
    assert(frame[0] == 0x43C47E && frame[23] == 0xFFD34E);
    JsonDocument command;
    command["id"] = "first";
    command["expectedRevision"] = 0;
    command["config"].set(device.state()["config"]);
    command["config"]["top"] = "conditions";
    command["config"]["bottom"] = "off";
    auto reply = device.apply(command, [](const std::string&) { return true; });
    assert(reply["status"] == "accepted");
    frame = device.render(forecast, 0);
    assert(frame[47] == 0x43C47E && frame[24] == 0xFFD34E);
    for (int i = 0; i < 24; ++i) assert(frame[i] == 0);
    std::string saved;
    command["id"] = "second"; command["expectedRevision"] = 1;
    command["config"]["bottom"] = "conditions";
    reply = device.apply(command, [&](const std::string& value) { saved = value; return true; });
    assert(reply["status"] == "accepted");
    Display::Device restarted;
    assert(restarted.restore(saved));
    assert(restarted.render(forecast, 0) == device.render(forecast, 0));
    reply = restarted.apply(command, [](const std::string&) { assert(false); return false; });
    assert(reply["status"] == "accepted" && reply["revision"] == 2);
    command["id"] = "stale";
    assert(restarted.apply(command, [](const std::string&) { return true; })["status"] == "rejected");
    command["expectedRevision"] = 2;
    command["config"]["temperature"][1]["value"] = -100;
    assert(restarted.apply(command, [](const std::string&) { return true; })["status"] == "rejected");
    command["config"].set(device.state()["config"]);
    assert(restarted.apply(command, [](const std::string&) { return false; })["status"] == "rejected");
    assert(restarted.state()["revision"] == 2);

    // Lightning follows the assigned channel, including the formerly-temperature row.
    forecast["h"][0][1] = 11;
    frame = device.render(forecast, 11000);
    assert(frame[47] == 0xFFFF38 && frame[0] == 0xFFFF38);
    command["id"] = "disable-flash";
    command["config"]["animations"]["lightning"]["enabled"] = false;
    assert(device.apply(command, [](const std::string&) { return true; })["status"] == "accepted");
    frame = device.render(forecast, 11000);
    assert(frame[47] == 0x43C47E && frame[0] == 0x43C47E);
    std::cout << "display mapping and atomic apply passed\n";
}
