# Edgelight dashboard installation handoff

This is an implementation preview awaiting the owner's visual approval. Do not
merge the feature branch or describe it as fully verified. Independent review,
QA, and physical visual acceptance remain outstanding.

## Already performed

- ESP32 firmware with settings support was uploaded successfully over OTA.
- The device reported online and accepted its existing settings, then accepted
  an identical retry without incrementing its configuration revision again.
- The desktop dashboard received an Edgelight tab. All eight pre-existing tabs
  were preserved. The resource was registered under a versioned asset directory.
- The HA settings package and updated forecast publisher were installed. HA's
  configuration check passed before its stop/start.
- Backups from this installation are under
  `/config/edgelight-backups/20260911T182702Z` on the HA host.

The attached bundle contains a newer card build than the first installation,
including a fix for Apply on local HTTP dashboards. Install those latest assets
before requesting visual approval. No further firmware upload is needed for this
handoff. Check HA startup status before making any change.

## Bundle contents

- `dist/`: card JavaScript, shared preview calculations, and stylesheet.
- `ha/display-editor.yaml`: MQTT sensors and the `script.edgelight_apply` action.
- `ha/display-editor-view.json`: the Edgelight tab definition.
- `ha/python_scripts/weather_display_publish.py`: forecast publisher with raw
  temperatures, hour timestamps, and generation metadata.
- `ha/scripts.yaml`: reference forecast script; preserve the installed weather
  entity rather than replacing the script wholesale.
- `scripts/install-ha.py`: optional SSH installer, including backups and a brief
  HA stop/start. It requires an existing SSH connection and no additional Python
  packages. Prefer the dashboard API if the HA agent already has authenticated access.

## Install or update

1. Check whether HA is running and the Edgelight tab already exists. Do not create
   another tab. Inspect the existing `edgelight-display-editor` resource.
2. Copy all three `dist/` files together into a new versioned directory under
   `/config/www/edgelight/`. Register its `edgelight-card.js` as a module resource
   using `/local/edgelight/<version>/edgelight-card.js`. Version the directory so
   browser imports of the model and stylesheet also refresh.
3. Confirm the Edgelight tab is on the existing desktop dashboard. If absent,
   append the provided view using HA's dashboard API while preserving other views.
4. Confirm the settings package is included from `homeassistant.packages` and
   these entities exist: `sensor.edgelight_configuration`,
   `sensor.edgelight_command_result`, `binary_sensor.edgelight_connected`, and
   `sensor.weather_display_hourly`. Confirm `script.edgelight_apply` exists.
   If HA assigned different entity IDs, set the corresponding card options
   `configuration_entity`, `result_entity`, `availability_entity`, `forecast_entity`.
5. The existing forecast script must pass
   `generated_at: "{{ now().isoformat() }}"` alongside `forecast_data` when calling
   the publisher. Preserve its configured weather entity. Reload scripts if
   changed, then run the existing forecast update script once.
6. Reload the dashboard in the browser. Open the Edgelight tab and verify its
   actual HA state; the standalone browser demo uses synthetic data.

If using the bundled SSH installer from a machine with the archive extracted:

```sh
python3 scripts/install-ha.py --host <existing-ssh-user@ha-host> --dashboard dashboard_desktop
python3 scripts/install-ha.py --host <existing-ssh-user@ha-host> --dashboard dashboard_desktop --install
```

The first command is read-only. The second backs up and installs, checks HA
configuration, and stops HA briefly before updating storage-mode dashboard files.
Never edit dashboard storage while HA is running. The installer deliberately
stops if it encounters a different `homeassistant` section layout; merge the
package include into that existing section rather than creating a duplicate key.

## Acceptance checks

- Card displays an online device and its accepted configuration revision; both
  edges show the live forecast. The latest payload has 24 rows, six values per
  row, 24 timestamps, and a non-null `generated_at` value.
- Selecting top/bottom changes the editor focus. Defaults are Temperature on top
  and Conditions below. Both forecast timelines advance left to right.
- Physical mapping: bottom-left LED 0, bottom-right LED 23, top-right LED 24,
  top-left LED 47. The preview contains exactly 24 sources above and below an
  opaque bar, with no illuminated side edges.
- Edit a color or assignment: preview changes, physical display does not. Press
  Apply: the ESP32 changes and the card reports Applied only after receiving the
  matching device request ID. Confirm custom colors, effect toggles, and brightness
  on the wall. Restore the owner's preferred settings after any temporary test.
- Sample forecast and animation sample buttons only affect the browser.
- Verify saved settings survive an ESP32 restart. Mark this unverified until an
  actual device reboot has been checked, even though host persistence tests pass.
- Ask the owner to inspect desktop and phone layouts, the wall-glow approximation,
  edge orientation, and physical animation behavior. Record explicit visual approval
  before requesting the independent build-skill review and QA gates.

## Known limits to retain in the handoff

- The publisher's existing night-time logic has a timezone fallback because HA's
  Python-script sandbox lacks `now()`. The card uses the published night flags,
  matching firmware. Astronomical sunrise/sunset is outside this feature.
- The preview is an illustration of LED colors, not calibrated wall brightness
  or a phase-synchronized video of the device.
- The new renderer uses portable deterministic gradient noise for the wind and
  lightning noise portions, keeping their overall LED motion and timing. Compare
  their feel physically; do not claim byte-for-byte compatibility with old FastLED
  noise samples.
- No independent review/QA gate has run yet. The branch remains `feat/display-editor`.
