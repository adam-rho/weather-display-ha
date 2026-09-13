import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, render, validate, sample, ledFor, origins, normalize } from '../web/display-model.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('preview follows physical row assignments and ordered temperature colors', () => {
  const config = defaults();
  const forecast = {h: Array.from({length:24}, (_, h) => [4,h===0?8:1,0,0,0,h===0?0:90])};
  assert.equal(render(config,forecast,0)[47], 0x0000FF);
  assert.equal(render(config,forecast,0)[24], 0xCF0000);
  config.top='conditions'; config.bottom='off';
  const frame=render(config,forecast,0);
  assert.equal(frame[47],0x43C47E);
  assert.ok(frame.slice(0,24).every(c=>c===0));
  config.temperature[1].value=-100;
  assert.ok(validate(config));
});

test('browser and real firmware renderer agree for edits, effects and legacy data', () => {
  const folder=mkdtempSync(join(tmpdir(),'edgelight-parity-'));
  try {
    const binary=join(folder,'renderer');
    execFileSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-Iinclude','-I.pio/libdeps/esp32dev/ArduinoJson/src','tests/display_cli.cpp','-o',binary]);
    const requests=[];
    for(const top of ['temperature','conditions','off'])for(const bottom of ['temperature','conditions','off']){
      const c=defaults(); c.top=top;c.bottom=bottom;
      for(const time of [0,1500,10001,10600,11000,11500,12600,17000])requests.push({config:structuredClone(c),forecast:sample(),time});
      c.conditions=['#000000','#FFFFFF','#123456','#AE8766','#BDBDBD','#F2B500','#123456'];
      c.temperature=[{value:-20,color:'#FFFFFF'},{value:40,color:'#0000FF'},{value:120,color:'#FF0000'}];
      c.animations.wind.target='both';c.animations.wind.speed=2.3;c.animations.wind.strength=43;
      c.animations.lightning.color='#2233AA';c.animations.lightning.speed=.7;
      const f=sample();f.h[0][2]=1;
      for(const time of [100,1500,15800,20000])requests.push({config:structuredClone(c),forecast:f,time});
      requests.push({config:c,forecast:{h:f.h.map(h=>h.slice(0,5))},time:0});
    }
    // Every wiring layout, with wind shimmer on (its noise is keyed by physical LED).
    for(const origin of origins)for(const serpentine of [true,false]){
      const c=defaults();c.layout={origin,serpentine};c.top='conditions';c.animations.wind.target='both';
      requests.push({config:c,forecast:sample(),time:1500});
    }
    const legacy=defaults();delete legacy.layout;requests.push({config:legacy,forecast:sample(),time:0});
    const output=execFileSync(binary,[],{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8'}).trim().split('\n').map(JSON.parse);
    output.forEach((result,i)=>{
      assert.equal(result.error,'');
      const expected=render(requests[i].config,requests[i].forecast,requests[i].time);
      result.frame.forEach((color,led)=>{for(const shift of [0,8,16])assert.ok(Math.abs((color>>shift&255)-(expected[led]>>shift&255))<=1,`fixture ${i} LED ${led} channel ${shift}`);});
    });
  } finally { rmSync(folder,{recursive:true,force:true}); }
});

test('ledFor covers all eight wirings; configs without a layout mean the original wall', () => {
  const at=(origin,serpentine,row,hour)=>ledFor({layout:{origin,serpentine}},row,hour);
  assert.deepEqual([at('bottom-left',true,0,0),at('bottom-left',true,0,23),at('bottom-left',true,1,0),at('bottom-left',true,1,23)],[47,24,0,23]);
  assert.deepEqual([at('top-left',true,0,0),at('top-left',true,1,0)],[0,47]);
  assert.deepEqual([at('top-right',true,0,0),at('top-right',true,1,0)],[23,24]);
  assert.deepEqual([at('bottom-right',false,1,0),at('bottom-right',false,0,0)],[23,47]);
  for(const origin of origins)for(const serpentine of [true,false]){
    const leds=[0,1].flatMap(row=>Array.from({length:24},(_,h)=>at(origin,serpentine,row,h))).sort((a,b)=>a-b);
    assert.deepEqual(leds,Array.from({length:48},(_,i)=>i),`${origin} ${serpentine} is a permutation`);
  }
  const legacy=defaults();delete legacy.layout;
  assert.equal(validate(legacy),'');
  assert.equal(ledFor(legacy,0,0),47);
  assert.deepEqual(normalize(legacy).layout,{origin:'bottom-left',serpentine:true});
  assert.equal(validate({...defaults(),layout:{origin:'sideways',serpentine:true}}),'Invalid strip layout');
});

test('preview glow keeps hue and expresses dimming as intensity, never as black', async () => {
  const { glow } = await import('../web/display-model.js');
  assert.deepEqual(glow(0x000000), {color:0x000000, intensity:0});
  assert.deepEqual(glow(0xFF0000), {color:0xFF0000, intensity:1});
  const dim = glow(0x800000);
  assert.equal(dim.color, 0xFF0000);
  assert.ok(Math.abs(dim.intensity-128/255)<1e-9);
  const teal = glow(0x1A6070);
  assert.equal(teal.color, 0x3BDBFF);
  assert.ok(Math.abs(teal.intensity-0x70/255)<1e-9);
});

test('night hours render conditions at full color; legacy configs with a night key still validate', () => {
  const config = defaults(); config.nightBrightness = 100;   // isolate per-hour dimming from global night brightness
  assert.equal('night' in config, false);
  const hour = [4,4,0,0,0,60];                 // cloudy, day
  const day = render(config,{h:[hour]},0)[0];
  const night = render(config,{h:[[4,4,1,0,0,60]]},0)[0];
  assert.equal(night, day);
  assert.equal(validate({...config, night:true}), '');
});
