import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  view, render, recordability, loadKbps, saveKbps, SILENT_WARNING,
  KBPS_STORAGE_KEY, DEFAULT_KBPS, NOT_RECORDABLE,
} from './popup.js';
import {meterValue} from './helpers.js';

const httpTab = {id: 7, title: 'Lo-fi mix - YouTube', url: 'https://www.example.test/watch?v=secret123'};
const chromeTab = {id: 1, title: '擴充功能', url: 'chrome://extensions/?id=abc'};

test('idle on a recordable http tab: start enabled and focused, no query string leaks', () => {
  const v = view({state: 'idle'}, httpTab);
  assert.equal(v.mode, 'idle');
  assert.equal(v.state.text, '待命');
  assert.equal(v.source.title, 'Lo-fi mix - YouTube');
  assert.equal(v.source.origin, 'https://www.example.test');
  assert.ok(!JSON.stringify(v).includes('secret123'));
  assert.equal(v.buttons.start.enabled, true);
  assert.equal(v.buttons.start.visible, true);
  assert.equal(v.buttons.start.text, '● 錄成 MP3');
  assert.equal(v.buttons.stop.visible, false);
  assert.equal(v.buttons.show.visible, false);
  assert.equal(v.buttons.wav.enabled, true);
  assert.equal(v.focus, 'start');
  assert.equal(v.source.warning, '');
  assert.equal(v.hint, '播放中的聲音會被錄下，關閉此面板仍會繼續錄音。快捷鍵 Alt+Shift+R');
  assert.equal(v.quality.selected, DEFAULT_KBPS);
  assert.deepEqual(v.quality.options, [128, 192, 320]);
  assert.equal(v.sections.idle, true);
  assert.equal(v.sections.recording, false);
});

test('non-recordable chrome:// tab disables start with the explanation', () => {
  const v = view(undefined, chromeTab);
  assert.equal(v.buttons.start.enabled, false);
  assert.equal(v.buttons.start.visible, true);
  assert.equal(v.source.warning, '此頁面無法錄音，請在播放音樂的網頁分頁開啟');
  assert.equal(v.source.warning, NOT_RECORDABLE);
  assert.equal(v.source.recordable, false);
  assert.equal(v.buttons.wav.enabled, false);
  assert.equal(v.state.text, '無法錄音');
  assert.equal(v.focus, null);
  assert.equal(v.source.origin, 'chrome://extensions');
});

test('missing tab and extension/new-tab pages are not recordable', () => {
  assert.equal(view({state: 'idle'}, null).buttons.start.enabled, false);
  assert.equal(recordability({url: 'chrome-extension://abc/popup.html'}).ok, false);
  assert.equal(recordability({url: 'chrome://newtab/'}).ok, false);
  assert.equal(recordability({url: 'about:blank'}).ok, false);
  assert.equal(recordability({url: 'http://localhost:8080/a?b=c'}).origin, 'http://localhost:8080');
});

test('recording another tab shows the recorded title, live stats and stop/cancel only', () => {
  const v = view({
    state: 'recording', tabId: 99, title: 'Podcast 第 3 集', origin: 'https://pod.test',
    seconds: 65.4, bytes: 2_000_000, peak: 0.5, peakHold: 1, kbps: 320,
  }, httpTab);
  assert.equal(v.mode, 'recording');
  assert.equal(v.state.text, '錄音中');
  assert.equal(v.state.tone, 'rec');
  assert.equal(v.recording.title, '正在錄：Podcast 第 3 集');
  assert.equal(v.recording.clock, '01:05');
  assert.ok(Math.abs(v.recording.meter - meterValue(0.5)) < 1e-12);
  assert.equal(v.recording.size, '2.00 MB');
  assert.equal(v.recording.peakHold, '0.0 dBFS');
  assert.equal(v.recording.bitrate, '320 kbps');
  assert.equal(v.buttons.stop.visible, true);
  assert.equal(v.buttons.stop.enabled, true);
  assert.equal(v.buttons.stop.text, '■ 停止並存 MP3');
  assert.equal(v.buttons.cancel.visible, true);
  assert.equal(v.buttons.cancel.enabled, true);
  assert.equal(v.buttons.start.visible, false);
  assert.equal(v.buttons.wav.visible, false);
  assert.equal(v.sections.idle, false);
  assert.equal(v.sections.quality, false);
  assert.equal(v.sections.recording, true);
  assert.equal(v.focus, 'stop');
});

test('starting shows the recording panel with stop disabled and no focus target', () => {
  const v = view({state: 'starting', title: 'T', kbps: 192}, httpTab);
  assert.equal(v.mode, 'starting');
  assert.equal(v.state.text, '準備中…');
  assert.equal(v.sections.recording, true);
  assert.equal(v.buttons.stop.enabled, false);
  assert.equal(v.buttons.cancel.enabled, false);
  assert.equal(v.buttons.start.visible, false);
  assert.equal(v.focus, null);
});

test('saving shows the save text and hides every action button', () => {
  const v = view({state: 'saving', title: 'T', seconds: 10, bytes: 1e6}, httpTab);
  assert.equal(v.mode, 'saving');
  assert.equal(v.saving.text, '正在存檔…');
  assert.equal(v.sections.saving, true);
  assert.equal(v.sections.recording, false);
  for (const name of ['start', 'stop', 'cancel', 'show', 'wav']) {
    assert.equal(v.buttons[name].visible, false, name);
  }
  assert.equal(v.focus, null);
});

test('idle with last result shows the saved card and keeps start available', () => {
  const v = view({
    state: 'idle',
    last: {filename: 'Lo-fi-20261008-120000.mp3', downloadId: 42, seconds: 125, bytes: 3_000_000},
  }, httpTab);
  assert.equal(v.mode, 'idle');
  assert.equal(v.state.text, '已存檔');
  assert.equal(v.sections.last, true);
  assert.equal(v.last.filename, 'Lo-fi-20261008-120000.mp3');
  assert.equal(v.last.duration, '02:05');
  assert.equal(v.last.size, '3.00 MB');
  assert.equal(v.last.folder, '下載/ClearAudio/');
  assert.equal(v.buttons.show.visible, true);
  assert.equal(v.buttons.show.enabled, true);
  assert.equal(v.buttons.show.downloadId, 42);
  assert.equal(v.buttons.start.enabled, true);
  assert.equal(v.focus, 'start');
});

test('error state shows the message, guidance, and re-enables start', () => {
  const v = view({state: 'error', error: '無法取得分頁音訊'}, httpTab);
  assert.equal(v.mode, 'error');
  assert.equal(v.state.text, '發生錯誤');
  assert.equal(v.state.tone, 'error');
  assert.equal(v.error.message, '無法取得分頁音訊');
  assert.match(v.error.guidance, /再試一次/);
  assert.equal(v.sections.error, true);
  assert.equal(v.sections.idle, true);
  assert.equal(v.buttons.start.enabled, true);
  assert.equal(v.buttons.start.visible, true);
  assert.equal(v.focus, 'start');
});

test('error on a non-recordable tab still disables start', () => {
  const v = view({state: 'error', error: 'x'}, chromeTab);
  assert.equal(v.buttons.start.enabled, false);
});

test('error without a message falls back to a generic message', () => {
  assert.equal(view({state: 'error'}, httpTab).error.message, '發生未知錯誤');
});

test('quality preference is passed through and invalid values fall back to default', () => {
  assert.equal(view({state: 'idle'}, httpTab, {kbps: 320}).quality.selected, 320);
  assert.equal(view({state: 'idle'}, httpTab, {kbps: 999}).quality.selected, DEFAULT_KBPS);
});

test('kbps preference reads and writes localStorage and falls back when it throws', () => {
  const store = new Map();
  const memory = {getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v))};
  assert.equal(loadKbps(() => memory), DEFAULT_KBPS);
  assert.equal(saveKbps(320, () => memory), true);
  assert.equal(store.get(KBPS_STORAGE_KEY), '320');
  assert.equal(loadKbps(() => memory), 320);
  store.set(KBPS_STORAGE_KEY, '64');
  assert.equal(loadKbps(() => memory), DEFAULT_KBPS);

  const denied = () => { throw new Error('storage denied'); };
  assert.equal(loadKbps(denied), DEFAULT_KBPS);
  assert.equal(saveKbps(128, denied), false);
  const brokenMethods = {getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); }};
  assert.equal(loadKbps(() => brokenMethods), DEFAULT_KBPS);
  assert.equal(saveKbps(128, () => brokenMethods), false);
});

test('render applies text with textContent only and moves focus only on mode change', () => {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, {id, textContent: '', hidden: false, disabled: false, checked: false, value: 0, dataset: {}, focused: 0, focus() { this.focused++; }});
    return els.get(id);
  };
  const doc = {body: {dataset: {}}, getElementById: el};
  const title = '<img src=x onerror=alert(1)> 標題';
  const rec = {state: 'recording', title, seconds: 3, bytes: 1e5, peak: 0.25, peakHold: 0.25, kbps: 128};

  render(view({state: 'idle'}, httpTab), doc);
  assert.equal(doc.body.dataset.mode, 'idle');
  assert.equal(el('start').focused, 1);
  assert.equal(el('start').disabled, false);
  assert.equal(el('kbps-192').checked, true);
  assert.equal(el('recording-section').hidden, true);
  assert.equal(el('state').textContent, '待命');

  render(view(rec, httpTab), doc);
  assert.equal(doc.body.dataset.mode, 'recording');
  assert.equal(el('rec-title').textContent, `正在錄：${title}`);
  assert.equal(el('clock').textContent, '00:03');
  assert.ok(Math.abs(el('meter').value - view(rec, httpTab).recording.meter) < 1e-12);
  assert.equal(el('stop').focused, 1);
  assert.equal(el('start').hidden, true);
  assert.equal(el('stop').disabled, false);

  render(view({...rec, seconds: 4}, httpTab), doc);
  assert.equal(el('stop').focused, 1, 'same mode must not steal focus on each broadcast');

  render(view({state: 'idle'}, chromeTab), doc);
  assert.equal(el('start').disabled, true);
  assert.equal(el('source-warning').textContent, NOT_RECORDABLE);
  assert.equal(el('source-warning').hidden, false);
});

test('silent last recording shows the warning; a normal one does not', () => {
  const base = {filename: 'Song-20261008-120000.mp3', downloadId: 3, seconds: 10, bytes: 1000};
  const silent = view({state: 'idle', last: {...base, silent: true}}, httpTab);
  assert.equal(silent.last.warning, SILENT_WARNING);
  assert.match(silent.last.warning, /全程無聲/);
  const loud = view({state: 'idle', last: {...base, silent: false}}, httpTab);
  assert.equal(loud.last.warning, '');
  assert.equal(view({state: 'idle', last: base}, httpTab).last.warning, '');
  assert.equal(view({state: 'idle'}, httpTab).last, null);
});

test('render shows the silent warning only in the saved card when last.silent', () => {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, {id, textContent: '', hidden: true, disabled: false, checked: false, value: 0, dataset: {}, focus() {}});
    return els.get(id);
  };
  const doc = {body: {dataset: {}}, getElementById: el};
  const base = {filename: 'a.mp3', downloadId: 1, seconds: 5, bytes: 10};

  render(view({state: 'idle', last: {...base, silent: true}}, httpTab), doc);
  assert.equal(el('last-section').hidden, false);
  assert.equal(el('last-warning').hidden, false);
  assert.equal(el('last-warning').textContent, SILENT_WARNING);

  render(view({state: 'idle', last: {...base, silent: false}}, httpTab), doc);
  assert.equal(el('last-warning').hidden, true);
  assert.equal(el('last-warning').textContent, '');

  render(view({state: 'recording', title: 'T', seconds: 1, bytes: 1, peak: 0, peakHold: 0}, httpTab), doc);
  assert.equal(el('last-section').hidden, true);
});
