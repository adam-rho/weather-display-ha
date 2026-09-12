# Harden the Edgelight card: layout, theme, lockout, preview, render cost

Status: Approved (owner, chat, 2026-09-12)
Slug: card-hardening
Follows: SPEC-lit-card-rewrite (merged). Everything that spec lists under
"What must be preserved" and "Public API" stays preserved here.

## Problem

A UI/UX audit of the card in the live HA panel view (headless Chromium,
1440x900) found seven defects. The controls pane is capped at a magic 590px,
so it clips content mid-control with no visible scrollbar and leaves dead space
under it; its scroll position also carries across tab switches. The card mixes
theme sources (text from `--primary-text-color`, surface from
`--ha-card-background`, which HA's light theme does not set) and hardcodes
white-alpha borders, so in HA's default light theme it renders near-black text
on a dark surface. After an Apply times out with the device offline every
control is disabled and the only exit is Discard, which throws the draft away.
Typing a hex color commits each keystroke, so a partial value freezes the wall
preview and shows a validation error until the seventh character. Every `hass`
push re-renders the card even when none of its four entities changed. The
animation loop runs two full `render()` calls per frame and rewrites the
details panel and forecast-status text 60 times a second whether or not
anything changed. And the card is 1049px tall in a 900px viewport, so the
footer with Apply sits below the fold while the pane inside it also scrolls.

## Solution

The card fills the HA panel viewport: header and footer always visible, the
workspace row takes the remaining height, and each column scrolls internally
only when it must. Surface, text, borders and fills all derive from the HA
theme, so the card is readable in both default themes; the wall preview keeps
its own fixed palette. An Apply that times out releases the editor and keeps
the draft; the user can keep editing and re-apply when the device is back.
Hex fields commit only complete values, and the preview keeps painting the last
valid draft while the draft is invalid. The card re-renders only when one of
its four entities changed, and the frame loop does per-frame work only for the
glow while animations play. Stacked layout keys off the card's own width via a
container query, not the window width. `web/display-model.js` stays
byte-for-byte unchanged.

## Acceptance criteria

All browser tests below live in `tests/browser/hardening.spec.js` and run at
1440x900 unless stated. "The card" is `edgelight-display-card` mounted by
`web/demo.html`.

### Controls pane (finding 1)

1. WHEN the Colors tab is open at 1440x900 THE SYSTEM SHALL give `.controls` a
   computed `max-height` of `none`, a `scrollHeight` greater than its
   `clientHeight`, and a bottom edge equal (within 1px) to the `.editor`
   bottom edge minus `.editor`'s bottom padding.
   Test: `controls pane has no fixed max-height and fills the editor column`.
2. WHEN `.controls` is scrolled to 300 on the Colors tab and the user clicks
   the Animations tab THE SYSTEM SHALL show the Animations content with
   `.controls.scrollTop === 0`.
   Test: `switching tabs resets the controls scroll to top`.
3. WHEN `.controls` overflows THE SYSTEM SHALL show an always-visible thin
   scrollbar (computed `scrollbar-width` is `thin` and `scrollbar-color` is not
   `auto`).
   Test: `controls pane shows an always-visible thin scrollbar`.

### Theme (finding 2)

4. WHEN the host carries HA's light-theme variables
   (`--card-background-color:#fff`, `--primary-text-color:#141414`,
   `--secondary-text-color:#727272`, and no `--ha-card-background`) THE SYSTEM
   SHALL render `article` with a background of relative luminance above 0.8 and
   text (`article`, `.controls label`, `.hex`, `footer`) of relative luminance
   below 0.25, and every `button` and `select` border color shall differ from
   the surface by at least 0.05 luminance.
   Test: `card is readable in HA light theme`.
5. WHEN no theme variables are set (demo default) THE SYSTEM SHALL render
   `article` with background luminance below 0.25 and text luminance above
   0.7.
   Test: `card is readable in dark theme by default`.
6. WHEN either theme is active THE SYSTEM SHALL keep `.wall` and `.bar`
   computed backgrounds identical between the two runs (fixed physical-wall
   palette).
   Test: `wall preview palette does not follow the theme`.

### Apply lockout (finding 3)

7. WHEN Apply is clicked with `window.noAck=true` and the card's
   `confirmTimeoutMs` set to 50 THE SYSTEM SHALL, after the timeout, show the
   status "Unconfirmed. Check the display connection, then retry.", keep the
   edited draft value in its control, keep the "Unsaved changes" state (Apply
   enabled, label "Apply changes"), and enable every editor control (Top edge
   assignment select, Colors hex fields, footer Restore defaults).
   Test: `apply timeout re-enables editing and keeps the draft`.
8. WHEN the device goes offline after such a timeout THE SYSTEM SHALL keep the
   editor controls enabled and disable only Apply; WHEN the device comes back
   online THE SYSTEM SHALL enable Apply.
   Test: `after a timeout Apply follows online state while editing stays open`.
9. WHEN Apply is clicked again after a timeout with an unchanged draft THE
   SYSTEM SHALL send the same request id as the timed-out request; WHEN the
   draft was edited in between THE SYSTEM SHALL send a new request id.
   Test: `retry after timeout reuses the request id only for an unchanged draft`.
   (The existing `unconfirmed requests preserve their ID on retry` test in
   `editor.spec.js` keeps passing: a retry while still pending reuses the id.)

### Hex input and invalid drafts (finding 4)

10. WHEN the user types `#FF` into the Rain hex field THE SYSTEM SHALL leave
    the draft's Rain color unchanged, show an empty `#validation`, and keep the
    `--glow` of a rain-hour `.source` unchanged; WHEN the field then blurs THE
    SYSTEM SHALL restore the field's value to the draft's Rain color.
    Test: `partial hex input does not commit, error, or freeze the preview`.
11. WHEN the user types `#ff0000` into the Rain hex field THE SYSTEM SHALL
    commit the color (draft shows `#ff0000` or its uppercase form, the
    rain-hour `.source` `--glow` changes), and on blur the field shows the
    normalized uppercase value.
    Test: `complete hex input commits and normalizes on blur`.
12. WHEN Stop 2 temperature is set above Stop 3 while "Preview wind" is
    playing THE SYSTEM SHALL show "Temperature stops must have ordered values
    and valid colors" in `#validation`, disable Apply, and keep the wall
    animating (at least one bottom-edge `.source` `--glow` or `--glow-alpha`
    changes across 10 frames).
    Test: `invalid stop order shows the error while the preview keeps painting the last valid draft`.

### hass gating (finding 5)

13. WHEN a new `hass` object is assigned whose four configured entity state
    objects are identical (same references) to the previous `hass` and only an
    unrelated entity changed THE SYSTEM SHALL not perform a Lit update
    (`performUpdate` count stays 0 after `await card.updateComplete`), while
    `card.hass` returns the new object.
    Test: `hass push with only unrelated entity changes does not re-render`.
14. WHEN a new `hass` object is assigned whose configuration entity state
    object is a new reference THE SYSTEM SHALL perform exactly one Lit update.
    Test: `hass push with a configured entity change re-renders once`.

### Frame loop (finding 6)

15. WHEN "Preview wind" is playing and hour, draft, forecast, mode and units
    are unchanged THE SYSTEM SHALL keep `#details`'s first element child the
    same node and `#details` and `#forecast-status` text identical across 10
    animation frames.
    Test: `details and forecast status are stable across frames while playing`.
16. WHEN "Preview wind" is playing THE SYSTEM SHALL change `--glow` or
    `--glow-alpha` on at least one bottom-edge `.source` across 10 frames;
    WHEN animations are paused THE SYSTEM SHALL leave every `.source` `--glow`
    and `--glow-alpha` unchanged across 10 frames.
    Test: `glow updates per frame only while playing`.
17. WHEN the inspected hour changes THE SYSTEM SHALL update `#details` (its
    eyebrow text changes) within one update cycle.
    Test: `details update when the inspected hour changes`.

### Viewport fill and container query (finding 7)

18. WHEN the card is mounted at 1440x900 THE SYSTEM SHALL size `article` to at
    most `innerHeight - 56` px, keep `footer.getBoundingClientRect().bottom <=
    innerHeight`, keep `header` and `footer` fully inside the viewport, and
    keep `.controls`'s bottom equal to `.editor`'s content bottom (criterion 1).
    Test: `at 1440x900 the card fills the viewport with header and footer visible`.
19. WHEN the viewport is 1440x600 THE SYSTEM SHALL keep the footer visible
    (`bottom <= innerHeight`) and let `.visual` scroll internally
    (`scrollHeight > clientHeight`), with `.wall` at its fixed height.
    Test: `short viewport scrolls the visual column, not the page`.
20. WHEN the card's own width is at or below 800px (demo `main` constrained to
    700px at a 1440x900 window) THE SYSTEM SHALL lay out `.workspace` as a
    single column, give `article` an `auto` height (page scrolls:
    `document.scrollHeight > innerHeight`), and let `.controls` grow
    (`scrollHeight === clientHeight`).
    Test: `stacked layout keys off card width, not window width`.
21. The existing `mobile layout keeps all 48 lights...` test in
    `editor.spec.js` keeps passing at 390x844.

### Parity, build, regressions

22. `web/display-model.js` is byte-identical to `main`
    (`git diff --quiet main -- web/display-model.js`). Test: `npm test` passes
    unchanged; `tests/editor.test.mjs` is not edited.
23. All nine existing tests in `tests/browser/editor.spec.js` and
    `tests/browser/antifragility.spec.js` pass with intent unchanged; selector
    edits only where the DOM forces them, noted in the commit.
24. `npm run build` succeeds and `dist/` (gitignored) contains the four
    files plus `vendor/lit-core.min.js`. No test; checked by the build
    command in Verification.
25. The manual owner-check for the forecast-hour slider drag documented in
    `web/demo.html` stays in place. Not automatable headless (see previous
    spec, Open Decision 4); owner hand-verifies at deploy.

## Scope / non-goals

- No change to `web/display-model.js`, the service contract
  (`script.edgelight_apply`, `{id, expectedRevision, config}`), public API
  (`setConfig`, `set hass`, `getCardSize()==12`, `getGridOptions()`, element
  name, `customCards` registration, four entity options and defaults), or the
  preserved feature list from SPEC-lit-card-rewrite.
- No new controls, no visual redesign beyond what theme derivation and the
  viewport-fill layout force.
- Deployment to HA is not part of this spec; the owner deploys `dist/`
  separately.
- No bundler; `edgelight.css` stays a linked stylesheet (previous spec,
  Decision 2).
- No photometric or wall-palette changes.

## Design

**Approach.** All changes land in the Lit card, its stylesheet, and the demo
harness; the model stays frozen. Lit owns structure and text; the
`requestAnimationFrame` loop owns only the per-LED glow style properties, as
the previous spec set up. The demo harness (`window.refresh`,
`window.deviceOnline`, `window.noAck`, `window.sent`) stays the browser-test
seam; two small additions make findings 3 and 5 checkable without a test-only
code path (see Test seams).

**Key changes.**

1. *Layout.* `:host` becomes the size container (`container-type:inline-size`;
   a container query cannot style the container itself, so the queried element
   is `article`, not `:host`). `article` is a column flexbox with a height of
   `calc(100dvh - var(--header-height, 56px))`: header and footer fixed,
   `.workspace` takes the rest with `min-height:0`. Both grid columns get
   `min-height:0` and `overflow:auto`; `.editor` is a column flexbox whose
   `.controls` is `flex:1; min-height:0; overflow:auto` with no `max-height`
   at any width. `.controls` gets `scrollbar-width:thin` plus an explicit
   `scrollbar-color`, which also turns off macOS overlay scrollbars. Inside the
   `@container (max-width: 800px)` block, `article` returns to `height:auto`
   and the columns to flow; the current `@media(max-width:800px)` rules move
   into that block unchanged. The demo page's chrome above the card is made
   exactly 56px tall with no body margin so the same formula fills the demo
   viewport; no new CSS variable is introduced.
2. *Theme.* `--surface: var(--ha-card-background, var(--card-background-color,
   #202526))`; `--text: var(--primary-text-color, #e7e8e5)`; `--muted:
   var(--secondary-text-color, #a8b0b1)`. Every hardcoded white-alpha or
   accent-alpha border/fill becomes `color-mix(in srgb, var(--text) N%,
   transparent)` or `color-mix(... var(--accent) ...)` at the same visual
   weight. `.wall`, `.bar`, the guide digits, the inspected marker, and the
   primary button's dark label keep fixed colors. `#validation` red stays.
3. *Apply timeout.* A `confirmTimeoutMs` instance field (default 10000). On
   timeout the card clears `pending`, keeps `dirty` and the draft, sets the
   unconfirmed message, and stashes the timed-out request as `unconfirmed`.
   `apply()` reuses `unconfirmed.id` when the draft deep-equals its `config`
   and `expectedRevision` still matches the accepted revision; otherwise it
   mints a new id. Confirmation, rejection, Discard and a new accepted
   revision clear `unconfirmed`. Apply's enabled state stays
   `online && accepted && !error && !conflict && (dirty || pending)`.
4. *Last valid draft.* The card keeps `lastValidDraft`, refreshed whenever
   `validate(draft)` is empty. `paint()` renders from `lastValidDraft`, so an
   invalid draft (bad stop order, or a programmatic bad color) shows the footer
   error while the wall keeps animating. The hex text field commits on
   `input` only when the value matches `/^#[0-9a-f]{6}$/i`; on `change`/`blur`
   it writes back the draft's current value (uppercased). The color picker
   input is unchanged.
5. *hass gating.* `set hass` stores the object, then compares the state
   objects of the four configured entities by reference between old and new
   `hass`; only a difference runs the reconciliation and `requestUpdate()`.
   The first assignment always updates.
6. *Frame loop.* `#details` and `#forecast-status` move into the Lit template
   (no `innerHTML`, no hand `escape()`), computed from hour, draft, forecast,
   mode, units and a `time` snapshot taken at the last change of those inputs,
   so they do not animate. The "updated N minutes ago" age text re-evaluates
   once a minute via a timer, not per frame. `paint()` runs per frame only
   while `playing`; otherwise it runs once after each Lit update. The
   full-brightness frame is computed once per input change (or skipped when
   both brightnesses are 100), and only the per-LED glow properties are written
   per frame.

**Test seams.**

- Existing: `web/demo.html` harness globals and the card's shadow DOM,
  driven by Playwright.
- New, public: `confirmTimeoutMs` field on the card (default 10000). Tests set
  it to 50 before clicking Apply.
- New, none in the card: render counting wraps `card.performUpdate` on the
  instance from the test and awaits `card.updateComplete`; theme tests set CSS
  variables on the card element via `style.setProperty`; the container-query
  test constrains the demo's `main` width. Luminance is computed in the test
  from `getComputedStyle` values, accepting `rgb()`, `rgba()` and
  `color(srgb ...)` serializations (Chromium serializes `color-mix` results as
  the latter).
- Demo: chrome above the card becomes a 56px header so the viewport formula
  matches HA. No other demo behavior changes; the slider-drag manual note
  stays.

**Alternatives rejected.**

- A card-specific CSS variable for the viewport offset: not needed once the
  demo mimics HA's 56px header; HA already exposes `--header-height`.
- Reusing the request id unconditionally after timeout: a changed draft under
  an old id would confuse the device's idempotency handling.
- Per-frame details while playing (animated hex readout): the readout is a
  diagnostic; the wall already shows the animation. See Open decisions.
- Container query on `article` itself: invalid, a container query does not
  apply to its own container.

## Verification

```
npm test                    # node --test tests/editor.test.mjs (model parity, unchanged)
npx playwright test         # serves web/ on 127.0.0.1:8766 via scripts/serve.mjs
npm run build               # copies web/ into dist/ (gitignored)
git diff --quiet main -- web/display-model.js && echo model-frozen
```

Baseline before this spec: `npm test` green, `npx playwright test` 9/9 green.
No known-red tests.

Manual exercise: open `http://127.0.0.1:8766/` at 1440x900. Confirm header
and footer both visible, Colors tab scrolls with a visible thin scrollbar,
switching tabs lands at the top. Add
`style="--card-background-color:#fff;--primary-text-color:#141414;--secondary-text-color:#727272"`
to the card element in devtools and confirm readable dark-on-light. Set
`window.noAck=true`, edit, Apply, wait 10s, confirm controls re-enable and the
draft survives. Type `#FF` into Rain hex and confirm the wall keeps animating.

## UI?

Yes. At the merge gate eyeball in the demo: (1) card fills the viewport at
1440x900 with footer visible and no dead space under the controls pane; (2)
light-theme variables produce dark text on a light surface with visible
borders, and the wall keeps its grey/dark-bar look; (3) below 800px card width
the layout stacks and the page scrolls normally; (4) the slider-drag manual
check in `demo.html`.

## Open decisions

All three resolved by the owner on 2026-09-12 (chat approval):

1. **Details hex readout while playing.** Resolved: snapshot. `#details`
   shows the Top/Bottom hex from a `time` snapshot taken when
   hour/draft/forecast change; it does not shimmer per frame while animations
   play.
2. **Age text cadence.** Resolved: "updated N minutes ago" ticks once per
   minute via a timer, not per frame.
3. **Request-id reuse after timeout.** Resolved: reuse the request id only
   for an unchanged draft at the same expected revision; otherwise generate a
   new id.
