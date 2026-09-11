# Home Assistant display editor

Status: Approved in conversation; build preflight
Tracker label: ready-for-agent

## Problem Statement

The physical weather display has two backlit edges, but Home Assistant offers no
visual way to see their assignments or change colors and animations. The owner
currently needs firmware edits and uploads to tune the display. A phone-shaped
preview would misrepresent the installation.

## Solution

Add a new Edgelight tab to the existing desktop Home Assistant dashboard,
preserving its other tabs. The tab contains an Edgelight card with an interactive preview
of the actual horizontal wall piece: an opaque bar, 24 LEDs above it and 24 below
it, illuminating the surrounding wall. Selecting an edge opens its assignment
and appearance controls. Changes update a local preview immediately; Apply sends
the complete configuration to the ESP32 and reports when the device accepts it.

The supplied installation photo defines the physical arrangement and the style
of the backlight. Reproduce the bar and wall glow, without surrounding household
objects. Use a neutral wall and an opaque neutral bar; exact wall texture and
camera exposure are not color calibration targets.

### Preview and physical mapping

```text
                    Now                         +23 hours
Top row             47  46  45 ...                25  24
                  ┌────────────────────────────────────┐
                  │          opaque wall piece         │
                  └────────────────────────────────────┘
Bottom row           0   1   2 ...                22  23
ESP32 enters here ────→ bottom left to right ──────────┘
                           then top right to left
```

Both displayed timelines advance left to right. Wiring reverses on the top row,
so forecast hour h maps to physical LED 47-h on top and LED h on the bottom.
The bar always stays horizontal, including on a narrow phone screen.

Normal preview shows 24 distinct light sources per edge with overlapping soft
glow spreading away from the bar onto the wall. The bar hides the strip itself.
An optional LED guide reveals the source positions and physical indices. No
side-edge LEDs or extra lights appear at the turn.

### Card layout

1. Header: display name, device connection, last forecast update, configuration status.
2. Preview: horizontal bar, top/bottom assignment labels, shared time axis,
   Live forecast / Sample forecast selector, animation play/pause and LED guide.
3. Editor: Edge assignments, Colors, Animations, and Brightness sections.
4. Actions: Apply changes, Discard changes, Restore defaults.

On wider dashboards place the editor beside the preview; on mobile place it
below. Selecting an edge highlights it and focuses the corresponding controls.
Selecting an hour highlights that hour on both rows and shows its time, weather
values, resolved color, and active effects. At narrow widths, use an hour slider
and a readable detail panel instead of requiring precise taps on tiny LEDs.

### Proposed first-version scope

- Each row independently selects Temperature, Conditions, or Off. Defaults are
  Temperature on top and Conditions on bottom. Duplicate assignments are allowed.
- Palettes belong to channels. If both rows show Temperature, edits affect both.
- Temperature uses editable numeric color stops with smooth OKLCH blending,
  preserving the currently ported Android defaults. Users can change stop values
  and colors, add stops, and remove stops down to a minimum of two.
- Conditions expose the seven visual categories: Sunny, Partly cloudy, Cloudy,
  Fog, Rain, Snow, and Sleet. Missing/unknown stays off and is not an editable color.
- Color controls provide a picker, editable hex value, and labeled swatches.
  No alpha control: these are physical RGB LEDs. Brightness is separate.
- Wet intensity is a toggle. When on, Rain/Snow/Sleet show light, medium and heavy
  swatches derived from the edited base hue using the current Android treatment.
  White/gray choices use the corresponding lightness steps. Precipitation buckets
  1–3, 4–7, and 8–10 select the levels; missing precipitation uses the base color.
- Night treatment has an enable toggle. Its existing condition dim and cool tint
  are preserved initially. Global daytime and nighttime brightness are editable.
- Animation controls cover the existing LED effects: sunrise/sunset breathing,
  wind shimmer, and lightning. Each gets an enable toggle, speed, strength, and
  a browser-only sample. Lightning also gets an editable bolt color.
- Breathing follows Temperature assignments. Lightning follows Conditions
  assignments. Wind defaults to Conditions to preserve current LED behavior, with
  a target selector for Temperature, Conditions, or Both. Effects never light Off
  rows or unknown-condition cells.
- Wind trigger is selectable from the existing speed-bucket boundaries: 5, 10,
  15, 20, 30, 40, or 50 mph. Default is 10 mph. A provider's explicit windy
  condition remains a fallback when numeric wind data is missing.
- Keep the existing physical LED animation signatures. Android's multi-slice
  within-hour ripple cannot be reproduced on one physical LED per forecast hour.

The channel choices and control scope above are proposals for approval. Adding
dedicated Precipitation, Wind, or Alerts channels is a separate extension.

## User Stories

1. As the display owner, I want a preview shaped like my wall piece so I can judge changes in context.
2. As the display owner, I want 24 lights on each edge so the preview matches the hardware.
3. As the display owner, I want both timelines to read left to right so corresponding hours line up.
4. As the display owner, I want to select either edge so I can see and change its assignment.
5. As the display owner, I want to swap the channels so I can choose their physical positions.
6. As the display owner, I want to disable an edge or duplicate a channel so I can choose a simpler layout.
7. As the display owner, I want to inspect an hour so I can understand its color and animation.
8. As the display owner, I want live weather in the preview so I can compare it with the wall display.
9. As the display owner, I want a sample forecast so I can inspect weather that is absent today.
10. As the display owner, I want to edit temperature stops so I can choose meaningful temperature colors.
11. As the display owner, I want Celsius or Fahrenheit labels so I can edit in familiar units.
12. As the display owner, I want to edit each condition color so I can distinguish weather categories.
13. As the display owner, I want to see all three wet-strength colors so their derived appearance is clear.
14. As the display owner, I want to disable wet intensity so my chosen base color can stay constant.
15. As the display owner, I want to preview day and night so I can judge dim colors before applying them.
16. As the display owner, I want animation toggles and adjustments so I can control movement and flashing.
17. As the display owner, I want adjustable brightness so the wall glow suits the room.
18. As the display owner, I want drafts to affect only the preview so experimentation does not disturb the room.
19. As the display owner, I want explicit confirmation from the device so I know an Apply succeeded.
20. As the display owner, I want my settings restored after a reboot so I do not need to configure them again.
21. As the display owner, I want to discard edits or restore defaults so experiments are reversible.
22. As the display owner, I want offline and stale states to be visible so an old preview is not mistaken for current output.
23. As the display owner, I want phone and keyboard controls so I can edit from any HA client.
24. As the display owner, I want concurrent edits detected so another browser's changes are not silently overwritten.

## Implementation Decisions

- Use a Home Assistant custom dashboard card and HA MQTT integration. The browser
  reads HA entities and calls a scoped HA script/service to publish settings;
  it never connects directly to the broker or contains broker credentials.
- Provide reproducible installation assets for the card, HA entities/service,
  and firmware. Existing forecasts and refresh automation continue independently.
- Separate forecast data from display configuration. The current hourly payload,
  including the optional raw Fahrenheit field, remains accepted. Add forecast
  generation time and hour timestamps without changing existing tuple indices.
  The preview must explicitly label a legacy bucket-only temperature forecast.
- Expose the accepted configuration, device availability, and forecast metadata
  as HA entities. Keep full forecast arrays out of ordinary entity state strings.
- Define one versioned display configuration containing row assignments,
  temperature stops, condition colors, wet/night toggles, animation settings,
  and brightness. Use stable channel identifiers, not HA condition wire codes.
- Configuration commands carry a unique request ID and expected device revision.
  Publish commands without retain; publish accepted configuration and revision
  with retain. Firmware validates the entire document before atomically accepting
  and persisting it. Invalid values or stale revisions reject the whole request.
- Firmware reports acceptance/rejection with the request ID. The UI shows Applied
  only on matching device confirmation, never merely on MQTT publication success.
  A 10-second timeout reports unconfirmed and offers retry. Retrying an accepted
  request ID is idempotent. A reconnect reconciles against the reported revision.
- Store accepted settings in ESP32 nonvolatile storage on Apply, never every
  render frame. With no settings, boot with the current display defaults. A
  firmware restart restores accepted settings and republishes state. Use an MQTT
  availability message and last will so HA can distinguish offline from stale.
- Local drafts survive forecast refreshes but are not automatically sent. A
  remote configuration update during editing shows a conflict and offers reload;
  do not silently merge. Discard restores the latest accepted configuration.
- Restore defaults modifies the draft. It still requires Apply to change LEDs.
  Sample mode, animation samples, pause, and LED guide affect only the browser.
- Temperature limits are -60 to 140°F, with 2–16 strictly ordered stops and valid
  six-digit RGB colors. Celsius edits convert to canonical Fahrenheit without
  accumulating round-trip changes. End temperatures clamp to endpoint colors.
- Brightness ranges from 0–100%. Animation speed is 0.25–4 times the existing
  cycle rate; strength is 0–100%, representing effect amplitude while preserving
  the base weather color. Initial values reproduce the current LED effects.
- Specify deterministic composition: channel base color, wet treatment, condition
  night treatment, breathing, wind, lightning, then global brightness. Channels
  determine eligibility; physical row indices only place the result.
- Refactor the existing portable firmware color rules into a settings-aware
  renderer used by the actual device. Browser calculations must match the
  firmware for the same configuration, forecast, and animation time. Where noise
  is used, specify a shared deterministic function and seed.
- The preview shows computed LED colors with illustrative wall diffusion. It
  does not claim photometric accuracy or synchronization to the device's current
  animation phase. Paused samples provide a deterministic comparison.
- Sample data covers all seven conditions, wet-strength levels, thunder, wind,
  day/night transitions, and missing values. Sample temperature spans all default
  stops. Sample night/day override is local to the preview.
- Controls have visible labels, keyboard access, numeric values alongside sliders,
  and at least 44px interactive targets. Respect reduced motion in the browser
  without changing the physical display's saved animation settings.

## Testing Decisions

Confirmed acceptance boundary: user edits in HA through publication and device
confirmation to the firmware's 48-LED output. Browser tests cover the rendered
preview and editing workflow. The user explicitly requires a physical display
check as part of acceptance, including visual approval on the installed dashboard.

- Prefer observable behavior over internal helper tests. Extend the existing
  host-compiled firmware tests and HA publisher fixtures; use one shared set of
  configuration/forecast/time fixtures to compare browser and firmware output.
- Verify all 48 physical positions with an asymmetric hourly forecast: bottom
  first/last are LEDs 0/23; top first/last are LEDs 47/24. Repeat after swapping,
  duplicating, and disabling row assignments.
- Verify color stops, interpolation, out-of-range clamping, missing values,
  Celsius editing, seven condition mappings, custom wet hues including gray,
  night composition, and raw versus legacy temperature forecasts.
- Verify animation eligibility after assignment changes, each enable switch,
  speed and strength bounds, custom lightning color, simultaneous effects, and
  saturation/clamping. Browser and firmware RGB channels must agree within one
  byte for deterministic frames before illustrative wall diffusion.
- Exercise Apply with a broker and running firmware or a faithful host transport
  harness: accept, reject, offline, timeout, retry, restart, and revision conflict.
  Verify invalid or duplicate commands never partially change settings.
- Browser tests exercise selecting edges/hours, editing colors/stops/effects,
  Live/Sample switching, restoring defaults, discarding drafts, and confirmation
  feedback. A sample must never publish synthetic weather or change device mode.
- Check desktop and narrow phone layouts, keyboard navigation, reduced motion,
  and 48 visible source positions in the LED guide. Visual inspection checks
  outward wall glow, the opaque bar, and aligned left-to-right timelines.
- On the physical display, verify row orientation, a distinctive custom palette,
  effect toggles, and reboot persistence; restore the owner's chosen configuration
  after any temporary test. Do not infer physical appearance from RGB tests alone.
- Required build checks include the browser production build, automated tests,
  and both USB-target and OTA-target firmware builds.

## Out of Scope

- Android app changes, subscriptions, and preset synchronization between devices.
- Dedicated precipitation, wind, or alert color channels in this first version.
- Arbitrary strip geometry, vertical/side edges, multiple devices, or LED counts other than 48.
- Remote firmware uploading from the card or changing network credentials.
- Replacing forecast providers, changing horizon, or implementing astronomical sunrise/sunset.
- An arbitrary animation authoring language or Android's within-hour multi-slice renderer.
- Automatic live application of every slider movement or synthetic forecasts sent to the wall.
- Photograph-derived color calibration or an exact simulation of room lighting.

## Further Notes

The user approved implementation through the build skill, including installation
on the existing HA dashboard and physical display for acceptance checks.
Final merge requires the user's separate merge instruction.
The most recent color changes remain existing work in the checkout and must be
preserved when starting the build.

The installed publisher's prior logs showed that `now()` was unavailable inside
HA's Python-script sandbox, causing its timezone fallback to run. Do not promise
astronomical or DST-correct boundaries in the preview. Consume the same published
night flags as firmware; handle the underlying timezone issue separately.

Platform references checked during specification:

- [Home Assistant custom cards](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/)
- [Home Assistant MQTT integration](https://www.home-assistant.io/integrations/mqtt/)
