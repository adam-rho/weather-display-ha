import { test, expect } from '@playwright/test';
test('edit an edge without publishing, then apply and wait for device confirmation',async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Edgelight'})).toBeVisible();
  await expect(page.locator('.source')).toHaveCount(48);
  await page.getByLabel('Top edge assignment').selectOption('conditions');
  await expect(page.getByText('Unsaved changes',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.sent.length)).toBe(0);
  await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  await expect(page.getByText('Applied to display',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.sent[0].config.top)).toBe('conditions');
  await page.getByRole('button',{name:'Sample forecast',exact:true}).click();
  expect(await page.evaluate(()=>window.sent.length)).toBe(1);
});

test('color edits, unit changes and sample controls stay local until apply',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  await page.getByLabel('Rain hex',{exact:true}).fill('#112233');
  await page.getByLabel('Rain hex',{exact:true}).blur();
  await page.getByLabel('Show precipitation strength').uncheck();
  await page.getByLabel('Temperature unit').selectOption('C');
  expect(await page.getByLabel('Stop 3 temperature').inputValue()).toBe('0');
  await page.getByRole('button',{name:'Add color stop'}).click();
  await expect(page.getByLabel('Stop 8 temperature')).toBeVisible();
  await page.getByRole('button',{name:'Discard changes'}).click();
  await expect(page.getByLabel('Rain hex',{exact:true})).toHaveValue('#43C47E');
  await page.getByRole('button',{name:'Animations',exact:true}).click();
  await page.getByRole('button',{name:'Preview lightning',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sample forecast',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>window.sent.length)).toBe(0);
});

test('offline display cannot apply; unconfirmed requests preserve their ID on retry',async({page})=>{
  await page.goto('/');
  await page.getByLabel('Top edge assignment').selectOption('off');
  await page.evaluate(()=>{window.deviceOnline=false;window.refresh();});
  await expect(page.getByRole('button',{name:'Apply changes',exact:true})).toBeDisabled();
  await page.evaluate(()=>{window.deviceOnline=true;window.noAck=true;window.refresh();});
  await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  await page.getByRole('button',{name:'Retry apply',exact:true}).click();
  expect(await page.evaluate(()=>window.sent[0].id===window.sent[1].id)).toBe(true);
  await expect(page.getByText('Applied to display',{exact:true})).toHaveCount(0);
});

test('selects reflect draft values that are not the first option',async({page})=>{
  await page.goto('/');
  // Default draft.bottom is 'conditions' (second option), not the first ('temperature').
  await expect(page.getByLabel('Bottom edge assignment')).toHaveValue('conditions');
  await page.getByRole('button',{name:'Animations',exact:true}).click();
  // Default wind threshold is 10 mph (second option), not the first (5 mph).
  await expect(page.getByLabel('Wind starts at')).toHaveValue('10');
  // Wind target default is 'conditions' (second option).
  await expect(page.getByLabel('Wind effect on')).toHaveValue('conditions');
});

test('mobile layout keeps all 48 lights, horizontal bar, and keyboard controls',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('.source')).toHaveCount(48);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Select top edge',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Top edge assignment')).toBeVisible();
  await page.getByLabel('LED guide',{exact:true}).check();
  await expect(page.locator('.wall')).toHaveClass(/guide/);
});
