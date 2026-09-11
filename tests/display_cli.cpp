#include <iostream>
#include "display_engine.h"
int main() {
    std::string input;
    while (std::getline(std::cin,input)) {
        JsonDocument request, result;
        if (deserializeJson(request,input)) return 1;
        const std::string error = Display::validate(request["config"]);
        result["error"] = error;
        if (error.empty()) {
            auto frame = Display::render(request["config"],request["forecast"],request["time"] | 0.0);
            for (auto color : frame) result["frame"].add(color);
        }
        serializeJson(result,std::cout); std::cout << '\n';
    }
}
