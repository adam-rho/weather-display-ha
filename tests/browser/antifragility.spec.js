import { test, expect } from '@playwright/test';

// Each test lands a `hass` update (via window.refresh()) in the middle of a live
// interaction. All four pass because Lit diffs the DOM instead of rebuilding it.
// They fail on the old innerHTML-rebuild card: draw() destroyed and recreated the
// shadow DOM on every hass update, which reset scrollTop, dropped focus, killed the
// in-flight click, and aborted the slider drag.

const card = 'edgelight-display-card';

test('scroll position of the controls pane survives a hass update',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  const controls=page.locator('.controls');
  const before=await controls.evaluate(el=>{el.scrollTop=200;return el.scrollTop;});
  expect(before).toBeGreaterThan(0); // section is taller than the pane, so it scrolls
  await page.evaluate(()=>window.refresh());
  const after=await controls.evaluate(el=>el.scrollTop);
  expect(after).toBe(before); // old card reset this to 0
});

test('focused control stays focused across a hass update',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>document.querySelector('edgelight-display-card').shadowRoot.getElementById('hour').focus());
  await page.evaluate(()=>window.refresh());
  const focusedId=await page.evaluate(()=>document.querySelector('edgelight-display-card').shadowRoot.activeElement?.id);
  expect(focusedId).toBe('hour'); // old card lost focus on rebuild
});

test('a section tab acts on a single click even with a hass update mid-click',async({page})=>{
  await page.goto('/');
  const tab=page.getByRole('button',{name:'Colors',exact:true});
  const box=await tab.boundingBox();
  const cx=box.x+box.width/2, cy=box.y+box.height/2;
  await page.mouse.move(cx,cy);
  await page.mouse.down();
  await page.evaluate(()=>window.refresh()); // update lands between mousedown and mouseup
  await page.mouse.up();
  // old card destroyed the button between down and up, so mouseup found no target and
  // no click fired; the section did not switch on this single press.
  await expect(page.getByRole('heading',{name:'Temperature colors'})).toBeVisible();
});

// Bug 4 (forecast-hour slider drag). Driving a native <input type=range> thumb with
// synthetic mouse events does not move the value in headless Chromium (a plain drag and
// a track click both leave it at 0), so the value-based assertion the spec names is not a
// reliable headless check. Per SPEC Open Decision 4, that specific check falls back to a
// documented, owner-verified manual step in web/demo.html.
//
// What IS automated here is the structural root cause of bug 4: a hass update must not
// replace the slider's DOM node. If the same <input#hour> element survives the update, an
// in-flight pointer capture (the browser's drag) survives with it. The old innerHTML
// rebuild created a brand-new node on every update, which is exactly what aborted the drag.
test('forecast-hour slider node survives a hass update (drag not torn down)',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{const sr=document.querySelector('edgelight-display-card').shadowRoot;window.__hourNode=sr.getElementById('hour');});
  await page.evaluate(()=>window.refresh()); // update lands mid-drag
  const same=await page.evaluate(()=>document.querySelector('edgelight-display-card').shadowRoot.getElementById('hour')===window.__hourNode);
  expect(same).toBe(true); // old card replaced the node here, releasing the drag
});
