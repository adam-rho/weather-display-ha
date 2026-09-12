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
