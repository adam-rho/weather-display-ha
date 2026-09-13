import { test, expect } from '@playwright/test';

// Strip wiring: the layout is device config. Changing it flips the LED guide numbers and
// the edge hint immediately, and Apply sends it to the display.
test.use({viewport:{width:1440,height:900}});

test('changing the LED 0 corner renumbers the guide, updates the hint, and applies',async({page})=>{
  await page.goto('/');
  await page.locator('#guide').check();
  const topLeft=page.locator('.edge.top .source').first(), bottomLeft=page.locator('.edge.bottom .source').first();
  await expect(topLeft).toHaveAttribute('data-led','47');
  await expect(bottomLeft).toHaveAttribute('data-led','0');
  await expect(page.locator('.hint')).toHaveText('Top: LED 47 at the left, LED 24 at the right.');
  await page.locator('select[data-path="layout.origin"]').selectOption('top-left');
  await expect(topLeft).toHaveAttribute('data-led','0');
  await expect(bottomLeft).toHaveAttribute('data-led','47');
  await expect(page.locator('.hint')).toHaveText('Top: LED 0 at the left, LED 23 at the right.');
  await page.locator('input[data-path="layout.serpentine"]').uncheck();
  await expect(bottomLeft).toHaveAttribute('data-led','24');
  await page.getByRole('button',{name:'Apply changes'}).click();
  await expect(page.locator('#status')).toHaveText('Applied to display');
  expect(await page.evaluate(()=>window.sent.at(-1).config.layout)).toEqual({origin:'top-left',serpentine:false});
});

test('a display config saved before layouts existed edits as the original wall',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{const card=document.querySelector('edgelight-display-card');
    const states=structuredClone(card.hass.states),cfg=states['sensor.edgelight_configuration'].attributes;
    delete cfg.config.layout;cfg.revision+=1;card.hass={...card.hass,states};});
  await expect(page.locator('select[data-path="layout.origin"]')).toHaveValue('bottom-left');
  await expect(page.locator('input[data-path="layout.serpentine"]')).toBeChecked();
  await expect(page.locator('.edge.top .source').first()).toHaveAttribute('data-led','47');
});
