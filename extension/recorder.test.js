import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {meterValue} from './helpers.js';

test('recorder lifecycle with synthetic PCM and mocked browser APIs',async t=>{
 const elements=new Map();
 const listeners={};
 const messages=[];
 let badgeFail=false;
 // Recording 2D context: each clearRect starts a new frame, so `fills` holds the last drawn frame.
 const ctx={fills:[],clears:0,fillStyle:'',setTransform(){},clearRect(){this.clears++;this.fills=[];},fillRect(x,y,w,h){this.fills.push({x,y,w,h,fill:this.fillStyle});}};
 elements.set('history',{clientWidth:300,clientHeight:60,width:0,height:0,getContext:()=>ctx});
 elements.set('recent',{children:[],prepend(li){this.children.unshift(li);}});
 elements.set('recent-empty',{hidden:false,textContent:''});
 globalThis.document={body:{dataset:{}},createElement:tag=>({tagName:tag,className:'',textContent:'',children:[],appendChild(c){this.children.push(c);return c;}}),getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,value:0});return elements.get(id);}};
 globalThis.location={href:'chrome-extension://test/recorder.html?target=42&title=Test%20tone&origin=https%3A%2F%2Fexample.test'};
 globalThis.addEventListener=(type,f)=>{(listeners[type]??=[]).push(f);};
 let writer,node,track,requests=0,failWrite=false,pickerCancel=false,existing=false;
 globalThis.showSaveFilePicker=async()=>{
  if(pickerCancel)throw Object.assign(Error('cancel'),{name:'AbortError'});
  writer={writes:[],aborted:0,closed:0,stateAtClose:null,async write(b){if(failWrite&&b instanceof ArrayBuffer)throw Error('synthetic disk failure');this.writes.push(b);},async abort(){this.aborted++;},async close(){this.closed++;this.stateAtClose=document.body.dataset.state;}};
  return {name:'test.wav',getFile:async()=>({size:existing?100:0}),createWritable:async()=>writer};
 };
 globalThis.chrome={runtime:{sendMessage:async m=>{
  messages.push({type:m.type,recording:m.recording,state:document.body.dataset.state});
  if(m.type==='badge'){if(badgeFail)throw Error('tab closed');return {ok:true};}
  requests++;return {id:'synthetic',title:'Test tone'};
 }}};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async options=>{
  assert.equal(options.video,false);assert.equal(options.audio.mandatory.chromeMediaSource,'tab');
  track={readyState:'live',stopped:false,stop(){this.stopped=true;}};
  return {getTracks:()=>[track],getAudioTracks:()=>[track]};
 }}}});
 globalThis.AudioContext=class{constructor(){this.sampleRate=48000;this.state='running';this.audioWorklet={addModule:async()=>{}};this.destination={};}createMediaStreamSource(){return {connect(){},disconnect(){}};}async resume(){}async close(){this.state='closed';}};
 globalThis.AudioWorkletNode=class{
  constructor(){node=this;this.port={postMessage:message=>{if(message==='stop')queueMicrotask(()=>this.port.onmessage({data:{done:true}}));}};}
  connect(){}
  disconnect(){}
 };
 await import('./recorder.js');
 const start=()=>elements.get('start').onclick();
 const pcm=(samples=[.5,-.5,0,0])=>node.port.onmessage({data:{pcm:new Float32Array(samples).buffer}});
 const settle=async()=>{for(let i=0;i<8;i++)await tick();};
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const pressKey=(code,extra={})=>{let prevented=false;for(const f of listeners.keydown??[])f({altKey:true,ctrlKey:false,metaKey:false,shiftKey:false,repeat:false,code,key:'',preventDefault(){prevented=true;},...extra});return prevented;};
 await t.test('picker cancellation performs no capture request',async()=>{pickerCancel=true;await start();assert.equal(requests,0);assert.equal(elements.get('start').disabled,false);pickerCancel=false;});
 await t.test('existing file refused before requesting stream',async()=>{existing=true;await start();assert.equal(requests,0);assert.equal(writer.writes.length,0);existing=false;});
 await t.test('stop drains PCM, finalizes header and closes file',async()=>{await start();pcm();await elements.get('stop').onclick();assert.equal(writer.closed,1);assert.equal(writer.aborted,0);assert.equal(track.stopped,true);assert.match(elements.get('status').textContent,/已保存/);assert.equal(new DataView(writer.writes.at(-1).data).getUint32(52,true),16);});
 await t.test('cancel aborts without committing file',async()=>{await start();pcm();await elements.get('cancel').onclick();assert.equal(writer.aborted,1);assert.equal(writer.closed,0);assert.equal(track.stopped,true);});
 await t.test('disk failure aborts and releases stream',async()=>{failWrite=true;await start();pcm();for(let i=0;i<8;i++)await tick();assert.equal(writer.aborted,1);assert.equal(track.stopped,true);assert.match(elements.get('status').textContent,/synthetic disk failure/);failWrite=false;});
 await t.test('source ends, commits once and permits next session',async()=>{await start();pcm();track.onended();for(let i=0;i<8;i++)await tick();assert.equal(writer.closed,1);assert.equal(elements.get('start').disabled,false);assert.match(elements.get('status').textContent,/來源已結束/);});

 await t.test('body state and pill follow idle, starting, recording, finishing and idle',async()=>{
  assert.equal(document.body.dataset.state,'idle');
  await start();
  assert.equal(messages.filter(m=>m.type==='capture').at(-1).state,'starting');
  assert.equal(document.body.dataset.state,'recording');
  assert.equal(elements.get('pill').textContent,'錄音中');
  pcm();await elements.get('stop').onclick();
  assert.equal(writer.stateAtClose,'finishing');
  assert.equal(document.body.dataset.state,'idle');
  assert.equal(elements.get('pill').textContent,'待命');
  assert.deepEqual(messages.filter(m=>m.type==='badge').slice(-2).map(m=>m.recording),[true,false]);
 });

 await t.test('successful save prepends a recent entry and hides the empty placeholder',async()=>{
  const list=elements.get('recent');const before=list.children.length;
  await start();pcm();await elements.get('stop').onclick();
  assert.equal(list.children.length,before+1);
  const [name,clock,size,time]=list.children[0].children;
  assert.equal(name.textContent,'test.wav');assert.equal(name.className,'name');
  assert.match(clock.textContent,/^\d{2}:\d{2}$/);
  assert.match(size.textContent,/^\d+\.\d{2} MB$/);
  assert.match(time.textContent,/^\d{2}:\d{2}:\d{2}$/);
  assert.equal(elements.get('recent-empty').hidden,true);
 });

 await t.test('cancelled capture leaves the recent list untouched',async()=>{
  const list=elements.get('recent');const before=list.children.length;
  await start();pcm();await elements.get('cancel').onclick();
  assert.equal(list.children.length,before);
 });

 await t.test('live meter, peak hold, clip count and history canvas use real PCM only',async()=>{
  await start();pcm([.5,-.5]);
  await wait(150);
  assert.ok(Math.abs(elements.get('peak').value-meterValue(.5))<1e-9);
  assert.match(elements.get('peakhold').textContent,/^-6\.0 dBFS$/);
  assert.equal(elements.get('clips').textContent,'0');
  assert.equal(ctx.fills.length,1);assert.equal(ctx.fills[0].fill,'#65cfac');
  pcm([1,0]);
  await wait(150);
  assert.equal(elements.get('clips').textContent,'1');
  assert.equal(elements.get('peakhold').textContent,'0.0 dBFS');
  assert.ok(ctx.fills.some(f=>f.fill==='#e5534b'));
  const clearsBefore=ctx.clears;
  await elements.get('stop').onclick();
  assert.ok(ctx.clears>clearsBefore);
  assert.equal(ctx.fills.length,0);   // history cleared on idle, silence draws nothing
 });

 await t.test('keyboard shortcuts act only on enabled buttons',async()=>{
  const before=requests;
  assert.equal(pressKey('KeyS'),false);assert.equal(pressKey('KeyX'),false);
  await settle();assert.equal(requests,before);
  assert.equal(pressKey('KeyR',{ctrlKey:true}),false);await settle();assert.equal(requests,before);
  assert.equal(pressKey('KeyR'),true);await settle();
  assert.equal(requests,before+1);assert.equal(elements.get('start').disabled,true);
  assert.equal(pressKey('KeyR'),false);await settle();assert.equal(requests,before+1);
  const current=writer;
  assert.equal(pressKey('KeyX'),true);await settle();
  assert.equal(current.aborted,1);assert.equal(elements.get('start').disabled,false);
  assert.equal(pressKey('KeyX'),false);
  assert.equal(pressKey('KeyR'),true);await settle();
  pcm();
  assert.equal(pressKey('KeyS'),true);await settle();
  assert.equal(writer.closed,1);assert.equal(writer.aborted,0);
 });

 await t.test('badge failure never breaks capture or stop',async()=>{
  badgeFail=true;
  await start();pcm();await elements.get('stop').onclick();
  badgeFail=false;
  assert.equal(writer.closed,1);
  assert.equal(elements.get('start').disabled,false);
  assert.match(elements.get('status').textContent,/已保存/);
 });
});
