import {header} from './wav.js';
import {suggestedName,peakOf,meterLabel,createEmptyDestination,meterValue,peakHoldLabel,formatRate,formatMegabytes,formatClock,formatTime,PeakHistory,historyBars,WAV_HEADER_BYTES} from './helpers.js';
const $=id=>document.getElementById(id);
const setText=(id,text)=>{const e=$(id);if(e)e.textContent=text;};
const query=new URL(location.href).searchParams;
const title=query.get('title') || `來源分頁 ${query.get('target') || '未選擇'}`;
const PILL={idle:'待命',starting:'準備中',recording:'錄音中',finishing:'保存中'};
const RECENT_LIMIT=20;
const peakHistory=new PeakHistory();
$('target').textContent=title;
$('origin').textContent=[query.get('origin'),`Tab ${query.get('target') || '—'}`].filter(Boolean).join(' · ');
let session=null,busy=false;
function status(text,error=false){$('status').textContent=text;if(document.body?.dataset)document.body.dataset.error=String(error);}
function buttons(state){
  $('start').disabled=state!=='idle';$('stop').disabled=state!=='recording';$('cancel').disabled=state!=='recording';
  setText('pill',PILL[state]||PILL.idle);
  if(document.body?.dataset)document.body.dataset.state=state;
}
// Toolbar badge for the source tab; best effort, must never break capture or stop.
function badge(recording){
  try{Promise.resolve(chrome.runtime.sendMessage({type:'badge',recording})).catch(()=>{});}catch{}
}
function palette(){
  const fallback={ok:'#65cfac',warn:'#e5bc62',clip:'#e5534b'};
  let cs=null;try{cs=globalThis.getComputedStyle?.(document.documentElement);}catch{}
  const read=(name,fb)=>{try{return cs?.getPropertyValue(name).trim()||fb;}catch{return fb;}};
  return {ok:read('--meter-ok',fallback.ok),warn:read('--meter-warn',fallback.warn),clip:read('--meter-clip',fallback.clip)};
}
function drawHistory(){
  const cv=$('history');const ctx=cv?.getContext?.('2d');if(!cv||!ctx)return;
  const dpr=globalThis.devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;
  if(!w||!h)return;
  const W=Math.round(w*dpr),H=Math.round(h*dpr);
  if(cv.width!==W)cv.width=W;if(cv.height!==H)cv.height=H;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const colors=palette();
  for(const b of historyBars(peakHistory.toArray(),w,h)){ctx.fillStyle=colors[b.tone];ctx.fillRect(b.x,b.y,b.w,b.h);}
}
function addRecent({name,duration,bytes,savedAt}){
  const ol=$('recent');if(!ol?.prepend||!document.createElement)return;
  const empty=$('recent-empty');if(empty)empty.hidden=true;
  const li=document.createElement('li');
  for(const [cls,text] of [['name',name],['clock',formatClock(duration)],['size',formatMegabytes(bytes)],['time',formatTime(savedAt)]]){
    const span=document.createElement('span');span.className=cls;span.textContent=text;li.appendChild(span);
  }
  ol.prepend(li);
  for(let i=ol.children?.length??0;i>RECENT_LIMIT;i--)ol.lastElementChild?.remove();
}
function paint(s){
  const seconds=(performance.now()-s.started)/1000;
  setText('elapsed',formatClock(seconds,true));
  const peak=s.peak;s.peak=0;
  s.peakHold=Math.max(s.peakHold,peak);if(peak>=1)s.clips++;
  peakHistory.push(peak);drawHistory();
  const meter=$('peak');if(meter)meter.value=meterValue(peak);
  setText('level',meterLabel(peak));
  setText('format',`${s.rate} Hz · float32 · stereo · ${(s.bytes/1e6).toFixed(2)} MB`);
  setText('peakhold',peakHoldLabel(s.peakHold));setText('clips',String(s.clips));
  setText('size',formatMegabytes(s.bytes+WAV_HEADER_BYTES));setText('rate',formatRate(s.rate));
}
async function release(s){
  clearInterval(s.timer);
  if(s.context)s.context.onstatechange=null;
  s.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});
  try{s.source?.disconnect();s.node?.disconnect();}catch{}
  try{await s.context?.close();}catch{}
}
async function drain(s){
  let timeout;
  try{await Promise.race([new Promise(resolve=>{s.drained=resolve;s.node.port.postMessage('stop');}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('音訊處理逾時，本次寫入未提交。')),3000);})]);}
  finally{clearTimeout(timeout);s.drained=null;}
}
async function finish(s,cancel=false,reason=''){
  if(session!==s||s.finishing)return;
  s.finishing=true;s.discard=cancel;
  const duration=s.started?(performance.now()-s.started)/1000:0;
  buttons('finishing');$('state').textContent=cancel?'正在取消':'正在保存';status('正在整理檔案，請保持控制台開啟。');
  try{
    if(!cancel&&!s.error&&s.node&&s.context.state==='running')await drain(s);
    await release(s);await s.chain;
    if(cancel||s.error){await s.file?.abort();status(cancel?'已取消，本次音訊未保存。':`寫入未提交：${s.error.message}`,!!s.error);}
    else{
      await s.file.write({type:'write',position:0,data:header(s.bytes,s.rate)});await s.file.close();
      status(`${reason ? reason+'；' : ''}已保存 ${s.name}\n下一步：在 Rust App 匯入此 WAV，選擇 MP3 品質並另存。`);
      addRecent({name:s.name,duration,bytes:s.bytes+WAV_HEADER_BYTES,savedAt:new Date()});
    }
  }catch(e){await release(s);try{await s.file?.abort();}catch{}status(`未能保存：${e.message}`,true);}
  finally{
    if(session===s){
      session=null;busy=false;buttons('idle');$('state').textContent='錄音已結束';$('peak').value=0;$('level').textContent='音量計待命';document.title='Clear Audio · 已停止';
      badge(false);peakHistory.clear();drawHistory();
    }
  }
}
async function startRecording(){
  if(busy)return;
  busy=true;buttons('starting');$('state').textContent='選擇檔案與授權';
  const s={chain:Promise.resolve(),bytes:0,pending:0,peak:0,peakHold:0,clips:0,finishing:false,error:null};session=s;
  peakHistory.clear();drawHistory();setText('peakhold','—');setText('clips','0');
  try{
    // Keep the native picker directly in the explicit button gesture.
    const handle=await showSaveFilePicker({suggestedName:suggestedName(title),types:[{description:'Float PCM WAV',accept:{'audio/wav':['.wav']}}]});
    s.file=await createEmptyDestination(handle);s.name=handle.name;$('filename').textContent=s.name;
    await s.file.write(header(0,48000));
    const response=await chrome.runtime.sendMessage({type:'capture'});
    if(response?.error||!response?.id)throw Error(response?.error||'未取得分頁授權，請回來源重新點擊擴充圖示。');
    if(response.title)$('target').textContent=response.title;
    s.stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:response.id}},video:false});
    s.context=new AudioContext();s.rate=s.context.sampleRate;await s.context.audioWorklet.addModule('pcm-worklet.js');
    s.node=new AudioWorkletNode(s.context,'pcm');s.source=s.context.createMediaStreamSource(s.stream);
    s.node.port.onmessage=e=>{
      if(e.data.done){s.drained?.();return;}
      if(!e.data.pcm||s.error||s.discard||session!==s)return;
      const b=e.data.pcm;
      if(s.bytes+b.byteLength>0xffff0000||s.pending+b.byteLength>32*1024*1024){s.error=Error('WAV 大小或磁碟待寫入緩衝已達上限');void finish(s);return;}
      s.peak=Math.max(s.peak,peakOf(b));s.pending+=b.byteLength;s.bytes+=b.byteLength;
      s.chain=s.chain.then(()=>s.file.write(b)).then(()=>{s.pending-=b.byteLength;}).catch(e=>{s.error=e;void finish(s);});
    };
    s.source.connect(s.node);s.node.connect(s.context.destination);s.source.connect(s.context.destination);
    await s.context.resume();
    if(s.stream.getAudioTracks().some(t=>t.readyState==='ended'))throw Error('來源已關閉，請重新選擇分頁。');
    s.stream.getAudioTracks().forEach(t=>t.onended=()=>void finish(s,false,'來源已結束'));
    s.context.onstatechange=()=>{if(session===s&&!s.finishing&&s.context.state!=='running'){s.error=Error('音訊裝置或 AudioContext 中斷，請重新開始');void finish(s);}};
    s.started=performance.now();s.timer=setInterval(()=>paint(s),100);paint(s);buttons('recording');badge(true);
    $('state').textContent='正在錄製這個分頁';status('錄音中。停止保存 WAV，或取消並丟棄。');document.title='● 分頁錄音中 · Clear Audio';
  }catch(e){await release(s);try{await s.file?.abort();}catch{}if(session===s){session=null;busy=false;buttons('idle');$('state').textContent='尚未開始錄音';status(e.name==='AbortError'?'已取消選檔，沒有開始錄音。':`無法開始：${e.message}`,e.name!=='AbortError');}}
}
$('start').onclick=()=>startRecording();
$('stop').onclick=()=>session&&finish(session);
$('cancel').onclick=()=>session&&finish(session,true);
// Alt+R start, Alt+S stop, Alt+X cancel; ignored whenever the matching button is disabled.
const SHORTCUTS={r:'start',s:'stop',x:'cancel'};
globalThis.addEventListener?.('keydown',e=>{
  if(!e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.repeat)return;
  const key=e.code?.startsWith('Key')?e.code.slice(3).toLowerCase():String(e.key||'').toLowerCase();
  const id=SHORTCUTS[key];if(!id)return;
  const button=$(id);if(!button||button.disabled)return;
  e.preventDefault();button.onclick();
});
globalThis.addEventListener?.('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='請先停止並保存錄音';}});
globalThis.addEventListener?.('pagehide',()=>{if(session){badge(false);void release(session);}});
