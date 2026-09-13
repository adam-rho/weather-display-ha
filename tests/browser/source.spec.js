import { test, expect } from '@playwright/test';

// Forecast source picker: reads input_select.edgelight_weather_source, writes it back
// through input_select.select_option, and the status line names the source in use.
test.use({viewport:{width:1440,height:900}});

test('source picker switches the helper and the status line follows the publisher',async({page})=>{
  await page.goto('/');
  const select=page.locator('#source'), status=page.locator('#forecast-status');
  await expect(select).toHaveValue('met.no');
  await expect(status).toContainText('Live forecast · met.no · updated');
  await select.selectOption('NWS');
  await expect(select).toHaveValue('NWS');
  await expect(status).toContainText('Live forecast · NWS · updated');
  await expect(status).not.toContainText('switching');
});

test('status says switching while the helper and the published forecast disagree',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{const card=document.querySelector('edgelight-display-card');
    const states=structuredClone(card.hass.states);
    states['input_select.edgelight_weather_source'].state='NWS';   // helper flipped, publisher not yet run
    card.hass={...card.hass,states};});
  await expect(page.locator('#forecast-status')).toContainText('· met.no · ');
  await expect(page.locator('#forecast-status')).toContainText('switching to NWS');
});

test('picker hides in sample mode and when the helper is absent',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Sample forecast'}).click();
  await expect(page.locator('#source')).toHaveCount(0);
  await page.getByRole('button',{name:'Live forecast'}).click();
  await expect(page.locator('#source')).toHaveCount(1);
  await page.evaluate(()=>{const card=document.querySelector('edgelight-display-card');
    const states=structuredClone(card.hass.states);delete states['input_select.edgelight_weather_source'];
    card.hass={...card.hass,states};});
  await expect(page.locator('#source')).toHaveCount(0);
  await expect(page.locator('#forecast-status')).toContainText('Live forecast · met.no · updated');
});
