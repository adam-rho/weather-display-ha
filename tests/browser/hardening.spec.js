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
