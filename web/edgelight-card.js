import {defaults,render,validate,hex,names,wetColor,sample,conditionBucket} from './display-model.js';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=o=>structuredClone(o);
const get=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
const set=(o,path,value)=>{const keys=path.split('.'),last=keys.pop();keys.reduce((v,k)=>v[k],o)[last]=value;};
const labels={temperature:'Temperature',conditions:'Conditions',off:'Off',both:'Both'};
const format=(n)=>Number(n.toFixed(2));
const requestId=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');

export class EdgelightDisplayCard extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'});this.accepted=null;this.draft=defaults();this.dirty=false;
    this.mode='live';this.edge='top';this.section='assignments';this.hour=0;this.guide=false;this.night='forecast';
    this.playing=!matchMedia('(prefers-reduced-motion: reduce)').matches;this.time=0;this.message='Waiting for display';this.units='F';}
  setConfig(config){this.config={configuration_entity:'sensor.edgelight_configuration',availability_entity:'binary_sensor.edgelight_connected',forecast_entity:'sensor.weather_display_hourly',result_entity:'sensor.edgelight_command_result',...config};this.draw();}
  getCardSize(){return 12;}
  getGridOptions(){return {columns:'full',min_columns:6};}
  set hass(hass){
    this._hass=hass;
    const state=hass.states[this.config?.configuration_entity]?.attributes;
    if(state?.config&&!validate(state.config)&&Number.isInteger(state.revision)){
      const changed=this.accepted&&state.revision!==this.accepted.revision;
      const confirmed=this.pending&&state.requestId===this.pending.id;
      if(confirmed){clearTimeout(this.timeout);this.pending=null;this.dirty=false;this.message='Applied to display';this.conflict=false;}
      else if(changed&&this.dirty){this.conflict=true;this.message='Settings changed elsewhere. Reload before applying.';}
      this.accepted=clone(state);
      if(!this.dirty)this.draft=clone(state.config);
    }
    const result=hass.states[this.config?.result_entity]?.attributes;
    if(this.pending&&result?.id===this.pending.id&&result.status==='rejected'){
      clearTimeout(this.timeout);this.pending=null;this.message=result.error||'Display rejected settings';
    }
    if(this.shadowRoot.activeElement?.matches('input')&&!this.pending){this.updateStatus();this.paint();}
    else this.draw();
  }
  connectedCallback(){this.start();this.draw();}
  disconnectedCallback(){cancelAnimationFrame(this.animation);clearTimeout(this.timeout);}
  start(){cancelAnimationFrame(this.animation);let last=performance.now();
    const tick=now=>{if(this.playing)this.time+=now-last;last=now;this.paint();this.animation=requestAnimationFrame(tick);};
    this.animation=requestAnimationFrame(tick);
  }
  get online(){return this._hass?.states[this.config?.availability_entity]?.state==='on';}
  forecast(){const f=this.mode==='sample'?sample():clone(this._hass?.states[this.config?.forecast_entity]?.attributes||{h:[]});
    if(this.mode==='sample'&&this.night!=='forecast')for(const h of f.h)h[2]=this.night==='night'?1:0;
    return f;
  }
  edit(path,value){set(this.draft,path,value);this.dirty=true;this.message='Unsaved changes';this.paint();this.updateStatus();}
  async apply(){
    if(!this.online||!this.accepted||this.conflict||validate(this.draft))return;
    if(!this.pending)this.pending={id:requestId(),expectedRevision:this.accepted.revision,config:clone(this.draft)};
    this.message='Waiting for display confirmation';this.draw();
    clearTimeout(this.timeout);this.timeout=setTimeout(()=>{this.message='Unconfirmed. Check the display connection, then retry.';this.draw();},10000);
    try{await this._hass.callService('script','edgelight_apply',{command:this.pending});}
    catch{clearTimeout(this.timeout);this.message='Could not send settings. Retry when connected.';this.draw();}
  }
  select(path,title,options){return `<label>${title}<select data-path="${path}" aria-label="${title}">${options.map(([v,t])=>`<option value="${v}" ${get(this.draft,path)===v?'selected':''}>${t}</option>`).join('')}</select></label>`;}
  toggle(path,title){return `<label class="toggle"><span>${title}</span><input type="checkbox" data-path="${path}" aria-label="${title}" ${get(this.draft,path)?'checked':''}></label>`;}
  slider(path,title,min,max,step=1){return `<label>${title}<span class="range"><input type="range" data-path="${path}" aria-label="${title}" min="${min}" max="${max}" step="${step}" value="${get(this.draft,path)}"><output>${format(get(this.draft,path))}</output></span></label>`;}
  color(path,title){const value=get(this.draft,path);return `<label class="color-row"><span>${title}</span><input type="color" data-path="${path}" aria-label="${title} picker" value="${value}"><input class="hex" data-path="${path}" aria-label="${title} hex" value="${escape(value)}" maxlength="7" spellcheck="false"></label>`;}
  controls(){
    const c=this.draft;
    if(this.section==='assignments')return `<h3>Choose what each edge shows</h3><p>Each light is one forecast hour. Both edges read from left to right.</p>${['top','bottom'].map(row=>this.select(row,`${row==='top'?'Top':'Bottom'} edge assignment`,Object.entries(labels).filter(([v])=>v!=='both'))).join('')}<div class="hint">${this.edge==='top'?'Top: LED 47 at the left, LED 24 at the right.':'Bottom: LED 0 at the left, LED 23 at the right.'}</div>`;
    if(this.section==='colors')return `<h3>Temperature colors</h3><p>Colors blend smoothly between stops.</p><label>Temperature unit<select id="units"><option ${this.units==='F'?'selected':''}>F</option><option ${this.units==='C'?'selected':''}>C</option></select></label><div class="stops">${c.temperature.map((s,i)=>`<div class="stop"><label>Stop ${i+1} °${this.units}<input type="number" data-stop="${i}" aria-label="Stop ${i+1} temperature" step="any" value="${format(this.units==='F'?s.value:(s.value-32)/1.8)}"></label>${this.color(`temperature.${i}.color`,`Stop ${i+1}`)}<button data-remove="${i}" aria-label="Remove stop ${i+1}" ${c.temperature.length<=2?'disabled':''}>×</button></div>`).join('')}</div><button id="add-stop" ${c.temperature.length>=16?'disabled':''}>Add color stop</button><h3>Condition colors</h3>${names.map((n,i)=>this.color(`conditions.${i}`,n)).join('')}${this.toggle('wet','Show precipitation strength')}<p>Light → medium → heavy. Derived from your Rain, Snow, and Sleet colors.</p><div class="wet-swatches">${[4,5,6].map(i=>`<div>${names[i]}${[1,4,8].map((p,j)=>`<span title="${['Light','Medium','Heavy'][j]}" style="background:${hex(wetColor(parseInt(c.conditions[i].slice(1),16),p))}"></span>`).join('')}</div>`).join('')}</div>${this.toggle('night','Dim and cool night conditions')}`;
    if(this.section==='animations')return ['breathing','wind','lightning'].map(name=>`<section><h3>${{breathing:'Sunrise / sunset breathing',wind:'Wind shimmer',lightning:'Lightning'}[name]}</h3>${this.toggle(`animations.${name}.enabled`,`${name[0].toUpperCase()+name.slice(1)} enabled`)}${this.slider(`animations.${name}.speed`,`${name} speed`,.25,4,.05)}${this.slider(`animations.${name}.strength`,`${name} strength`,0,100)}${name==='wind'?this.select('animations.wind.target','Wind effect on',[['temperature','Temperature'],['conditions','Conditions'],['both','Both']])+this.select('animations.wind.threshold','Wind starts at',[5,10,15,20,30,40,50].map(v=>[v,`${v} mph`])):''}${name==='lightning'?this.color('animations.lightning.color','Lightning bolt'):''}<button data-sample="${name}">Preview ${name}</button></section>`).join('');
    return `<h3>Room brightness</h3>${this.slider('dayBrightness','Day brightness',0,100,.1)}${this.slider('nightBrightness','Night brightness',0,100,.1)}<p>Applies to both edges after colors and effects. The preview approximates wall glow; actual brightness depends on your LEDs and room.</p>`;
  }
  draw(){if(!this.config||!this.isConnected)return;
    this.shadowRoot.innerHTML=`<link rel="stylesheet" href="${new URL('./edgelight.css',import.meta.url)}"><article>
      <header><div><span class="eyebrow">YOUR WALL, AT A GLANCE</span><h2>Edgelight</h2></div><span class="connection ${this.online?'online':''}">${this.online?'Display online':'Display offline'}</span></header>
      <div class="workspace"><div class="visual"><div class="modes"><button data-mode="live" aria-pressed="${this.mode==='live'}">Live forecast</button><button data-mode="sample" aria-pressed="${this.mode==='sample'}">Sample forecast</button></div>
      <div class="scene"><button class="edge-label top-label" data-edge="top">Top · ${labels[this.draft.top]}</button><div class="wall"><div class="edge top ${this.edge==='top'?'selected':''}" data-edge="top" role="button" tabindex="0" aria-label="Select top edge">${this.sources(0)}</div><div class="bar"></div><div class="edge bottom ${this.edge==='bottom'?'selected':''}" data-edge="bottom" role="button" tabindex="0" aria-label="Select bottom edge">${this.sources(1)}</div></div><button class="edge-label bottom-label" data-edge="bottom">Bottom · ${labels[this.draft.bottom]}</button><div class="timeline"><span>Now</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+23h</span></div></div>
      <div class="preview-tools"><button id="play">${this.playing?'Pause animations':'Play animations'}</button><label class="toggle">LED guide<input id="guide" type="checkbox" ${this.guide?'checked':''}></label>${this.mode==='sample'?`<label>Sample lighting<select id="night"><option value="forecast">Day and night</option><option value="day">All day</option><option value="night">All night</option></select></label>`:''}</div>
      <label class="hour-picker">Inspect forecast hour<input id="hour" type="range" min="0" max="23" value="${this.hour}" aria-label="Forecast hour"></label><div class="details" id="details"></div><p class="forecast-status" id="forecast-status"></p>
      </div><div class="editor"><nav>${[['assignments','Edges'],['colors','Colors'],['animations','Animations'],['brightness','Brightness']].map(([id,title])=>`<button data-section="${id}" aria-pressed="${this.section===id}">${title}</button>`).join('')}</nav><div class="controls">${this.controls()}</div></div></div>
      <footer><div><span id="status" role="status"></span><span id="validation"></span></div><div class="actions"><button id="defaults">Restore defaults</button><button id="discard">${this.conflict?'Reload settings':'Discard changes'}</button><button class="primary" id="apply">${this.pending?'Retry apply':'Apply changes'}</button></div></footer></article>`;
    this.bind();this.updateStatus();this.paint();
  }
  sources(row){return Array.from({length:24},(_,h)=>`<span class="source" data-hour="${h}" data-led="${row===0?47-h:h}"><i>${row===0?47-h:h}</i></span>`).join('');}
  bind(){const root=this.shadowRoot;
    root.querySelectorAll('[data-path]').forEach(el=>el.addEventListener('input',()=>{
      let value=el.type==='checkbox'?el.checked:el.type==='range'||el.dataset.path.endsWith('threshold')?Number(el.value):el.value;
      this.edit(el.dataset.path,value);if(el.type==='range')el.nextElementSibling.value=format(value);
      if(el.type==='color'){const other=root.querySelector(`.hex[data-path="${el.dataset.path}"]`);if(other)other.value=value;}
    }));
    root.querySelectorAll('select[data-path]').forEach(el=>el.addEventListener('change',()=>this.draw()));
    root.querySelectorAll('[data-stop]').forEach(el=>el.addEventListener('change',()=>{this.edit(`temperature.${el.dataset.stop}.value`,el.value===''?NaN:this.units==='F'?Number(el.value):Number(el.value)*1.8+32);}));
    root.querySelectorAll('[data-section]').forEach(el=>el.onclick=()=>{this.section=el.dataset.section;this.draw();});
    root.querySelectorAll('[data-edge]').forEach(el=>{const select=()=>{this.edge=el.dataset.edge;this.section='assignments';this.draw();};el.onclick=select;el.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select();}};});
    root.querySelectorAll('[data-mode]').forEach(el=>el.onclick=()=>{this.mode=el.dataset.mode;this.draw();});
    root.querySelectorAll('[data-hour]').forEach(el=>el.onclick=e=>{e.stopPropagation();this.hour=Number(el.dataset.hour);root.querySelector('#hour').value=this.hour;this.paint();});
    root.querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{this.draft.temperature.splice(Number(el.dataset.remove),1);this.dirty=true;this.message='Unsaved changes';this.draw();});
    const on=(id,event,handler)=>root.querySelector('#'+id)?.addEventListener(event,handler);
    on('apply','click',()=>this.apply());
    on('discard','click',()=>{clearTimeout(this.timeout);this.pending=null;this.conflict=false;this.dirty=false;this.draft=clone(this.accepted?.config||defaults());this.message='Changes discarded';this.draw();});
    on('defaults','click',()=>{this.draft=defaults();this.dirty=true;this.message='Unsaved changes';this.draw();});
    on('play','click',()=>{this.playing=!this.playing;this.draw();});
    on('guide','change',e=>{this.guide=e.target.checked;this.paint();});
    on('hour','input',e=>{this.hour=Number(e.target.value);this.paint();});
    on('units','change',e=>{this.units=e.target.value;this.draw();});
    on('night','change',e=>{this.night=e.target.value;this.paint();});
    if(root.querySelector('#night'))root.querySelector('#night').value=this.night;
    on('add-stop','click',()=>{const s=this.draft.temperature;let index=0;for(let i=1;i<s.length-1;i++)if(s[i+1].value-s[i].value>s[index+1].value-s[index].value)index=i;
      s.splice(index+1,0,{value:(s[index].value+s[index+1].value)/2,color:s[index].color});this.dirty=true;this.message='Unsaved changes';this.draw();});
    root.querySelectorAll('[data-sample]').forEach(el=>el.onclick=()=>{this.mode='sample';this.time=el.dataset.sample==='lightning'?10000:el.dataset.sample==='breathing'?1500:0;this.hour=el.dataset.sample==='breathing'?18:14;this.playing=true;this.draw();});
  }
  updateStatus(){const root=this.shadowRoot;if(!root.querySelector('#status'))return;
    const error=validate(this.draft);root.querySelector('#validation').textContent=error;
    root.querySelector('#status').textContent=this.message==='Waiting for display'&&this.accepted?'Display settings loaded':this.message;
    root.querySelector('#apply').disabled=!this.online||!this.accepted||!!error||!!this.conflict||(!this.dirty&&!this.pending);
    root.querySelectorAll('.controls input,.controls select,.controls button,#defaults').forEach(el=>el.disabled=!!this.pending||el.hasAttribute('data-remove')&&this.draft.temperature.length<=2||el.id==='add-stop'&&this.draft.temperature.length>=16);
  }
  paint(){const root=this.shadowRoot;if(!root.querySelector('.wall')||validate(this.draft))return;
    const f=this.forecast(),frame=render(this.draft,f,this.time);
    root.querySelectorAll('.source').forEach(el=>{const color=hex(frame[Number(el.dataset.led)]);el.style.setProperty('--light',color);el.classList.toggle('inspected',Number(el.dataset.hour)===this.hour);});
    root.querySelector('.wall').classList.toggle('guide',this.guide);
    const e=f.h?.[this.hour],legacy=e&&e.length<6;
    const timestamp=f.times?.[this.hour], date=timestamp?new Date(timestamp):null;
    const when=date&&!Number.isNaN(date.valueOf())?date.toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'}):`Hour ${this.hour}`;
    const a=this.draft.animations,effects=[];
    const assigned=[this.draft.top,this.draft.bottom];
    if(e){
      const wb=e[4]||0, windy=wb>=1&&wb<=8?[0,0,5,10,15,20,30,40,50][wb]>=a.wind.threshold:[5,6].includes(e[1]);
      if(windy&&a.wind.enabled&&a.wind.strength>0&&assigned.some(c=>c!=='off'&&(a.wind.target==='both'||a.wind.target===c)))effects.push('Wind shimmer');
      if(e[1]===11&&assigned.includes('conditions')&&a.lightning.enabled&&a.lightning.strength>0)effects.push('Lightning');
      if(this.hour>0&&e[2]!==f.h[this.hour-1][2]&&assigned.includes('temperature')&&a.breathing.enabled&&a.breathing.strength>0)effects.push('Sunrise/sunset breathing');
    }
    root.querySelector('#details').innerHTML=e?`<div><span class="eyebrow">${escape(when)} ${e[2]?'· NIGHT':''}</span><strong>${escape(names[conditionBucket(e[1])-1]||'No condition data')}</strong><small>${effects.join(' · ')||'No active effects'}</small></div><div>${Number.isFinite(e[5])?format(this.units==='F'?e[5]:(e[5]-32)/1.8)+'°'+this.units:legacy?'Bucket '+e[0]:'No temperature data'}<br><small>Top ${hex(frame[47-this.hour])} · Bottom ${hex(frame[this.hour])}</small></div>`:'No forecast received yet';
    root.querySelectorAll('.wet-swatches>div').forEach((row,i)=>row.querySelectorAll('span').forEach((el,j)=>{el.style.background=hex(wetColor(parseInt(this.draft.conditions[i+4].slice(1),16),[1,4,8][j]));}));
    const age=f.generated_at?(Date.now()-Date.parse(f.generated_at))/60000:null;
    root.querySelector('#forecast-status').textContent=this.mode==='sample'?'Sample forecast · preview only':`Live forecast · ${age===null?'update time unavailable':age>30?'stale · '+Math.floor(age)+' minutes old':'updated '+Math.max(0,Math.floor(age))+' minutes ago'}${legacy?' · legacy temperature buckets':''}`;
  }
}
customElements.define('edgelight-display-card',EdgelightDisplayCard);
window.customCards=window.customCards||[];
window.customCards.push({type:'edgelight-display-card',name:'Edgelight display editor',description:'Configure the 48 LED wall display.'});
