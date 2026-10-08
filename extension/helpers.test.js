import {test} from 'node:test';
import assert from 'node:assert/strict';
import {suggestedName,peakOf,meterLabel,createEmptyDestination,meterValue,barTone,peakHoldLabel,formatRate,formatMegabytes,formatClock,formatTime,PeakHistory,historyBars} from './helpers.js';
test('safe descriptive UTC names preserve Chinese and remove path syntax',()=>{
 const name=suggestedName('我的歌 / a:b?. ',new Date('2026-10-08T01:02:03.004Z'));
 assert.equal(name,'ClearAudio-我的歌 _ a_b_-2026-10-08T01-02-03-004Z.wav');
 assert.ok(suggestedName('CON').startsWith('ClearAudio-CON-'));
});
test('meter is actual PCM peak including silence and invalid samples',()=>{
 assert.equal(peakOf(new Float32Array([0,NaN,Infinity,-.5,.25]).buffer),.5);
 assert.equal(peakOf(new Float32Array(4).buffer),0);
 assert.equal(meterLabel(0),'尚無非靜音訊號');assert.match(meterLabel(.5),/-6.0/);
});
test('nonempty destination is rejected before opening writer',async()=>{
 let opened=false;
 await assert.rejects(createEmptyDestination({getFile:async()=>({size:44}),createWritable:async()=>{opened=true;}}),/已有內容/);
 assert.equal(opened,false);
 const writer={};assert.equal(await createEmptyDestination({getFile:async()=>({size:0}),createWritable:async()=>writer}),writer);
});
test('meterValue maps -60..0 dBFS linearly and clamps everything else',()=>{
 assert.equal(meterValue(1),1);
 assert.equal(meterValue(0),0);
 assert.equal(meterValue(1e-9),0);            // below -60 dBFS
 assert.equal(meterValue(NaN),0);
 assert.equal(meterValue(Infinity),0);
 assert.equal(meterValue(0.001),0);          // exactly -60 dBFS maps to the floor
 assert.ok(Math.abs(meterValue(Math.pow(10,-30/20))-0.5)<1e-12); // -30 dBFS -> 0.5
 assert.ok(meterValue(2)<=1);                  // over-range peaks clamp at full scale
});
test('barTone uses clip at 0 dBFS, warn at -6 dBFS and ok below',()=>{
 assert.equal(barTone(1),'clip');
 assert.equal(barTone(1.5),'clip');
 assert.equal(barTone(Math.pow(10,-6/20)),'warn');
 assert.equal(barTone(0.6),'warn');
 assert.equal(barTone(0.4),'ok');
});
test('peakHoldLabel formats dBFS or dash for silence',()=>{
 assert.equal(peakHoldLabel(0),'—');
 assert.equal(peakHoldLabel(Math.pow(10,-3.2/20)),'-3.2 dBFS');
 assert.equal(peakHoldLabel(1),'0.0 dBFS');
});
test('formatRate shows kHz with minimal decimals and dash for invalid input',()=>{
 assert.equal(formatRate(48000),'48 kHz');
 assert.equal(formatRate(44100),'44.1 kHz');
 assert.equal(formatRate(22050),'22.05 kHz');
 assert.equal(formatRate(8000),'8 kHz');
 assert.equal(formatRate(500),'500 Hz');
 assert.equal(formatRate(0),'—');
 assert.equal(formatRate(NaN),'—');
});
test('formatMegabytes prints x.xx MB',()=>{
 assert.equal(formatMegabytes(0),'0.00 MB');
 assert.equal(formatMegabytes(1234567),'1.23 MB');
 assert.equal(formatMegabytes(-1),'—');
});
test('formatClock gives mm:ss, h:mm:ss and optional tenths',()=>{
 assert.equal(formatClock(0),'00:00');
 assert.equal(formatClock(0,true),'00:00.0');
 assert.equal(formatClock(65.94),'01:05');
 assert.equal(formatClock(65.94,true),'01:05.9');
 assert.equal(formatClock(3725.25,true),'1:02:05.2');
 assert.equal(formatClock(-4),'00:00');
 assert.equal(formatClock(NaN),'00:00');
});
test('formatTime prints local HH:MM:SS',()=>{
 assert.equal(formatTime(new Date(2026,9,8,7,5,9)),'07:05:09');
});
test('PeakHistory is a fixed ring that keeps the newest values oldest-first',()=>{
 const h=new PeakHistory(3);
 assert.deepEqual(h.toArray(),[]);
 h.push(.1);h.push(.2);assert.deepEqual(h.toArray(),[.1,.2]);
 h.push(.3);h.push(.4);assert.deepEqual(h.toArray(),[.2,.3,.4]);
 h.push(NaN);h.push(-1);assert.deepEqual(h.toArray(),[.4,0,0]);
 h.clear();assert.deepEqual(h.toArray(),[]);
 h.push(.5);assert.deepEqual(h.toArray(),[.5]);
});
test('PeakHistory default capacity is 300 paint ticks (30 s)',()=>{
 const h=new PeakHistory();
 for(let i=0;i<350;i++)h.push(i===0?1:.1);
 assert.equal(h.toArray().length,300);
 assert.equal(h.toArray()[0],.1);
});
test('historyBars right-aligns recent peaks and skips silent slots',()=>{
 const bars=historyBars([0,1,0.5],300,60,300);
 assert.equal(bars.length,2);            // the silent slot draws nothing
 assert.equal(bars[0].tone,'clip');      // peak 1 -> 0 dBFS
 assert.equal(bars[0].x,298);            // offset 297 (300 - 3 values) + index 1, slot 1 px
 assert.equal(bars[0].h,60);
 assert.equal(bars[0].y,0);
 assert.equal(bars[1].tone,'ok');        // -6.02 dBFS is below the -6 dBFS warn line
 assert.equal(bars[1].x,299);
 assert.ok(Math.abs(bars[1].h-60*meterValue(0.5))<1e-9);
 assert.ok(Math.abs(bars[1].y-(60-bars[1].h))<1e-9);
});
test('historyBars returns nothing for an all-silent history',()=>{
 assert.deepEqual(historyBars([0,0,0],300,60,300),[]);
});
