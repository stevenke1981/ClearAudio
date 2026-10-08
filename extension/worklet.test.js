import {test} from 'node:test';
import assert from 'node:assert/strict';
let Processor;
globalThis.AudioWorkletProcessor=class{constructor(){this.messages=[];this.port={postMessage:m=>this.messages.push(m)};}};
globalThis.registerProcessor=(name,type)=>{assert.equal(name,'pcm');Processor=type;};
await import('./pcm-worklet.js');
test('interleaves stereo samples without lossy encoding and drains tail',()=>{
  const p=new Processor();p.process([[new Float32Array([0.125,-0.25]),new Float32Array([0.5,-0.75])]]);
  p.port.onmessage({data:'stop'});assert.deepEqual([...new Float32Array(p.messages[0].pcm)],[0.125,0.5,-0.25,-0.75]);
  assert.deepEqual(p.messages[1],{done:true});assert.equal(p.process([]),false);
});
test('mono duplicates channels and bounded block flushes',()=>{
  const p=new Processor();p.process([[new Float32Array(4096).fill(0.5)]]);
  assert.equal(p.messages.length,1);assert.equal(p.messages[0].pcm.byteLength,32768);
  assert.ok([...new Float32Array(p.messages[0].pcm)].every(x=>x===0.5));assert.equal(p.used,0);
});
