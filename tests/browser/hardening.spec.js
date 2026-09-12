import { test, expect } from '@playwright/test';

// Hardening spec (SPEC-card-hardening): viewport-fill layout, theme derivation,
// apply lockout, hex commit, render gating, frame-loop cost.
test.use({viewport:{width:1440,height:900}});


// ---- finding 1: controls pane ----

test('controls pane has no fixed max-height and fills the editor column',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  const m=await page.evaluate(()=>{
    const sr=document.querySelector('edgelight-display-card').shadowRoot;
    const controls=sr.querySelector('.controls'),editor=sr.querySelector('.editor');
    return {maxHeight:getComputedStyle(controls).maxHeight,
      scrollHeight:controls.scrollHeight,clientHeight:controls.clientHeight,
      controlsBottom:controls.getBoundingClientRect().bottom,
      editorContentBottom:editor.getBoundingClientRect().bottom-parseFloat(getComputedStyle(editor).paddingBottom)};
  });
  expect(m.maxHeight).toBe('none');
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
  expect(Math.abs(m.controlsBottom-m.editorContentBottom)).toBeLessThanOrEqual(1);
});

test('switching tabs resets the controls scroll to top',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  const scrolled=await page.evaluate(()=>{
    const c=document.querySelector('edgelight-display-card').shadowRoot.querySelector('.controls');
    c.scrollTop=300;return c.scrollTop;});
  expect(scrolled).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Animations',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Wind shimmer'})).toBeVisible();
  expect(await page.evaluate(()=>document.querySelector('edgelight-display-card').shadowRoot.querySelector('.controls').scrollTop)).toBe(0);
});

test('controls pane shows an always-visible thin scrollbar',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  const m=await page.evaluate(()=>{
    const c=document.querySelector('edgelight-display-card').shadowRoot.querySelector('.controls');
    const s=getComputedStyle(c);
    return {overflows:c.scrollHeight>c.clientHeight,width:s.scrollbarWidth,color:s.scrollbarColor};});
  expect(m.overflows).toBe(true);
  expect(m.width).toBe('thin');
  expect(m.color).not.toBe('auto');
});

// ---- finding 7: viewport fill and container query ----

test('at 1440x900 the card fills the viewport with header and footer visible',async({page})=>{
  await page.goto('/');
  const m=await page.evaluate(()=>{
    const sr=document.querySelector('edgelight-display-card').shadowRoot;
    const r=el=>{const b=sr.querySelector(el).getBoundingClientRect();return {top:b.top,bottom:b.bottom,height:b.height};};
    const editor=sr.querySelector('.editor');
    return {article:r('article'),header:r('header'),footer:r('footer'),
      controlsBottom:sr.querySelector('.controls').getBoundingClientRect().bottom,
      editorContentBottom:editor.getBoundingClientRect().bottom-parseFloat(getComputedStyle(editor).paddingBottom),
      innerHeight:window.innerHeight};});
  expect(m.article.height).toBeLessThanOrEqual(m.innerHeight-56);
  expect(m.footer.bottom).toBeLessThanOrEqual(m.innerHeight);
  expect(m.header.top).toBeGreaterThanOrEqual(0);
  expect(m.header.bottom).toBeLessThanOrEqual(m.innerHeight);
  expect(m.footer.top).toBeGreaterThanOrEqual(0);
  expect(Math.abs(m.controlsBottom-m.editorContentBottom)).toBeLessThanOrEqual(1);
});

test('short viewport scrolls the visual column, not the page',async({page})=>{
  await page.setViewportSize({width:1440,height:600});
  await page.goto('/');
  const m=await page.evaluate(()=>{
    const sr=document.querySelector('edgelight-display-card').shadowRoot;
    const visual=sr.querySelector('.visual');
    return {footerBottom:sr.querySelector('footer').getBoundingClientRect().bottom,
      scrollHeight:visual.scrollHeight,clientHeight:visual.clientHeight,
      wall:sr.querySelector('.wall').getBoundingClientRect().height,
      innerHeight:window.innerHeight};});
  expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight);
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
  expect(m.wall).toBe(265);
});

test('stacked layout keys off card width, not window width',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{document.querySelector('main').style.maxWidth='700px';});
  const m=await page.evaluate(()=>{
    const sr=document.querySelector('edgelight-display-card').shadowRoot;
    const controls=sr.querySelector('.controls');
    return {columns:getComputedStyle(sr.querySelector('.workspace')).gridTemplateColumns,
      articleHeight:sr.querySelector('article').getBoundingClientRect().height,
      cardWidth:document.querySelector('edgelight-display-card').getBoundingClientRect().width,
      pageScroll:document.documentElement.scrollHeight,innerHeight:window.innerHeight,
      scrollHeight:controls.scrollHeight,clientHeight:controls.clientHeight};});
  expect(m.cardWidth).toBeLessThanOrEqual(800);
  expect(m.columns.split(' ').length).toBe(1);      // single column
  expect(m.articleHeight).toBeGreaterThan(m.innerHeight-56); // auto height, not clamped to the viewport formula
  expect(m.pageScroll).toBeGreaterThan(m.innerHeight);  // the page scrolls, not the panes
  expect(m.scrollHeight).toBe(m.clientHeight);          // controls grow instead of scrolling
});

// ---- finding 2: theme derivation ----

// Chromium serializes color-mix() results as color(srgb ...), plain colors as rgb()/rgba().
const channels=s=>{
  let m=s.match(/^color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/);
  if(m)return [+m[1],+m[2],+m[3]];
  m=s.match(/^rgba?\(([^)]+)\)/);
  if(m){const p=m[1].split(/[\s,/]+/).filter(Boolean).map(Number);return [p[0]/255,p[1]/255,p[2]/255];}
  throw new Error('unparsed color: '+s);
};
const luminance=s=>{const [r,g,b]=channels(s).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return .2126*r+.7152*g+.0722*b;};

// HA's default light theme sets --card-background-color, never --ha-card-background.
const lightTheme=page=>page.evaluate(()=>{const c=document.querySelector('edgelight-display-card');
  c.style.setProperty('--card-background-color','#fff');
  c.style.setProperty('--primary-text-color','#141414');
  c.style.setProperty('--secondary-text-color','#727272');});

const probe=page=>page.evaluate(()=>{
  const sr=document.querySelector('edgelight-display-card').shadowRoot;
  const colorOf=sel=>getComputedStyle(sr.querySelector(sel)).color;
  return {surface:getComputedStyle(sr.querySelector('article')).backgroundColor,
    text:{article:colorOf('article'),label:colorOf('.controls label'),hex:colorOf('.hex'),footer:colorOf('footer')},
    borders:[...sr.querySelectorAll('button,select')].map(el=>getComputedStyle(el).borderTopColor)};
});

test('card is readable in HA light theme',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  await lightTheme(page);
  const m=await probe(page);
  const surface=luminance(m.surface);
  expect(surface).toBeGreaterThan(.8);
  for(const [name,color] of Object.entries(m.text))
    expect(luminance(color),`${name} text`).toBeLessThan(.25);
  expect(m.borders.length).toBeGreaterThan(0);
  for(const border of m.borders)
    expect(Math.abs(luminance(border)-surface),`border ${border}`).toBeGreaterThanOrEqual(.05);
});

// The default (no theme variables) case. "Text" here is the card's primary text,
// var(--text); secondary text (var(--muted), labels and the footer) is deliberately
// dimmer and is covered by the light-theme criterion above.
test('card is readable in dark theme by default',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  const m=await probe(page);
  expect(luminance(m.surface)).toBeLessThan(.25);
  expect(luminance(m.text.article)).toBeGreaterThan(.7);
  expect(luminance(m.text.hex)).toBeGreaterThan(.7);
});

test('wall preview palette does not follow the theme',async({page})=>{
  await page.goto('/');
  const paint=()=>page.evaluate(()=>{
    const sr=document.querySelector('edgelight-display-card').shadowRoot;
    return ['.wall','.bar'].map(sel=>{const s=getComputedStyle(sr.querySelector(sel));
      return s.backgroundColor+' | '+s.backgroundImage;});});
  const dark=await paint();
  await lightTheme(page);
  expect(await paint()).toEqual(dark);
});

// ---- finding 3: apply lockout ----

// Apply with the device silent, at a 50ms confirmation timeout instead of 10s.
const applyUnconfirmed=async page=>{
  await page.evaluate(()=>{document.querySelector('edgelight-display-card').confirmTimeoutMs=50;
    window.noAck=true;window.refresh();});
  await page.getByLabel('Top edge assignment').selectOption('conditions');
  await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  await expect(page.getByText('Unconfirmed. Check the display connection, then retry.')).toBeVisible();
};

test('apply timeout re-enables editing and keeps the draft',async({page})=>{
  await page.goto('/');
  await applyUnconfirmed(page);
  await expect(page.getByLabel('Top edge assignment')).toHaveValue('conditions');
  await expect(page.getByLabel('Top edge assignment')).toBeEnabled();
  await expect(page.getByRole('button',{name:'Restore defaults'})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Apply changes',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  await expect(page.getByLabel('Rain hex',{exact:true})).toBeEnabled();
});

test('after a timeout Apply follows online state while editing stays open',async({page})=>{
  await page.goto('/');
  await applyUnconfirmed(page);
  const apply=page.getByRole('button',{name:'Apply changes',exact:true});
  await page.evaluate(()=>{window.deviceOnline=false;window.refresh();});
  await expect(apply).toBeDisabled();
  await expect(page.getByLabel('Top edge assignment')).toBeEnabled();
  await expect(page.getByRole('button',{name:'Restore defaults'})).toBeEnabled();
  await page.evaluate(()=>{window.deviceOnline=true;window.refresh();});
  await expect(apply).toBeEnabled();
});

test('retry after timeout reuses the request id only for an unchanged draft',async({page})=>{
  await page.goto('/');
  await applyUnconfirmed(page);
  await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  await expect(page.getByText('Unconfirmed. Check the display connection, then retry.')).toBeVisible();
  await page.getByLabel('Bottom edge assignment').selectOption('off');
  await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  const sent=await page.evaluate(()=>window.sent.map(c=>c.id));
  expect(sent).toHaveLength(3);
  expect(sent[1]).toBe(sent[0]); // unchanged draft: same request, same id
  expect(sent[2]).not.toBe(sent[0]); // edited draft: a new request
});

// ---- finding 4: hex input and invalid drafts ----

// Sample hours 5-7 carry condition code 8 (rain), so bottom-edge LED 5 is painted from
// the Rain color and, with no wind or lightning at that hour, holds still between frames.
const rainGlow=page=>page.evaluate(()=>document.querySelector('edgelight-display-card')
  .shadowRoot.querySelector('.bottom .source[data-led="5"]').style.getPropertyValue('--glow'));
const rainDraft=page=>page.evaluate(()=>document.querySelector('edgelight-display-card').draft.conditions[4]);
// Snapshot every bottom-edge LED once per animation frame.
const bottomFrames=(page,count)=>page.evaluate(async count=>{
  const sr=document.querySelector('edgelight-display-card').shadowRoot;
  const leds=[...sr.querySelectorAll('.bottom .source')];
  const snap=()=>leds.map(el=>el.style.getPropertyValue('--glow')+'/'+el.style.getPropertyValue('--glow-alpha')).join();
  const out=[snap()];
  for(let i=0;i<count;i++){await new Promise(requestAnimationFrame);out.push(snap());}
  return out;},count);

test('partial hex input does not commit, error, or freeze the preview',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  const before=await rainGlow(page);
  await page.getByLabel('Rain hex',{exact:true}).fill('#FF');
  await bottomFrames(page,2);
  expect(await rainDraft(page)).toBe('#43C47E');
  await expect(page.getByLabel('Rain picker',{exact:true})).toHaveValue('#43c47e');
  await expect(page.locator('#validation')).toHaveText('');
  expect(await rainGlow(page)).toBe(before);
  await page.getByLabel('Rain hex',{exact:true}).blur();
  await expect(page.getByLabel('Rain hex',{exact:true})).toHaveValue('#43C47E');
});

test('complete hex input commits and normalizes on blur',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  const before=await rainGlow(page);
  await page.getByLabel('Rain hex',{exact:true}).fill('#ff0000');
  await bottomFrames(page,2);
  expect((await rainDraft(page)).toUpperCase()).toBe('#FF0000');
  expect(await rainGlow(page)).not.toBe(before);
  await page.getByLabel('Rain hex',{exact:true}).blur();
  await expect(page.getByLabel('Rain hex',{exact:true})).toHaveValue('#FF0000');
});

test('invalid stop order shows the error while the preview keeps painting the last valid draft',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Animations',exact:true}).click();
  await page.getByRole('button',{name:'Preview wind',exact:true}).click();
  await page.getByRole('button',{name:'Colors',exact:true}).click();
  await page.getByLabel('Stop 2 temperature').fill('40'); // Stop 3 sits at 32F
  await page.getByLabel('Stop 2 temperature').blur();
  await expect(page.locator('#validation')).toHaveText('Temperature stops must have ordered values and valid colors');
  await expect(page.getByRole('button',{name:'Apply changes',exact:true})).toBeDisabled();
  const frames=await bottomFrames(page,10);
  expect(frames.some(f=>f!==frames[0])).toBe(true);
});

// ---- finding 5: hass gating ----

// Count Lit updates by wrapping performUpdate on the instance, then push a hass object
// that reuses every configured entity's state object except the one named.
const pushHass=(page,changedEntity)=>page.evaluate(async changedEntity=>{
  const card=document.querySelector('edgelight-display-card');
  await card.updateComplete;
  let renders=0;const inner=card.performUpdate.bind(card);
  card.performUpdate=()=>{renders++;return inner();};
  const previous=card.hass;
  const states={...previous.states,'sensor.unrelated_thing':{state:String(Math.random())}};
  if(changedEntity)states[changedEntity]={...previous.states[changedEntity]};
  const next={...previous,states};
  card.hass=next;
  await card.updateComplete;
  return {renders,stored:card.hass===next};},changedEntity);

test('hass push with only unrelated entity changes does not re-render',async({page})=>{
  await page.goto('/');
  const m=await pushHass(page,null);
  expect(m.renders).toBe(0);
  expect(m.stored).toBe(true);
});

test('hass push with a configured entity change re-renders once',async({page})=>{
  await page.goto('/');
  const m=await pushHass(page,'sensor.edgelight_configuration');
  expect(m.renders).toBe(1);
  expect(m.stored).toBe(true);
});

// ---- finding 6: frame loop ----

const previewWind=async page=>{
  await page.getByRole('button',{name:'Animations',exact:true}).click();
  await page.getByRole('button',{name:'Preview wind',exact:true}).click();
};

test('details and forecast status are stable across frames while playing',async({page})=>{
  await page.goto('/');
  await previewWind(page);
  const m=await page.evaluate(async()=>{
    const sr=document.querySelector('edgelight-display-card').shadowRoot;
    const details=sr.querySelector('#details'),status=sr.querySelector('#forecast-status');
    const first=details.firstElementChild;
    const snap=()=>details.textContent+' | '+status.textContent;
    const texts=[snap()];let sameNode=true;
    for(let i=0;i<10;i++){await new Promise(requestAnimationFrame);
      texts.push(snap());if(details.firstElementChild!==first)sameNode=false;}
    return {texts,sameNode,hadChild:!!first};});
  expect(m.hadChild).toBe(true);
  expect(m.sameNode).toBe(true);
  expect([...new Set(m.texts)]).toHaveLength(1);
});

test('glow updates per frame only while playing',async({page})=>{
  await page.goto('/');
  await previewWind(page);
  const playing=await bottomFrames(page,10);
  expect(playing.some(f=>f!==playing[0])).toBe(true);
  await page.getByRole('button',{name:'Pause animations',exact:true}).click();
  const paused=await bottomFrames(page,10);
  expect(paused.every(f=>f===paused[0])).toBe(true);
});

test('details update when the inspected hour changes',async({page})=>{
  await page.goto('/');
  await previewWind(page);
  const before=await page.evaluate(async()=>{const card=document.querySelector('edgelight-display-card');
    await card.updateComplete;
    return card.shadowRoot.querySelector('#details .eyebrow').textContent;});
  // No animation frame runs between the input event and updateComplete, so this is
  // strictly "within one update cycle", not "by the next paint".
  const after=await page.evaluate(async()=>{
    const card=document.querySelector('edgelight-display-card');
    const hour=card.shadowRoot.getElementById('hour');
    hour.value='2';hour.dispatchEvent(new Event('input'));
    await card.updateComplete;
    return card.shadowRoot.querySelector('#details .eyebrow').textContent;});
  expect(before).not.toBe('');
  expect(after).not.toBe(before);
});
