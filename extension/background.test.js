import {test} from 'node:test';
import assert from 'node:assert/strict';

// ---- synthetic chrome mock ----
let message, commandListener, downloadListener, removedListener;
let created, options = null, duplicate = false, streamFails = false, downloadFails = false, offscreenStartError = null;
let offscreenOpen = false, nextDownloadId = 7;
const badgeCalls = [], titleCalls = [], sent = [], downloads = [], shown = [];
const offscreenCalls = {create: [], close: 0};

globalThis.chrome = {
  action: {
    setBadgeText: async p => { badgeCalls.push(['text', p]); },
    setBadgeBackgroundColor: async p => { badgeCalls.push(['color', p]); },
    setTitle: async p => { titleCalls.push(p); },
  },
  runtime: {
    id: 'test',
    getURL: p => 'chrome-extension://test/' + p,
    getContexts: async () => (offscreenOpen ? [{contextType: 'OFFSCREEN_DOCUMENT'}] : []),
    sendMessage: async m => {
      sent.push(m);
      if (m.target === 'offscreen' && m.type === 'start') return offscreenStartError ? {error: offscreenStartError} : {ok: true, sampleRate: 48000};
      if (m.target === 'offscreen') return {ok: true};
      return undefined;
    },
    onMessage: {addListener: f => { message = f; }},
  },
  tabs: {
    onRemoved: {addListener: f => { removedListener = f; globalThis.__removed = f; }},
    create: async p => { created = p; },
    get: async id => ({id, title: 'Synthetic tone'}),
    query: async () => [{id: 42, title: 'Synthetic tone', url: 'https://example.test/active?q=1'}],
  },
  tabCapture: {
    getCapturedTabs: async () => (duplicate ? [{tabId: 42, status: 'active'}] : []),
    getMediaStreamId: async p => {
      options = p;
      if (streamFails) throw Error('no stream');
      return 'test-stream';
    },
  },
  offscreen: {
    createDocument: async p => {
      if (offscreenOpen) throw Error('Only a single offscreen document may be created.');
      offscreenOpen = true;
      offscreenCalls.create.push(p);
    },
    closeDocument: async () => { offscreenOpen = false; offscreenCalls.close++; },
  },
  downloads: {
    download: async p => {
      if (downloadFails) throw Error('disk full');
      const id = nextDownloadId++;
      downloads.push({params: p, id});
      return id;
    },
    show: async id => { shown.push(id); },
    onChanged: {addListener: f => { downloadListener = f; }},
  },
  commands: {onCommand: {addListener: f => { commandListener = f; }}},
  scripting: {
    executeScript: async p => {
      scriptCalls.push(p);
      if (mediaThrows) throw Error('cannot access tab');
      return [{result: mediaResult}];
    },
  },
};
// Media Session metadata reported by the page (null = none). Set per test.
let mediaResult = null, mediaThrows = false;
const scriptCalls = [];

await import('./background.js');

const flush = () => new Promise(r => setTimeout(r, 0));
const POPUP = {id: 'test', url: 'chrome-extension://test/popup.html'};
const OFFSCREEN = {id: 'test', url: 'chrome-extension://test/offscreen.html'};
const reply = (m, sender) => new Promise(resolve => { assert.equal(message(m, sender, resolve), true); });
const popup = m => reply(m, POPUP);
const fromOffscreen = m => message({from: 'offscreen', ...m}, OFFSCREEN, () => assert.fail('offscreen messages are not answered'));
const sentTo = type => sent.filter(m => m.target === 'offscreen' && m.type === type);
const lastBadgeText = () => badgeCalls.filter(([k]) => k === 'text').at(-1);
async function startRecording({tabId = 42, title = 'Synthetic tone', origin = 'https://example.test/x', kbps = 192} = {}) {
  const st = await popup({type: 'mp3-start', tabId, title, origin, kbps});
  assert.equal(st.state, 'recording', JSON.stringify(st));
  return st;
}
async function resetIdle() {
  await popup({type: 'mp3-cancel'});
  assert.equal((await popup({type: 'mp3-status'})).state, 'idle');
}

// ---- recorder.html controller (WAV console) ----
test('open-wav from the popup opens the WAV console with origin only, never the URL query', async () => {
  const r = await popup({type: 'open-wav', tabId: 42, title: 'My tone', origin: 'https://example.test/song?private=secret'});
  assert.deepEqual(r, {ok: true});
  const u = new URL(created.url);
  assert.equal(u.searchParams.get('target'), '42');
  assert.equal(u.searchParams.get('title'), 'My tone');
  assert.equal(u.searchParams.get('origin'), 'https://example.test');
  assert.ok(!created.url.includes('secret'));
});
test('open-wav refuses an invalid tab id', async () => {
  const r = await popup({type: 'open-wav', tabId: -1, title: 'x', origin: ''});
  assert.match(r.error, /無效/);
});
test('capture binds clicked source to visible controller and refuses duplicate', async()=>{const sender={tab:{id:99},url:'chrome-extension://test/recorder.html?target=42'};const first=await new Promise(resolve=>message({type:'capture'},sender,resolve));assert.equal(first.id,'test-stream');assert.deepEqual(options,{targetTabId:42,consumerTabId:99});duplicate=true;const second=await new Promise(resolve=>message({type:'capture'},sender,resolve));assert.match(second.error,/已有錄音/);duplicate=false;});
test('untrusted sender and missing target never request capture',()=>{assert.equal(message({type:'capture'},{tab:{id:99},url:'https://example.test'},()=>assert.fail()),undefined);let response;message({type:'capture'},{tab:{id:99},url:'chrome-extension://test/recorder.html?'},r=>response=r);assert.match(response.error,/無效/);});
test('badge shows REC on the source tab while recording and clears on stop',async()=>{
 badgeCalls.length=0;
 const controller={tab:{id:99},url:'chrome-extension://test/recorder.html?target=42'};
 assert.deepEqual(await reply({type:'badge',recording:true},controller),{ok:true});
 assert.deepEqual(badgeCalls,[['color',{tabId:42,color:'#c0392b'}],['text',{tabId:42,text:'REC'}]]);
 badgeCalls.length=0;
 await reply({type:'badge',recording:false},controller);
 assert.deepEqual(badgeCalls.at(-1),['text',{tabId:42,text:''}]);
});
test('badge rejects untrusted senders, non-controller pages and invalid targets',async()=>{
 badgeCalls.length=0;
 assert.equal(message({type:'badge',recording:true},{tab:{id:1},url:'https://example.test/?target=42'},()=>assert.fail()),undefined);
 assert.equal(message({type:'badge',recording:true},{url:'chrome-extension://test/recorder.html?target=42'},()=>assert.fail()),undefined);
 const response=await new Promise(resolve=>message({type:'badge',recording:true},{tab:{id:99},url:'chrome-extension://test/recorder.html?target=-1'},resolve));
 assert.match(response.error,/無效/);
 assert.equal(badgeCalls.length,0);
});
test('badge reports browser failures without throwing into the controller',async()=>{
 const original=chrome.action.setBadgeText;
 chrome.action.setBadgeText=async()=>{throw Error('no such tab');};
 const response=await reply({type:'badge',recording:true},{tab:{id:99},url:'chrome-extension://test/recorder.html?target=42'});
 assert.equal(response.error,'no such tab');
 chrome.action.setBadgeText=original;
});
test('closing the controller mid-recording clears the REC badge on its source',async()=>{const sender={tab:{id:77},url:'chrome-extension://test/recorder.html?target=43'};await new Promise(r=>message({type:'badge',recording:true},sender,r));badgeCalls.length=0;globalThis.__removed(77);await new Promise(r=>setTimeout(r,0));assert.deepEqual(badgeCalls,[['text',{tabId:43,text:''}]]);badgeCalls.length=0;globalThis.__removed(77);assert.equal(badgeCalls.length,0);});

// ---- popup MP3 flow ----
test('popup-only messages are refused from other senders', () => {
  options = null;
  const senders = [
    undefined,
    {id: 'other', url: 'chrome-extension://other/popup.html'},
    {id: 'test', url: 'https://example.test/popup.html'},
    {id: 'test', url: 'chrome-extension://test/offscreen.html'},
    {tab: {id: 99}, url: 'chrome-extension://test/recorder.html?target=42'},
  ];
  for (const s of senders) {
    let answered = false;
    const ret = message({type: 'mp3-start', tabId: 42, title: 'x', origin: '', kbps: 192}, s, () => { answered = true; });
    assert.equal(ret, undefined);
    assert.equal(answered, false);
  }
  assert.equal(options, null, 'no stream must be requested for rejected senders');
});

test('mp3-start creates one offscreen document and passes streamId and kbps', async () => {
  await resetIdle();
  offscreenCalls.create.length = 0; sent.length = 0; badgeCalls.length = 0;
  const st = await startRecording({kbps: 320, origin: 'https://example.test/x?secret=1'});
  assert.equal(st.kbps, 320);
  assert.equal(st.origin, 'https://example.test');
  assert.deepEqual(options, {targetTabId: 42});
  assert.equal(offscreenCalls.create.length, 1);
  assert.equal(offscreenCalls.create[0].url, 'offscreen.html');
  assert.deepEqual(offscreenCalls.create[0].reasons, ['USER_MEDIA']);
  const start = sentTo('start');
  assert.equal(start.length, 1);
  assert.equal(start[0].streamId, 'test-stream');
  assert.equal(start[0].kbps, 320);
  assert.deepEqual(lastBadgeText(), ['text', {text: 'REC'}]);
  assert.equal(titleCalls.at(-1).title, '錄音中 · 點擊開啟面板停止');
  assert.deepEqual(await popup({type: 'mp3-status'}), st);
  await resetIdle();
});

test('unsupported kbps falls back to 192', async () => {
  await resetIdle();
  sent.length = 0;
  const st = await startRecording({kbps: 256});
  assert.equal(st.kbps, 192);
  assert.equal(sentTo('start')[0].kbps, 192);
  await resetIdle();
});

test('a second mp3-start while recording is refused', async () => {
  await resetIdle();
  await startRecording();
  const r = await popup({type: 'mp3-start', tabId: 43, title: 'other', origin: '', kbps: 192});
  assert.match(r.error, /進行中/);
  assert.equal((await popup({type: 'mp3-status'})).tabId, 42);
  await resetIdle();
});

test('a failed stream request ends in error state with no offscreen document left behind', async () => {
  await resetIdle();
  streamFails = true;
  const r = await popup({type: 'mp3-start', tabId: 42, title: 't', origin: '', kbps: 192});
  streamFails = false;
  assert.match(r.error, /no stream/);
  const st = await popup({type: 'mp3-status'});
  assert.equal(st.state, 'error');
  assert.equal(offscreenOpen, false);
  await resetIdle();
});

test('an offscreen start failure reports the error and closes the document', async () => {
  await resetIdle();
  offscreenStartError = '無法取得音訊';
  const r = await popup({type: 'mp3-start', tabId: 42, title: 't', origin: '', kbps: 192});
  offscreenStartError = null;
  assert.match(r.error, /無法取得音訊/);
  assert.equal(offscreenOpen, false);
  assert.equal((await popup({type: 'mp3-status'})).state, 'error');
  await resetIdle();
});

test('level messages update status and broadcast mp3-state', async () => {
  await resetIdle();
  await startRecording();
  const mark = sent.length;
  fromOffscreen({type: 'level', seconds: 1.5, bytes: 4096, peak: 0.5, peakHold: 0.7, clips: 2});
  await flush();
  const st = await popup({type: 'mp3-status'});
  assert.equal(st.seconds, 1.5);
  assert.equal(st.bytes, 4096);
  assert.equal(st.peak, 0.5);
  assert.equal(st.peakHold, 0.7);
  assert.equal(st.clips, 2);
  assert.ok(sent.slice(mark).some(m => m.type === 'mp3-state' && m.status.seconds === 1.5));
  await resetIdle();
});

test('finished saves via downloads with a sanitized ClearAudio name, then revokes and closes', async () => {
  await resetIdle();
  await startRecording({title: 'Bad:Name? | Suno'});
  downloads.length = 0; sent.length = 0; offscreenCalls.close = 0;
  fromOffscreen({type: 'finished', url: 'blob:x', seconds: 3, bytes: 9000, peakHold: 0.5, reason: 'stop'});
  await flush();
  assert.equal((await popup({type: 'mp3-status'})).state, 'saving');
  assert.equal(downloads.length, 1);
  const {params, id} = downloads[0];
  assert.match(params.filename, /^ClearAudio\/Bad_Name_-\d{8}-\d{6}\.mp3$/);
  assert.equal(params.url, 'blob:x');
  assert.equal(params.conflictAction, 'uniquify');
  assert.equal(params.saveAs, false);
  downloadListener({id, state: {current: 'complete'}});
  await flush();
  const st = await popup({type: 'mp3-status'});
  assert.equal(st.state, 'idle');
  assert.deepEqual(st.last, {filename: params.filename, downloadId: id, seconds: 3, bytes: 9000, silent: false});
  assert.deepEqual(sentTo('revoke').map(m => m.url), ['blob:x']);
  assert.equal(offscreenCalls.close, 1);
  assert.equal(offscreenOpen, false);
});

test('an interrupted download reports an error and still revokes and closes', async () => {
  await resetIdle();
  await startRecording();
  downloads.length = 0; sent.length = 0; offscreenCalls.close = 0;
  fromOffscreen({type: 'finished', url: 'blob:y', seconds: 1, bytes: 10, reason: 'stop'});
  await flush();
  const {id} = downloads[0];
  downloadListener({id, state: {current: 'interrupted'}});
  await flush();
  const st = await popup({type: 'mp3-status'});
  assert.equal(st.state, 'error');
  assert.match(st.error, /中斷/);
  assert.deepEqual(sentTo('revoke').map(m => m.url), ['blob:y']);
  assert.equal(offscreenCalls.close, 1);
});

test('a rejected download call ends in error state and revokes the blob', async () => {
  await resetIdle();
  await startRecording();
  sent.length = 0; offscreenCalls.close = 0;
  downloadFails = true;
  fromOffscreen({type: 'finished', url: 'blob:z', seconds: 1, bytes: 10, reason: 'stop'});
  await flush();
  downloadFails = false;
  assert.equal((await popup({type: 'mp3-status'})).state, 'error');
  assert.deepEqual(sentTo('revoke').map(m => m.url), ['blob:z']);
  assert.equal(offscreenCalls.close, 1);
  await resetIdle();
});

test('mp3-stop asks offscreen to stop and reports error when not recording', async () => {
  await resetIdle();
  assert.match((await popup({type: 'mp3-stop'})).error, /沒有錄音/);
  await startRecording();
  sent.length = 0;
  assert.deepEqual(await popup({type: 'mp3-stop'}), {ok: true});
  assert.equal(sentTo('stop').length, 1);
  assert.equal((await popup({type: 'mp3-status'})).state, 'recording');
  await resetIdle();
});

test('mp3-cancel discards without downloading and closes offscreen', async () => {
  await resetIdle();
  await startRecording();
  downloads.length = 0; sent.length = 0; offscreenCalls.close = 0;
  assert.deepEqual(await popup({type: 'mp3-cancel'}), {ok: true});
  assert.equal(sentTo('cancel').length, 1);
  assert.equal(downloads.length, 0);
  assert.equal(offscreenCalls.close, 1);
  assert.equal((await popup({type: 'mp3-status'})).state, 'idle');
  assert.deepEqual(lastBadgeText(), ['text', {text: ''}]);
});

test('offscreen error moves to error state, clears REC badge and closes offscreen', async () => {
  await resetIdle();
  await startRecording();
  badgeCalls.length = 0; offscreenCalls.close = 0;
  fromOffscreen({type: 'error', message: '音軌已結束'});
  await flush();
  const st = await popup({type: 'mp3-status'});
  assert.equal(st.state, 'error');
  assert.equal(st.error, '音軌已結束');
  assert.deepEqual(lastBadgeText(), ['text', {text: ''}]);
  assert.equal(offscreenCalls.close, 1);
  await resetIdle();
});

test('mp3-show delegates to downloads.show', async () => {
  shown.length = 0;
  assert.deepEqual(await popup({type: 'mp3-show', downloadId: 7}), {ok: true});
  assert.deepEqual(shown, [7]);
  assert.match((await popup({type: 'mp3-show', downloadId: '7'})).error, /無效/);
});

test('toggle-mp3 command starts the active tab with the last used kbps, then stops and saves', async () => {
  await resetIdle();
  await startRecording({kbps: 128, tabId: 5});
  await resetIdle();
  options = null; sent.length = 0;
  const tab = {id: 42, title: 'Synthetic tone', url: 'https://example.test/active?q=1'};
  await commandListener('toggle-mp3', tab);
  let st = await popup({type: 'mp3-status'});
  assert.equal(st.state, 'recording');
  assert.equal(st.kbps, 128);
  assert.equal(st.origin, 'https://example.test');
  assert.equal(st.title, 'Synthetic tone');
  assert.deepEqual(options, {targetTabId: 42});
  await commandListener('toggle-mp3', tab);
  assert.equal(sentTo('stop').length, 1);
  downloads.length = 0;
  fromOffscreen({type: 'finished', url: 'blob:c', seconds: 2, bytes: 100, reason: 'stop'});
  await flush();
  const {id} = downloads[0];
  downloadListener({id, state: {current: 'complete'}});
  await flush();
  st = await popup({type: 'mp3-status'});
  assert.equal(st.state, 'idle');
  assert.equal(st.last.downloadId, id);
});

test('toggle-mp3 command with no tab falls back to the active tab', async () => {
  await resetIdle();
  options = null;
  await commandListener('toggle-mp3', undefined);
  assert.equal((await popup({type: 'mp3-status'})).state, 'recording');
  assert.deepEqual(options, {targetTabId: 42});
  await resetIdle();
});

test('other commands are ignored', async () => {
  await resetIdle();
  sent.length = 0;
  await commandListener('something-else', {id: 42, url: 'https://example.test/'});
  assert.equal((await popup({type: 'mp3-status'})).state, 'idle');
  assert.equal(sentTo('start').length, 0);
});

test('offscreen messages from a non-offscreen sender are ignored', async () => {
  await resetIdle();
  fromOffscreen({type: 'finished', url: 'blob:x', seconds: 1, bytes: 1, reason: 'stop'}); // not recording: harmless
  message({from: 'offscreen', type: 'error', message: 'spoof'}, {id: 'test', url: 'https://example.test/offscreen.html'}, () => {});
  await flush();
  assert.equal((await popup({type: 'mp3-status'})).state, 'idle');
});

// ---- media title (Media Session) ----
// Finishes the current recording with the given peakHold and returns the saved download and final status.
async function finishWith({peakHold = 0.5} = {}) {
  downloads.length = 0;
  fromOffscreen({type: 'finished', url: 'blob:m', seconds: 4, bytes: 5000, peakHold, reason: 'stop'});
  await flush();
  const {id} = downloads.at(-1);
  downloadListener({id, state: {current: 'complete'}});
  await flush();
  return {download: downloads.at(-1).params, st: await popup({type: 'mp3-status'})};
}

test('media title and artist name the recording when the page exposes metadata', async () => {
  await resetIdle();
  mediaResult = {title: '  Midnight Sky  ', artist: ' Suno AI ', album: ''};
  scriptCalls.length = 0;
  sent.length = 0;
  const st = await startRecording({title: 'Suno | AI Music'});
  assert.deepEqual(scriptCalls[0].target, {tabId: 42});
  assert.equal(st.title, 'Midnight Sky - Suno AI');
  assert.equal(st.songTitle, 'Midnight Sky');
  assert.equal(st.artist, 'Suno AI');
  const start = sentTo('start')[0];
  assert.equal(start.title, 'Midnight Sky');
  assert.equal(start.artist, 'Suno AI');
  const {download} = await finishWith();
  assert.match(download.filename, /^ClearAudio\/Midnight Sky - Suno AI-\d{8}-\d{6}\.mp3$/);
  assert.equal((await popup({type: 'mp3-status'})).last.filename, download.filename);
  mediaResult = null;
});

test('song title without artist uses the title alone', async () => {
  await resetIdle();
  mediaResult = {title: 'Only Song', artist: '', album: ''};
  const st = await startRecording({title: 'Some tab'});
  assert.equal(st.title, 'Only Song');
  assert.equal(st.artist, '');
  assert.equal(sentTo('start').at(-1).artist, '');
  await finishWith();
  mediaResult = null;
});

test('media strings are capped at 200 characters', async () => {
  await resetIdle();
  mediaResult = {title: 'a'.repeat(300), artist: 'b'.repeat(300), album: ''};
  const st = await startRecording({title: 'tab'});
  assert.equal(st.songTitle.length, 200);
  assert.equal(st.artist.length, 200);
  await finishWith();
  mediaResult = null;
});

test('falls back to the tab title when executeScript throws', async () => {
  await resetIdle();
  mediaThrows = true;
  const st = await startRecording({title: 'Suno | AI Music'});
  mediaThrows = false;
  assert.equal(st.title, 'Suno | AI Music');
  assert.ok(!st.songTitle);
  assert.equal(sentTo('start').at(-1).title, 'Suno | AI Music');
  const {download} = await finishWith();
  assert.match(download.filename, /^ClearAudio\/Suno-\d{8}-\d{6}\.mp3$/);
});

test('falls back to the tab title when the page has no media metadata', async () => {
  await resetIdle();
  mediaResult = null;
  const st = await startRecording({title: 'Plain tab'});
  assert.equal(st.title, 'Plain tab');
  assert.equal(sentTo('start').at(-1).artist, '');
  await finishWith();
});

test('a media result with a blank title is treated as not found', async () => {
  await resetIdle();
  mediaResult = {title: '   ', artist: 'Someone', album: ''};
  const st = await startRecording({title: 'Tab name'});
  assert.equal(st.title, 'Tab name');
  assert.ok(!st.artist);
  await finishWith();
  mediaResult = null;
});

test('readMediaInfo func reads Media Session metadata and tolerates a missing mediaSession', async () => {
  await resetIdle();
  mediaResult = null;
  await startRecording();
  const func = scriptCalls.at(-1).func;
  await finishWith();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {value: {mediaSession: {metadata: {title: 'T', artist: undefined}}}, configurable: true});
    assert.deepEqual(func(), {title: 'T', artist: '', album: ''});
    Object.defineProperty(globalThis, 'navigator', {value: {mediaSession: {metadata: null}}, configurable: true});
    assert.equal(func(), null);
    Object.defineProperty(globalThis, 'navigator', {value: {}, configurable: true});
    assert.equal(func(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

test('a media title learned only at stop is passed to offscreen and used for the filename', async () => {
  await resetIdle();
  mediaResult = null;
  await startRecording({title: 'Suno | AI Music'});
  sent.length = 0;
  mediaResult = {title: 'Late Song', artist: 'Late Artist', album: ''};
  assert.deepEqual(await popup({type: 'mp3-stop'}), {ok: true});
  const stop = sentTo('stop')[0];
  assert.equal(stop.title, 'Late Song');
  assert.equal(stop.artist, 'Late Artist');
  assert.equal((await popup({type: 'mp3-status'})).title, 'Late Song - Late Artist');
  const {download} = await finishWith();
  assert.match(download.filename, /^ClearAudio\/Late Song - Late Artist-/);
  mediaResult = null;
});

test('a media title learned only after the track ends is used for the filename', async () => {
  await resetIdle();
  mediaResult = null;
  await startRecording({title: 'Suno | AI Music'});
  mediaResult = {title: 'Ended Song', artist: '', album: ''};
  const {download} = await finishWith();
  assert.match(download.filename, /^ClearAudio\/Ended Song-/);
  mediaResult = null;
});

test('silent flag: a recording whose whole-recording peakHold is below -80 dBFS is saved but marked silent', async () => {
  await resetIdle();
  mediaResult = null;
  await startRecording();
  let r = await finishWith({peakHold: 0});
  assert.equal(r.st.state, 'idle');
  assert.equal(r.st.last.silent, true);
  assert.ok(r.download.filename);

  await startRecording();
  r = await finishWith({peakHold: 0.00005});
  assert.equal(r.st.last.silent, true);

  await startRecording();
  r = await finishWith({peakHold: 0.001});
  assert.equal(r.st.last.silent, false);

  await startRecording();
  r = await finishWith({peakHold: 1});
  assert.equal(r.st.last.silent, false);
});

test('a finished message without peakHold is treated as silent', async () => {
  await resetIdle();
  await startRecording();
  const r = await finishWith({peakHold: null});
  assert.equal(r.st.last.silent, true);
});
