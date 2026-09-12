import {LitElement,html,nothing} from './vendor/lit-core.min.js';
import {defaults,render,validate,hex,names,wetColor,sample,conditionBucket} from './display-model.js';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=o=>structuredClone(o);
const get=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
const set=(o,path,value)=>{const keys=path.split('.'),last=keys.pop();keys.reduce((v,k)=>v[k],o)[last]=value;};
const labels={temperature:'Temperature',conditions:'Conditions',off:'Off',both:'Both'};
const format=(n)=>Number(n.toFixed(2));
const requestId=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');

export class EdgelightDisplayCard extends LitElement {
  constructor(){super();this.accepted=null;this.draft=defaults();this.dirty=false;
    this.mode='live';this.edge='top';this.section='assignments';this.hour=0;this.guide=false;this.night='forecast';
    this.playing=!matchMedia('(prefers-reduced-motion: reduce)').matches;this.time=0;this.message='Waiting for display';this.units='F';
    this.pending=null;this.conflict=false;}
  createRenderRoot(){return this.attachShadow({mode:'open'});}
  setConfig(config){this.config={configuration_entity:'sensor.edgelight_configuration',availability_entity:'binary_sensor.edgelight_connected',forecast_entity:'sensor.weather_display_hourly',result_entity:'sensor.edgelight_command_result',...config};this.requestUpdate();}
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
    this.requestUpdate();
  }
  get hass(){return this._hass;}
  connectedCallback(){super.connectedCallback();this.start();}
  disconnectedCallback(){super.disconnectedCallback();cancelAnimationFrame(this.animation);clearTimeout(this.timeout);}
  start(){cancelAnimationFrame(this.animation);let last=performance.now();
    const tick=now=>{if(this.playing)this.time+=now-last;last=now;this.paint();this.animation=requestAnimationFrame(tick);};
    this.animation=requestAnimationFrame(tick);
  }
  get online(){return this._hass?.states[this.config?.availability_entity]?.state==='on';}
  forecast(){const f=this.mode==='sample'?sample():clone(this._hass?.states[this.config?.forecast_entity]?.attributes||{h:[]});
    if(this.mode==='sample'&&this.night!=='forecast')for(const h of f.h)h[2]=this.night==='night'?1:0;
    return f;
  }
  edit(path,value){set(this.draft,path,value);this.dirty=true;this.message='Unsaved changes';this.requestUpdate();}
  async apply(){
    if(!this.online||!this.accepted||this.conflict||validate(this.draft))return;
    if(!this.pending)this.pending={id:requestId(),expectedRevision:this.accepted.revision,config:clone(this.draft)};
    this.message='Waiting for display confirmation';this.requestUpdate();
    clearTimeout(this.timeout);this.timeout=setTimeout(()=>{this.message='Unconfirmed. Check the display connection, then retry.';this.requestUpdate();},10000);
    try{await this._hass.callService('script','edgelight_apply',{command:this.pending});}
    catch{clearTimeout(this.timeout);this.message='Could not send settings. Retry when connected.';this.requestUpdate();}
  }
  select(path,title,options){const busy=!!this.pending,current=String(get(this.draft,path));
    return html`<label>${title}<select data-path=${path} aria-label=${title} ?disabled=${busy}
      @change=${e=>this.edit(path,path.endsWith('threshold')?Number(e.target.value):e.target.value)}>${options.map(([v,t])=>html`<option value=${v} ?selected=${String(v)===current}>${t}</option>`)}</select></label>`;}
  toggle(path,title){const busy=!!this.pending;
    return html`<label class="toggle"><span>${title}</span><input type="checkbox" data-path=${path} aria-label=${title} .checked=${!!get(this.draft,path)} ?disabled=${busy}
      @change=${e=>this.edit(path,e.target.checked)}></label>`;}
  slider(path,title,min,max,step=1){const busy=!!this.pending,value=get(this.draft,path);
    return html`<label>${title}<span class="range"><input type="range" data-path=${path} aria-label=${title} min=${min} max=${max} step=${step} .value=${String(value)} ?disabled=${busy}
      @input=${e=>this.edit(path,Number(e.target.value))}><output>${format(value)}</output></span></label>`;}
  color(path,title){const busy=!!this.pending,value=get(this.draft,path);
    return html`<label class="color-row"><span>${title}</span><input type="color" data-path=${path} aria-label="${title} picker" .value=${value} ?disabled=${busy}
        @input=${e=>this.edit(path,e.target.value)}><input class="hex" data-path=${path} aria-label="${title} hex" .value=${value} maxlength="7" spellcheck="false" ?disabled=${busy}
        @input=${e=>this.edit(path,e.target.value)}></label>`;}
  controls(){
    const c=this.draft,busy=!!this.pending;
    if(this.section==='assignments')return html`<h3>Choose what each edge shows</h3><p>Each light is one forecast hour. Both edges read from left to right.</p>${['top','bottom'].map(row=>this.select(row,`${row==='top'?'Top':'Bottom'} edge assignment`,Object.entries(labels).filter(([v])=>v!=='both')))}<div class="hint">${this.edge==='top'?'Top: LED 47 at the left, LED 24 at the right.':'Bottom: LED 0 at the left, LED 23 at the right.'}</div>`;
    if(this.section==='colors')return html`<h3>Temperature colors</h3><p>Colors blend smoothly between stops.</p><label>Temperature unit<select id="units" .value=${this.units} ?disabled=${busy} @change=${e=>{this.units=e.target.value;this.requestUpdate();}}><option value="F">F</option><option value="C">C</option></select></label><div class="stops">${c.temperature.map((s,i)=>html`<div class="stop"><label>Stop ${i+1} °${this.units}<input type="number" data-stop=${i} aria-label="Stop ${i+1} temperature" step="any" .value=${String(format(this.units==='F'?s.value:(s.value-32)/1.8))} ?disabled=${busy} @change=${e=>this.edit(`temperature.${i}.value`,e.target.value===''?NaN:this.units==='F'?Number(e.target.value):Number(e.target.value)*1.8+32)}></label>${this.color(`temperature.${i}.color`,`Stop ${i+1}`)}<button data-remove=${i} aria-label="Remove stop ${i+1}" ?disabled=${busy||c.temperature.length<=2} @click=${()=>{this.draft.temperature.splice(i,1);this.dirty=true;this.message='Unsaved changes';this.requestUpdate();}}>×</button></div>`)}</div><button id="add-stop" ?disabled=${busy||c.temperature.length>=16} @click=${()=>this.addStop()}>Add color stop</button><h3>Condition colors</h3>${names.map((n,i)=>this.color(`conditions.${i}`,n))}${this.toggle('wet','Show precipitation strength')}<p>Light → medium → heavy. Derived from your Rain, Snow, and Sleet colors.</p><div class="wet-swatches">${[4,5,6].map(i=>html`<div>${names[i]}${[1,4,8].map((p,j)=>html`<span title=${['Light','Medium','Heavy'][j]} style="background:${hex(wetColor(parseInt(c.conditions[i].slice(1),16),p))}"></span>`)}</div>`)}</div>${this.toggle('night','Dim and cool night conditions')}`;
    if(this.section==='animations')return ['breathing','wind','lightning'].map(name=>html`<section><h3>${{breathing:'Sunrise / sunset breathing',wind:'Wind shimmer',lightning:'Lightning'}[name]}</h3>${this.toggle(`animations.${name}.enabled`,`${name[0].toUpperCase()+name.slice(1)} enabled`)}${this.slider(`animations.${name}.speed`,`${name} speed`,.25,4,.05)}${this.slider(`animations.${name}.strength`,`${name} strength`,0,100)}${name==='wind'?html`${this.select('animations.wind.target','Wind effect on',[['temperature','Temperature'],['conditions','Conditions'],['both','Both']])}${this.select('animations.wind.threshold','Wind starts at',[5,10,15,20,30,40,50].map(v=>[v,`${v} mph`]))}`:nothing}${name==='lightning'?this.color('animations.lightning.color','Lightning bolt'):nothing}<button data-sample=${name} ?disabled=${busy} @click=${()=>this.previewSample(name)}>Preview ${name}</button></section>`);
    return html`<h3>Room brightness</h3>${this.slider('dayBrightness','Day brightness',0,100,.1)}${this.slider('nightBrightness','Night brightness',0,100,.1)}<p>Applies to both edges after colors and effects. The preview approximates wall glow; actual brightness depends on your LEDs and room.</p>`;
  }
  addStop(){const s=this.draft.temperature;let index=0;for(let i=1;i<s.length-1;i++)if(s[i+1].value-s[i].value>s[index+1].value-s[index].value)index=i;
    s.splice(index+1,0,{value:(s[index].value+s[index+1].value)/2,color:s[index].color});this.dirty=true;this.message='Unsaved changes';this.requestUpdate();}
  previewSample(name){this.mode='sample';this.time=name==='lightning'?10000:name==='breathing'?1500:0;this.hour=name==='breathing'?18:14;this.playing=true;this.requestUpdate();}
  selectEdge(edge){this.edge=edge;this.section='assignments';this.requestUpdate();}
  render(){
    if(!this.config)return html``;
    const error=validate(this.draft);
    const status=this.message==='Waiting for display'&&this.accepted?'Display settings loaded':this.message;
    const applyDisabled=!this.online||!this.accepted||!!error||!!this.conflict||(!this.dirty&&!this.pending);
    return html`<link rel="stylesheet" href=${new URL('./edgelight.css',import.meta.url)}><article>
      <header><div><span class="eyebrow">YOUR WALL, AT A GLANCE</span><h2>Edgelight</h2></div><span class="connection ${this.online?'online':''}">${this.online?'Display online':'Display offline'}</span></header>
      <div class="workspace"><div class="visual"><div class="modes"><button data-mode="live" aria-pressed=${this.mode==='live'} @click=${()=>{this.mode='live';this.requestUpdate();}}>Live forecast</button><button data-mode="sample" aria-pressed=${this.mode==='sample'} @click=${()=>{this.mode='sample';this.requestUpdate();}}>Sample forecast</button></div>
      <div class="scene"><button class="edge-label top-label" data-edge="top" @click=${()=>this.selectEdge('top')}>Top · ${labels[this.draft.top]}</button><div class="wall ${this.guide?'guide':''}"><div class="edge top ${this.edge==='top'?'selected':''}" data-edge="top" role="button" tabindex="0" aria-label="Select top edge" @click=${()=>this.selectEdge('top')} @keydown=${e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();this.selectEdge('top');}}}>${this.sources(0)}</div><div class="bar"></div><div class="edge bottom ${this.edge==='bottom'?'selected':''}" data-edge="bottom" role="button" tabindex="0" aria-label="Select bottom edge" @click=${()=>this.selectEdge('bottom')} @keydown=${e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();this.selectEdge('bottom');}}}>${this.sources(1)}</div></div><button class="edge-label bottom-label" data-edge="bottom" @click=${()=>this.selectEdge('bottom')}>Bottom · ${labels[this.draft.bottom]}</button><div class="timeline"><span>Now</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+23h</span></div></div>
      <div class="preview-tools"><button id="play" @click=${()=>{this.playing=!this.playing;this.requestUpdate();}}>${this.playing?'Pause animations':'Play animations'}</button><label class="toggle">LED guide<input id="guide" type="checkbox" .checked=${this.guide} @change=${e=>{this.guide=e.target.checked;this.requestUpdate();}}></label>${this.mode==='sample'?html`<label>Sample lighting<select id="night" .value=${this.night} @change=${e=>{this.night=e.target.value;this.requestUpdate();}}><option value="forecast">Day and night</option><option value="day">All day</option><option value="night">All night</option></select></label>`:nothing}</div>
      <label class="hour-picker">Inspect forecast hour<input id="hour" type="range" min="0" max="23" .value=${String(this.hour)} aria-label="Forecast hour" @input=${e=>{this.hour=Number(e.target.value);this.requestUpdate();}}></label><div class="details" id="details"></div><p class="forecast-status" id="forecast-status"></p>
      </div><div class="editor"><nav>${[['assignments','Edges'],['colors','Colors'],['animations','Animations'],['brightness','Brightness']].map(([id,title])=>html`<button data-section=${id} aria-pressed=${this.section===id} @click=${()=>{this.section=id;this.requestUpdate();}}>${title}</button>`)}</nav><div class="controls">${this.controls()}</div></div></div>
      <footer><div><span id="status" role="status">${status}</span><span id="validation">${error}</span></div><div class="actions"><button id="defaults" ?disabled=${!!this.pending} @click=${()=>{this.draft=defaults();this.dirty=true;this.message='Unsaved changes';this.requestUpdate();}}>Restore defaults</button><button id="discard" @click=${()=>{clearTimeout(this.timeout);this.pending=null;this.conflict=false;this.dirty=false;this.draft=clone(this.accepted?.config||defaults());this.message='Changes discarded';this.requestUpdate();}}>${this.conflict?'Reload settings':'Discard changes'}</button><button class="primary" id="apply" ?disabled=${applyDisabled} @click=${()=>this.apply()}>${this.pending?'Retry apply':'Apply changes'}</button></div></footer></article>`;
  }
  sources(row){return Array.from({length:24},(_,h)=>{const led=row===0?47-h:h;
    return html`<span class="source ${this.hour===h?'inspected':''}" data-hour=${h} data-led=${led} @click=${e=>{e.stopPropagation();this.hour=h;this.requestUpdate();}}><i>${led}</i></span>`;});}
  paint(){const root=this.renderRoot;if(!root?.querySelector('.wall')||validate(this.draft))return;
    const f=this.forecast(),frame=render(this.draft,f,this.time);
    const bright=clone(this.draft);bright.dayBrightness=100;bright.nightBrightness=100;
    const glow=render(bright,f,this.time);
    const alpha=(f.h?.[0]?.[2]===1?this.draft.nightBrightness:this.draft.dayBrightness)/100;
    root.querySelectorAll('.source').forEach(el=>{el.style.setProperty('--glow',hex(glow[Number(el.dataset.led)]));el.style.setProperty('--glow-alpha',alpha);});
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
    const age=f.generated_at?(Date.now()-Date.parse(f.generated_at))/60000:null;
    root.querySelector('#forecast-status').textContent=this.mode==='sample'?'Sample forecast · preview only':`Live forecast · ${age===null?'update time unavailable':age>30?'stale · '+Math.floor(age)+' minutes old':'updated '+Math.max(0,Math.floor(age))+' minutes ago'}${legacy?' · legacy temperature buckets':''}`;
  }
}
customElements.define('edgelight-display-card',EdgelightDisplayCard);
window.customCards=window.customCards||[];
window.customCards.push({type:'edgelight-display-card',name:'Edgelight display editor',description:'Configure the 48 LED wall display.'});
