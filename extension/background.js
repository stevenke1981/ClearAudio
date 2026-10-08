import {mp3FileStem} from './mp3-names.js';

// ---------- shared helpers ----------
const MP3_KBPS = [128, 192, 320];
const DEFAULT_KBPS = 192;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MP3_TITLE = '將此分頁錄成 MP3';
const REC_TITLE = '錄音中 · 點擊開啟面板停止';
const POPUP_TYPES = new Set(['mp3-status', 'mp3-start', 'mp3-stop', 'mp3-cancel', 'mp3-show', 'open-wav']);

function originOf(value) {
  try { return new URL(String(value)).origin; } catch { return ''; }
}
function finiteOr0(v) {
  return Number.isFinite(v) ? v : 0;
}
function isPopupSender(sender) {
  return sender?.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
}
function isOffscreenSender(sender) {
  return sender?.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL('offscreen.html'));
}

// ---------- recorder.html controller (WAV console, unchanged behaviour) ----------
// Only the visible controller page opened by the action may drive capture or badge.
function trustedController(sender) {
  return !!sender?.tab && !!sender.url?.startsWith(chrome.runtime.getURL('recorder.html?'));
}
function targetOf(sender) {
  const raw = new URL(sender.url).searchParams.get('target');
  const target = Number(raw);
  return raw && Number.isSafeInteger(target) && target >= 0 ? target : null;
}
// Controller tab id -> source tab id while REC badge is shown; cleared if the controller closes abruptly.
const badged = new Map();
chrome.tabs.onRemoved?.addListener(tabId => {
  const target = badged.get(tabId);
  if (target === undefined) return;
  badged.delete(tabId);
  chrome.action.setBadgeText({tabId: target, text: ''}).catch(() => {});
});

// ---------- MP3 recording state ----------
// status.state: idle | starting | recording | saving | error
let status = {state: 'idle'};
let lastKbps = DEFAULT_KBPS;
let pending = null; // {downloadId, url, filename, seconds, bytes, timer} while the MP3 download is running

function broadcast() {
  try {
    chrome.runtime.sendMessage({type: 'mp3-state', status: {...status}}).catch(() => {});
  } catch {}
}
async function toOffscreen(message) {
  try { return await chrome.runtime.sendMessage({target: 'offscreen', ...message}); } catch { return undefined; }
}
async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts?.({contextTypes: ['OFFSCREEN_DOCUMENT']});
  return Array.isArray(contexts) && contexts.length > 0;
}
async function closeOffscreen() {
  try {
    if (await offscreenExists()) await chrome.offscreen.closeDocument();
  } catch {}
}
async function openOffscreen() {
  // Idle means no live recording, so any leftover document is stale; start from a fresh one.
  await closeOffscreen();
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '錄製使用者授權的分頁音訊並編碼為 MP3',
  });
}
async function setRecordingBadge(on) {
  try {
    if (on) {
      await chrome.action.setBadgeBackgroundColor({color: '#c0392b'});
      await chrome.action.setBadgeText({text: 'REC'});
      await chrome.action.setTitle({title: REC_TITLE});
    } else {
      await chrome.action.setBadgeText({text: ''});
      await chrome.action.setTitle({title: MP3_TITLE});
    }
  } catch {}
}
function clearPending() {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}
async function failMp3(message) {
  clearPending();
  status = {state: 'error', error: message};
  await setRecordingBadge(false);
  await closeOffscreen();
  broadcast();
}

async function startMp3({tabId, title, origin, kbps}) {
  if (status.state !== 'idle' && status.state !== 'error') throw Error('已有錄音或存檔進行中');
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw Error('分頁編號無效');
  status = {state: 'starting', tabId, title, origin, kbps};
  broadcast();
  try {
    // No consumerTabId: the offscreen document consumes the stream.
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tabId});
    await openOffscreen();
    const res = await toOffscreen({type: 'start', streamId, kbps, title});
    if (!res || res.ok !== true) throw Error(res?.error || '離屏錄音器未回應');
    lastKbps = kbps;
    status = {state: 'recording', tabId, title, origin, kbps, seconds: 0, bytes: 0};
    await setRecordingBadge(true);
    broadcast();
    return {...status};
  } catch (e) {
    await failMp3(e?.message || String(e));
    throw e;
  }
}

async function stopMp3() {
  if (status.state !== 'recording') throw Error('目前沒有錄音');
  const res = await toOffscreen({type: 'stop'});
  if (!res || res.ok !== true) {
    await failMp3(res?.error || '停止錄音失敗，錄音已遺失');
    throw Error(status.error);
  }
  return {ok: true}; // completion arrives later as a 'finished' message
}

async function cancelMp3() {
  if (status.state === 'starting') throw Error('正在啟動，請稍候再取消');
  if (status.state === 'saving') throw Error('正在存檔，無法取消');
  if (status.state === 'recording') await toOffscreen({type: 'cancel'});
  clearPending();
  await closeOffscreen();
  status = {state: 'idle'};
  await setRecordingBadge(false);
  broadcast();
  return {ok: true};
}

async function revokeAndClose(url) {
  if (url) await toOffscreen({type: 'revoke', url});
  await closeOffscreen();
}

async function settleDownload(ok, reason) {
  const p = pending;
  if (!p) return;
  clearPending();
  await revokeAndClose(p.url);
  status = ok
    ? {state: 'idle', last: {filename: p.filename, downloadId: p.downloadId, seconds: p.seconds, bytes: p.bytes}}
    : {state: 'error', error: reason};
  broadcast();
}

async function onFinished(m) {
  if (status.state !== 'recording' || typeof m.url !== 'string') {
    await revokeAndClose(typeof m.url === 'string' ? m.url : null);
    return;
  }
  const {title, origin, kbps} = status;
  const seconds = finiteOr0(m.seconds), bytes = finiteOr0(m.bytes);
  status = {state: 'saving', title, origin, kbps, seconds, bytes};
  await setRecordingBadge(false);
  const filename = 'ClearAudio/' + mp3FileStem(title, new Date()) + '.mp3';
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({url: m.url, filename, conflictAction: 'uniquify', saveAs: false});
  } catch (e) {
    await revokeAndClose(m.url);
    await failMp3('存檔失敗：' + (e?.message || e));
    return;
  }
  pending = {
    downloadId, url: m.url, filename, seconds, bytes,
    timer: setTimeout(() => settleDownload(true), DOWNLOAD_TIMEOUT_MS),
  };
  broadcast();
}

function onOffscreenMessage(m) {
  switch (m.type) {
    case 'level':
      if (status.state !== 'recording') return;
      status = {
        ...status,
        seconds: finiteOr0(m.seconds), bytes: finiteOr0(m.bytes), peak: finiteOr0(m.peak),
        peakHold: finiteOr0(m.peakHold), clips: finiteOr0(m.clips),
      };
      broadcast();
      return;
    case 'finished':
      onFinished(m).catch(() => {});
      return;
    case 'error':
      failMp3(String(m.message || '錄音失敗')).catch(() => {});
      return;
  }
}

// Popup requests. Returns a promise of the response; unknown types are filtered out before this call.
async function popupRequest(m) {
  switch (m.type) {
    case 'mp3-status':
      return {...status};
    case 'mp3-start': {
      const kbps = MP3_KBPS.includes(m.kbps) ? m.kbps : DEFAULT_KBPS;
      return startMp3({
        tabId: m.tabId,
        title: String(m.title || '未命名分頁').slice(0, 200),
        origin: originOf(m.origin),
        kbps,
      });
    }
    case 'mp3-stop':
      return stopMp3();
    case 'mp3-cancel':
      return cancelMp3();
    case 'mp3-show': {
      if (!Number.isSafeInteger(m.downloadId) || m.downloadId < 0) throw Error('下載編號無效');
      await chrome.downloads.show(m.downloadId);
      return {ok: true};
    }
    case 'open-wav': {
      if (!Number.isSafeInteger(m.tabId) || m.tabId < 0) throw Error('分頁編號無效');
      // origin only, never the full URL or its query
      const params = new URLSearchParams({
        target: String(m.tabId),
        title: String(m.title || '未命名分頁'),
        origin: originOf(m.origin),
      });
      await chrome.tabs.create({url: chrome.runtime.getURL(`recorder.html?${params}`)});
      return {ok: true};
    }
  }
}

chrome.downloads.onChanged.addListener(delta => {
  if (!pending || delta.id !== pending.downloadId) return;
  const state = delta.state?.current;
  if (state === 'complete') settleDownload(true).catch(() => {});
  else if (state === 'interrupted') settleDownload(false, '下載中斷，MP3 未存入').catch(() => {});
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-mp3') return;
  try {
    if (status.state === 'recording') {
      await stopMp3();
      return;
    }
    if (status.state !== 'idle' && status.state !== 'error') return;
    const target = tab ?? (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0];
    if (target?.id == null) throw Error('找不到目前分頁');
    await startMp3({
      tabId: target.id,
      title: target.title || '未命名分頁',
      origin: originOf(target.url),
      kbps: lastKbps,
    });
  } catch (e) {
    if (status.state !== 'error') await failMp3(e?.message || String(e)).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m?.from === 'offscreen') {
    if (isOffscreenSender(sender)) onOffscreenMessage(m);
    return;
  }
  if (isPopupSender(sender)) {
    if (!POPUP_TYPES.has(m?.type)) return;
    popupRequest(m).then(respond, error => respond({error: error?.message || String(error)}));
    return true;
  }
  if (!trustedController(sender)) return;
  if (m?.type === 'badge') {
    const target = targetOf(sender);
    if (target === null) { respond({error:'來源分頁無效，無法更新徽章。'}); return; }
    (async () => {
      const recording = m.recording === true;
      if (recording) badged.set(sender.tab.id, target); else badged.delete(sender.tab.id);
      await chrome.action.setBadgeBackgroundColor({tabId: target, color: '#c0392b'});
      await chrome.action.setBadgeText({tabId: target, text: recording ? 'REC' : ''});
      return {ok: true};
    })().then(respond, error => respond({error:error.message}));
    return true;
  }
  if (m?.type !== 'capture') return;
  const target = targetOf(sender);
  if (target === null) { respond({error:'來源分頁無效，請回到來源重新點擊擴充。'}); return; }
  (async () => {
    const tab = await chrome.tabs.get(target);
    const captures = await chrome.tabCapture.getCapturedTabs();
    if (captures.some(c => c.tabId === target && ['pending','active'].includes(c.status))) throw Error('此分頁已有錄音，請先在原控制台停止。');
    const id = await chrome.tabCapture.getMediaStreamId({targetTabId:target,consumerTabId:sender.tab.id});
    return {id,title:tab.title || null};
  })().then(respond, error => respond({error:error.message}));
  return true;
});
