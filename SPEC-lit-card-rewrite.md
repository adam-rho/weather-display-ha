# Rewrite the Edgelight card as a LitElement

Status: Draft for approval
Slug: lit-card-rewrite
Tracker label: ready-for-agent

## Problem Statement

The Edgelight dashboard card (`web/edgelight-card.js`) is a hand-rolled
`HTMLElement`. Its `draw()` method sets `shadowRoot.innerHTML` to a template
string and then re-binds every event listener. `set hass(hass)` calls `draw()`
on essentially every Home Assistant state change; the only escape is a narrow
guard that skips the rebuild when an `<input>` is the shadow root's
`activeElement`. A separate `paint()` does surgical style updates for the
animation loop.

Rebuilding the whole shadow DOM on each state update causes a class of
fragility bugs, because HA pushes state updates constantly (forecast refresh,
availability, result entity):

1. **Preview glow fades to black.** Lowering brightness scales the LED RGB
   toward black, so the wall glow darkens instead of softening. This is a
   preview-math bug, independent of the teardown problem.
2. **Controls pane will not scroll.** The right-hand editor (`.controls`,
   `max-height` with `overflow:auto`) starts to scroll, then snaps back to the
   top because a state update rebuilds the DOM and resets `scrollTop`.
3. **Buttons need a double-click.** A state update between `mousedown` and
   `mouseup` destroys the button under the pointer, so the first click is lost.
4. **The forecast-hour slider will not drag.** A state update mid-drag replaces
   the `<input type=range>`, aborting the drag.

Root cause for 2–4 is the same: `draw()` destroys and recreates the shadow DOM
on every `hass` update. Bug 1 is a separate change to the preview math.

## Solution

Rewrite the card as a `LitElement`. Lit renders declaratively and diffs the DOM,
so a re-render on state change is cheap and does not tear down existing nodes,
reset scroll, or interrupt a click or drag. This fixes bugs 2–4 by construction.
Fix bug 1 by changing the preview glow model in the card: fade the glow's
**opacity over a light backing** as brightness drops, instead of darkening its
color. Preview only — it does not change what is sent to the device.

The card's features, behavior, public API, and the service contract stay the
same. This is a structural rewrite plus one preview-math fix, not a feature
change.

`web/display-model.js` stays **byte-for-byte unchanged**. The Lit card keeps
importing `defaults, render, validate, hex, names, wetColor, sample,
conditionBucket` from it. Keeping it untouched is what proves firmware parity is
undisturbed — the `node --test` suite runs against this file only.

### Vendoring Lit (offline, no CDN, no bundler)

- Vendor one pinned ESM build of Lit core at `web/vendor/lit-core.min.js`. The
  card imports `{LitElement, html, css, nothing}` from `./vendor/lit-core.min.js`
  with a relative path. No CDN import — the HA host must work offline. No new
  bundler.
- Obtain it reproducibly: `npm install lit@<pinned-version>` in a scratch dir,
  copy `node_modules/lit/lit-core.min.js` to `web/vendor/lit-core.min.js`.
  `lit-core.min.js` is Lit's pre-bundled core (reactive-element + lit-html +
  LitElement + `html`/`css`/`nothing`); it excludes decorators and extra
  directives, none of which this card needs.
- Record the exact version and a SHA-256 of the vendored file in a short
  `web/vendor/README.md` (version, source URL, hash, date) so the pin is
  auditable and reproducible. Do not add `lit` to `package.json` dependencies —
  the vendored file is the source of truth; `npm` is only the fetch tool.
- `scripts/serve.mjs` already serves the whole `web/` tree, so
  `./vendor/lit-core.min.js` resolves for `demo.html` and the Playwright run
  with no server change.

### Build

Update `scripts/build.mjs` to copy the vendored Lit file (and any other new
assets) into `dist/` at the same relative path (`dist/vendor/lit-core.min.js`),
alongside `edgelight-card.js`, `edgelight.css`, and `display-model.js`. The
build stays a plain file copy — no bundler.

### Preview glow model (bug 1)

`render()` in `display-model.js` bakes brightness into the RGB by scaling toward
black, and it must not change. So the card computes the glow separately:

- Render the preview frame at full brightness by cloning the draft with
  `dayBrightness` and `nightBrightness` set to 100, then use those colors for
  the glow. Read the actual applied brightness (day or night, per the inspected
  forecast) from the unmodified draft and apply it as the glow element's
  **opacity** over a light wall backing, so lowering brightness makes the glow
  more translucent, not darker.
- The frame sent to the device and the numbers shown in the detail panel keep
  using the normal `render(draft, ...)` output. Only the wall-glow visuals use
  the full-brightness colors plus opacity.
- This requires an `edgelight.css` change to the wall/glow backing so reduced
  opacity reads as a fade toward light, not toward the current dark gradient.
  Editing `edgelight.css` is allowed; only `display-model.js` is frozen. Exact
  wall treatment is an owner visual-approval item (see open decisions).

### What must be preserved (no behavior change)

Features: edge assignment (top/bottom); colors section (temperature stops
add/remove, condition colors, wet swatches, night toggle); animations section;
brightness section (day/night sliders); forecast-hour inspect; sample/live
modes; play/pause animation; LED guide; units F/C; apply/discard/defaults;
pending/conflict/confirmation status and the 10-second unconfirmed timeout;
availability/online handling.

Public API: `setConfig`, `set hass`, `getCardSize()` (returns 12),
`getGridOptions()` (`{columns:'full',min_columns:6}`), `window.customCards`
registration, custom element name `edgelight-display-card`, and the four config
entity options with their existing defaults (`configuration_entity`,
`availability_entity`, `forecast_entity`, `result_entity`).

Service contract: `script.edgelight_apply` with the same command payload shape
(`{id, expectedRevision, config}`) and request-id generation.

Harness: `web/demo.html` must still mount and render the card with synthetic
data.

## Implementation Decisions

- **State drives render.** Move the ad-hoc instance fields (`accepted`, `draft`,
  `dirty`, `mode`, `edge`, `section`, `hour`, `guide`, `night`, `playing`,
  `message`, `pending`, `conflict`, `units`, etc.) onto reactive/internal state
  so edits and HA updates trigger a Lit re-render instead of a manual `draw()`.
  Keep the `hass` reconciliation logic (revision change, confirmation match,
  rejection, conflict, timeout) as-is; it just sets state and lets Lit render.
- **Drop the `activeElement`-guard hack.** It exists only to avoid the teardown.
  Lit's diffing preserves focus and in-flight interactions, so the guard is
  removed. Focus, scroll, and drag survive HA updates for free.
- **Animation loop stays surgical.** Keep a `requestAnimationFrame` loop that
  advances `time` while `playing`. Do the per-frame LED coloring as direct
  inline-style writes to the `.source` elements (via refs or `renderRoot`
  queries), mirroring today's `paint()`, rather than re-rendering the whole card
  at 60fps. Lit owns the structural render; the hot path writes only style
  properties Lit does not manage, so the two do not fight. Respect
  `prefers-reduced-motion` for the initial `playing` value as today.
- **Keep `edgelight.css` as a linked stylesheet** referenced from the Lit
  template (`<link rel="stylesheet" href=...>`), not migrated into Lit `static
  styles`. This preserves the versioned three-file deploy model (card JS, model
  JS, CSS copied together) and keeps the CSS a separate, byte-diffable asset.
  (Flagged as an open decision — see below.)
- **Preserve DOM structure, class names, roles, and `aria-label`s** from the
  current template as closely as possible so the existing Playwright selectors
  keep working with minimal edits. Where a selector must change, update the test
  in the same commit and note it.
- **XSS/escaping.** Lit escapes interpolated text by construction, so the manual
  `escape()` helper for text content is no longer needed; drop it where Lit
  handles it, keep any use that feeds attribute values Lit does not escape.

## Testing Decisions

Named test contract (QA gates on these):

- `node --test tests/editor.test.mjs` passes **unchanged**. It imports only from
  `web/display-model.js`; a green run proves the frozen shared logic was not
  disturbed. Do not edit this file.
- `npx playwright test` (`npm run test:browser`) passes. The four existing
  browser tests in `tests/browser/editor.spec.js` keep asserting the same
  behavior; update only selectors that the new DOM forces, nothing about intent.
- **New anti-fragility tests** (these fail on the old card, pass on the new
  one). Each drives a real interaction and lands a `hass` update in the middle
  via the demo harness's `window.refresh()`:
  1. Scroll `.controls` down, fire a `hass` update, assert `scrollTop` is
     preserved (old card resets to 0).
  2. Focus a control, fire a `hass` update, assert the same element is still
     `activeElement` (old card loses focus on rebuild).
  3. `mousedown` on a section tab, fire a `hass` update, `mouseup`, assert the
     section switched on that single click (old card needs a second click).
  4. `mousedown` on the forecast-hour slider thumb, move, fire a `hass` update
     mid-drag, `mouseup`, assert the value changed (old card aborts the drag).

  If any of the four cannot be made a reliable headless assertion, replace only
  that one with a precise manual acceptance check documented in `demo.html` and
  marked owner-verified; keep the rest automated.

## Acceptance Criteria (per-criterion checklist)

- [ ] Card is a `LitElement` importing from `./vendor/lit-core.min.js`; no CDN
      import anywhere; no new bundler; `web/vendor/lit-core.min.js` committed.
- [ ] `web/vendor/README.md` records the pinned Lit version, source, SHA-256,
      and date; the vendored file matches that hash.
- [ ] `web/display-model.js` is byte-for-byte identical to `main`.
- [ ] `scripts/build.mjs` copies `vendor/lit-core.min.js` into `dist/vendor/`
      alongside the three existing files; `npm run build` produces a `dist/` that
      loads offline.
- [ ] Bug 1 fixed: lowering day or night brightness makes the preview glow more
      translucent over a light backing, never darker toward black; the device
      payload and detail-panel numbers are unchanged.
- [ ] Bug 2 fixed: the controls pane scrolls and holds position across HA
      updates.
- [ ] Bug 3 fixed: section tabs, color, and play buttons act on a single click.
- [ ] Bug 4 fixed: the forecast-hour slider drags smoothly across HA updates.
- [ ] All preserved features (list above) work: edges, colors + stops + wet +
      night, animations + samples, brightness, hour inspect, sample/live, play,
      LED guide, F/C, apply/discard/defaults, pending/conflict/confirmation +
      10s timeout, availability.
- [ ] Public API preserved: `setConfig`, `set hass`, `getCardSize()==12`,
      `getGridOptions()`, `customCards` registration, element name
      `edgelight-display-card`, four config options with existing defaults.
- [ ] Service contract preserved: `script.edgelight_apply` payload shape and
      request id.
- [ ] `web/demo.html` mounts and renders with synthetic data.
- [ ] `node --test tests/editor.test.mjs` passes unchanged.
- [ ] `npx playwright test` passes (existing tests intent-unchanged, selectors
      updated only as forced).
- [ ] The four anti-fragility checks pass (or the documented manual fallback for
      any that cannot be automated, marked owner-verified).

## Deploy (post-merge, manual, owner-driven — not a build gate)

After merge, deploy `dist/` to HA (.31) as a new versioned directory:

1. Snapshot/back up the current `/config/www/edgelight/<old-version>/` first.
2. Copy all `dist/` files (now including `vendor/lit-core.min.js`) into
   `/config/www/edgelight/<new-version>/`.
3. Re-register the resource to
   `/local/edgelight/<new-version>/edgelight-card.js`.
4. Reload the dashboard and do a readback verification (online device, accepted
   revision, both edges rendering, an Apply round-trip, and a glance at the new
   glow-at-low-brightness look).

Host deployment is not part of the automated build or its gates.

## Out of Scope

- Any change to `web/display-model.js` or firmware parity math.
- New features, new controls, or layout redesign beyond the bug-1 glow backing.
- Migrating the HA entities, service, publisher, or firmware.
- A bundler, build step beyond file copy, or an npm runtime dependency on `lit`.
- Photometric accuracy of the preview.

## Open Decisions (RESOLVED by owner 2026-09-11)

1. **Lit version to pin.** RESOLVED: pin the latest Lit 3.x `lit-core.min.js`.
   Record the exact frozen version and its hash in `web/vendor/README.md`.
2. **CSS delivery.** RESOLVED: keep `edgelight.css` as a linked stylesheet.
   Preserves the versioned multi-file deploy. Do NOT move CSS into Lit
   `static styles`.
3. **Glow backing look for bug 1.** RESOLVED in principle: implement the light
   wall backing so reduced brightness fades the glow's opacity toward light
   (not black). Owner gives final visual approval on the running dashboard at
   deploy time — this is an owner-verified acceptance item, not a build gate.
4. **Anti-fragility tests: automated vs manual.** RESOLVED: implement all four
   as automated Playwright checks (`window.refresh()` mid-interaction). If an
   individual check (slider-drag or single-click timing) proves flaky headless,
   it may fall back to a documented manual check in `demo.html`, marked as
   owner-verified.
