import { test, expect } from '@playwright/test';

// Clicking an LED's glow must select that LED's hour. The blurred glow of each
// source used to spill 70% over its neighbours and take the click, so a click on
// LED 40 landed on the later sibling (LED 39). The glow is now pointer-events:none
// and each source is a tall hit box that covers its own glow only.
const sr=()=>document.querySelector('edgelight-display-card').shadowRoot;

async function clickGlow(page,edge,hour,dy){
  const box=await page.evaluate(([edge,hour])=>{const r=sr().querySelector(`.edge.${edge} .source[data-hour="${hour}"]`).getBoundingClientRect();return {x:r.x+r.width/2,top:r.top,bottom:r.bottom};},[edge,hour]);
  await page.mouse.click(box.x,edge==='top'?box.bottom-dy:box.top+dy);
  return page.evaluate(()=>{const c=document.querySelector('edgelight-display-card');return {hour:c.hour,led:c.shadowRoot.querySelector('.edge.top .source.inspected').dataset.led};});
}

test('clicking in the glow above a top-edge LED selects that LED, not its neighbour',async({page})=>{
  page.addInitScript(()=>{});
  await page.goto('/');
  await page.evaluate(()=>{window.sr=()=>document.querySelector('edgelight-display-card').shadowRoot;});
  for(const [hour,led] of [[7,'40'],[12,'35'],[0,'47'],[23,'24']]){
    for(const dy of [10,30,50]) expect(await clickGlow(page,'top',hour,dy)).toEqual({hour,led});
  }
});

test('clicking in the glow below a bottom-edge LED selects that LED',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{window.sr=()=>document.querySelector('edgelight-display-card').shadowRoot;});
  for(const [hour,led] of [[7,'40'],[16,'31']]){
    for(const dy of [10,30,50]) expect(await clickGlow(page,'bottom',hour,dy)).toEqual({hour,led});
  }
});

test('the guide labels do not steal LED clicks',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{window.sr=()=>document.querySelector('edgelight-display-card').shadowRoot;});
  await page.evaluate(()=>{const g=sr().getElementById('guide');g.checked=true;g.dispatchEvent(new Event('change'));});
  expect(await clickGlow(page,'top',7,30)).toEqual({hour:7,led:'40'});
});
