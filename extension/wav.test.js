import {test} from 'node:test';
import assert from 'node:assert/strict';
import {header} from './wav.js';
test('float WAV sizes, stereo rate and frame count',()=>{
  const h=header(48000*8,48000),v=new DataView(h);
  assert.equal(h.byteLength,56);assert.equal(v.getUint32(4,true),384048);
  assert.equal(v.getUint16(20,true),3);assert.equal(v.getUint16(22,true),2);
  assert.equal(v.getUint32(28,true),384000);assert.equal(v.getUint32(44,true),48000);
  assert.equal(v.getUint32(52,true),384000);
});
test('native browser sample rate is preserved',()=>{const v=new DataView(header(0,44100));assert.equal(v.getUint32(24,true),44100);assert.equal(v.getUint32(28,true),352800);});
