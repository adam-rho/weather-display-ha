export const names=['Sunny','Partly cloudy','Cloudy','Fog','Rain','Snow','Sleet'];
export const stops=[0,20,32,50,65,78,90];
export const colors=['#0000FF','#5B8DEF','#74C7E8','#F2D36B','#F0974A','#EF0000','#CF0000'];
export const hex=c=>'#'+(c>>>0).toString(16).padStart(6,'0').toUpperCase();
const rgb=c=>parseInt(c.slice(1),16);
const byte=v=>Math.round(Math.max(0,Math.min(255,v)));
const pack=a=>(byte(a[0])<<16)|(byte(a[1])<<8)|byte(a[2]);
const channels=c=>[c>>16&255,c>>8&255,c&255];
const scale=(c,f)=>pack(channels(c).map(v=>v*f));
const blend=(c,t,f)=>pack(channels(c).map((v,i)=>v+(channels(t)[i]-v)*f));
// Preview only: an LED is light, not paint. Split a color into its hue at full drive plus an intensity,
// so dimming (animations, off) shows as a fainter glow instead of black on the wall.
export const glow=c=>{const ch=channels(c),m=Math.max(...ch);return m?{color:pack(ch.map(v=>v*255/m)),intensity:m/255}:{color:0,intensity:0};};
export const conditionBucket=c=>[0,1,1,2,3,1,3,4,5,6,7,5,0,7][c]||0;
// Strip layout: which corner holds LED 0 and whether the strip snakes back on the second
// row. Configs saved before layouts existed mean the original wall (bottom-left, snaked).
export const origins=['bottom-left','bottom-right','top-left','top-right'];
export const layoutOf=c=>({origin:'bottom-left',serpentine:true,...(c?.layout||{})});
export const normalize=c=>({...c,layout:layoutOf(c)});
// Physical LED for (row, hour). row 0 = top, 1 = bottom; hour 0 is the left end of both rows.
// Keep in sync with Display::ledFor in include/display_engine.h.
export function ledFor(config,row,hour){
  const l=layoutOf(config),originTop=l.origin.startsWith('top'),originLeft=l.origin.endsWith('left');
  const index=row===(originTop?0:1)?0:1, ltr=index===0?originLeft:(l.serpentine?!originLeft:originLeft);
  return index*24+(ltr?hour:23-hour);
}
export function defaults() {
  return {version:1,top:'temperature',bottom:'conditions',layout:{origin:'bottom-left',serpentine:true},
    temperature:stops.map((value,i)=>({value,color:colors[i]})),
    conditions:['#FFD34E','#C3B47A','#8795A6','#F2F4F5','#43C47E','#9BE0E8','#A66BFF'],
    wet:true,dayBrightness:100,nightBrightness:100*128/255,
    animations:{breathing:{enabled:true,speed:1,strength:100},
      wind:{enabled:true,speed:1,strength:100,target:'conditions',threshold:10},
      lightning:{enabled:true,speed:1,strength:100,color:'#FFFF38'}}};
}
export function validate(c) {
  const number=(v,l,h)=>typeof v==='number'&&Number.isFinite(v)&&v>=l&&v<=h;
  const color=v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v);
  if(c?.version!==1) return 'Unsupported settings version';
  if(!['temperature','conditions','off'].includes(c.top)||!['temperature','conditions','off'].includes(c.bottom)) return 'Invalid edge assignment';
  if(c.layout!==undefined&&(typeof c.layout!=='object'||c.layout===null||!origins.includes(c.layout.origin)||typeof c.layout.serpentine!=='boolean')) return 'Invalid strip layout';
  if(!Array.isArray(c.temperature)||c.temperature.length<2||c.temperature.length>16) return 'Use 2 to 16 temperature stops';
  if(c.temperature.some((s,i)=>!number(s.value,-60,140)||!color(s.color)||(i&&s.value<=c.temperature[i-1].value))) return 'Temperature stops must have ordered values and valid colors';
  if(!Array.isArray(c.conditions)||c.conditions.length!==7||!c.conditions.every(color)) return 'Seven valid condition colors are required';
  if(typeof c.wet!=='boolean') return 'Invalid treatment toggle';
  if(!number(c.dayBrightness,0,100)||!number(c.nightBrightness,0,100)) return 'Brightness must be 0 to 100%';
  for(const name of ['breathing','wind','lightning']) {
    const a=c.animations?.[name];
    if(!a||typeof a.enabled!=='boolean'||!number(a.speed,.25,4)||!number(a.strength,0,100)) return 'Invalid animation settings';
  }
  if(!['temperature','conditions','both'].includes(c.animations.wind.target)||![5,10,15,20,30,40,50].includes(c.animations.wind.threshold)) return 'Invalid wind settings';
  if(!color(c.animations.lightning.color)) return 'Invalid lightning color';
  return '';
}
function oklch(color) {
  const [r,g,b]=channels(color).map(v=>{const c=v/255; return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});
  const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b),
    m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b),
    s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  const a=1.9779984951*l-2.4285922050*m+.4505937099*s, bb=.0259040371*l+.7827717662*m-.8086757660*s;
  return [.2104542553*l+.7936177850*m-.0040720468*s,Math.hypot(a,bb),Math.atan2(bb,a)];
}
function interpolate(from,to,amount) {
  const a=oklch(from), b=oklch(to), t=Math.fround(amount);
  const ha=a[1]<.0001?b[2]:a[2], hb=b[1]<.0001?ha:b[2];
  const h=ha+((hb-ha+Math.PI*3)%(Math.PI*2)-Math.PI)*t;
  const L=a[0]+(b[0]-a[0])*t, C=a[1]+(b[1]-a[1])*t, aa=C*Math.cos(h), bb=C*Math.sin(h);
  const l=(L+.3963377774*aa+.2158037573*bb)**3, m=(L-.1055613458*aa-.0638541728*bb)**3,
    s=(L-.0894841775*aa-1.2914855480*bb)**3;
  return pack([4.0767416621*l-3.3077115913*m+.2309699292*s,
    -1.2684380046*l+2.6097574011*m-.3413193965*s,
    -.0041960863*l-.7034186147*m+1.7076147010*s].map(c=>255*(c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055)));
}
export function temperature(list,value) {
  if(!Number.isFinite(value)) return 0;
  if(value<=list[0].value) return rgb(list[0].color);
  for(let i=1;i<list.length;i++) {
    if(value===list[i].value) return rgb(list[i].color);
    if(value<list[i].value) return interpolate(rgb(list[i-1].color),rgb(list[i].color),(value-list[i-1].value)/(list[i].value-list[i-1].value));
  }
  return rgb(list.at(-1).color);
}
export function wetColor(color,precip) {
  const [r,g,b]=channels(color).map(v=>v/255), mx=Math.max(r,g,b), delta=mx-Math.min(r,g,b);
  const level=precip<=3?0:precip<=7?1:2, sat=[1,.73,.59][level], L=[.74,.38,.21][level];
  if(!delta) return scale(0xffffff,L);
  let h=mx===r?((g-b)/delta)%6:mx===g?(b-r)/delta+2:(r-g)/delta+4;
  if(h<0)h+=6;
  const c=(1-Math.abs(2*L-1))*sat,x=c*(1-Math.abs(h%2-1)),m=L-c/2;
  return pack([h<1||h>=5?c:h<2||h>=4?x:0,h<1?x:h<3?c:h<4?x:0,h<2?0:h<3?x:h<5?c:x].map(v=>(v+m)*255));
}
function noise(x,y) {
  const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
  const fade=t=>t*t*t*(t*(t*6-15)+10);
  const grad=(xx,yy,dx,dy)=>{let h=(Math.imul(xx,374761393)+Math.imul(yy,668265263))>>>0;
    h=Math.imul(h^(h>>>13),1274126177)>>>0;h^=h>>>16;return (h&1?dx:-dx)+(h&2?dy:-dy);};
  const u=fade(xf),v=fade(yf),a=grad(xi,yi,xf,yf),b=grad(xi+1,yi,xf-1,yf),c=grad(xi,yi+1,xf,yf-1),d=grad(xi+1,yi+1,xf-1,yf-1);
  return (a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;
}
function lightning(time) {
  const t=time%12702-10000;
  if(t<0)return 0;
  if(t<533)return Math.max(30,Math.min(150,127+noise(t*.008,0)*42))/255;
  if(t<792)return (120+(t-533)*135/259)/255;
  if(t<1104)return 1;
  if(t<2125){const n=(t-792-312)%255;return (n<127?255-n*204/127:51+(n-127)*204/128)/255;}
  return Math.max(0,Math.min(255,180-(t-2125)*180/577+noise(t*.008,0)*32))/255;
}
function animate(color,config,hours,h,led,channel,time) {
  const e=hours[h],cond=channel==='conditions',temp=channel==='temperature';
  if((!cond&&!temp)||(cond&&!conditionBucket(e[1])))return color;
  let a=config.animations.breathing;
  if(temp&&a.enabled&&h>0&&e[2]!==hours[h-1][2]){
    const first=!hours.slice(1,h).some((v,i)=>v[2]===e[2]&&v[2]!==hours[i][2]);
    const t=time*a.speed%6000;
    if(first&&t<3000)color=scale(color,1-.6*a.strength/100*.5*(1-Math.cos(t/3000*2*Math.PI)));
  }
  a=config.animations.wind;
  const wb=e[4]||0,windy=wb>=1&&wb<=8?[0,0,5,10,15,20,30,40,50][wb]>=a.threshold:[5,6].includes(e[1]);
  if(windy&&a.enabled&&(a.target==='both'||a.target===channel)){
    // Cutoff, not a ramp: any hour at or above the threshold shimmers with the same amplitude.
    const n=128+noise(led*1.25,time*a.speed/1024)*80;
    const mul=Math.max(30,Math.min(255,140+(n-128)*6))/255;
    color=scale(color,1+(mul-1)*a.strength/100);
  }
  a=config.animations.lightning;
  if(cond&&e[1]===11&&a.enabled)color=blend(color,rgb(a.color),lightning(time*a.speed)*a.strength/100);
  return color;
}
export function render(config,forecast,time=0) {
  const frame=Array(48).fill(0), hours=forecast?.h||[];
  for(const [row,channel] of [config.top,config.bottom].entries())for(let h=0;h<Math.min(24,hours.length);h++){
    const e=hours[h],led=ledFor(config,row,h);let color=0;
    if(channel==='temperature')color=temperature(config.temperature,e.length>=6?e[5]:stops[e[0]-1]);
    if(channel==='conditions'){
      const bucket=conditionBucket(e[1]);
      if(bucket){color=rgb(config.conditions[bucket-1]);
        if(config.wet&&bucket>=5&&e[3]>=1&&e[3]<=10)color=wetColor(color,e[3]);}
    }
    color=animate(color,config,hours,h,led,channel,time);
    frame[led]=scale(color,config[hours[0]?.[2]===1?'nightBrightness':'dayBrightness']/100);
  }
  return frame;
}
export function sample() {
  const conditions=[1,1,3,4,7,8,8,8,9,9,9,10,10,10,11,11,5,6,2,2,0,13,3,1];
  return {h:conditions.map((c,h)=>[4,c,h>=18?1:0,[1,5,9][h%3],h>=14&&h<18?6:1,h*100/23-5]),
    times:Array.from({length:24},(_,h)=>new Date(Date.UTC(2026,0,1,7+h)).toISOString()),generated_at:null};
}
