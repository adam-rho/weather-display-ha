# Contributing

This is a personal project that I run on my own wall. Issues and pull requests are welcome, with the expectations below so nobody wastes an evening.

## Issues

Bug reports are the most useful thing you can send. Include your HA version, which weather integration you use, and the MQTT payload from `weather/hourly` if the strip renders something odd (MQTT add-on > Configure > Listen to a topic).

Feature requests are fine too. Things I will probably say no to: a different LED count or row layout beyond the 2x24 shape (see "What this assumes" in the README), cloud services, and anything that moves color logic from the ESP32 into Home Assistant.

## Pull requests

- Small and focused. One change per PR.
- Run the tests that touch what you changed (commands in `AGENTS.md`). The firmware engine and the browser preview share one color model; if you change one, change the other and keep the parity test green.
- Don't reformat files you aren't otherwise editing.
- Firmware changes: say which board you tested on.

I merge to `main` directly and cut no release branches. If a PR sits for a while it's because I haven't been near the wall, not because it's rejected.

## Not accepted

Credentials, device IPs, or anything from your own HA install. `include/secrets.h` and `platformio_local.ini` stay gitignored; push protection is on.
