// Clear Audio 工具列面板（代理 C）。
// 純函式 recordability() / view() / loadKbps() / saveKbps() / render() 可於 Node 測試；
// 只有在瀏覽器（存在 chrome.runtime 與 document）時才接線。
import {meterValue, formatClock, formatMegabytes, peakHoldLabel} from './helpers.js';

export const KBPS_OPTIONS = [128, 192, 320];
export const DEFAULT_KBPS = 192;
export const KBPS_STORAGE_KEY = 'clearAudio.mp3Kbps';
export const NOT_RECORDABLE = '此頁面無法錄音，請在播放音樂的網頁分頁開啟';
export const SAVE_FOLDER = '下載/ClearAudio/';
export const HINT = '播放中的聲音會被錄下，關閉此面板仍會繼續錄音。快捷鍵 Alt+Shift+R';
const UNKNOWN_ERROR = '發生未知錯誤';
const GUIDANCE = '請確認此分頁正在播放聲音，然後再試一次。若仍失敗，可改用進階 WAV。';

// ---------- 音質偏好（localStorage 包 try/catch；被封鎖時退回預設值） ----------
const defaultStorage = () => globalThis.localStorage;

export function loadKbps(getStorage = defaultStorage) {
  try {
    const value = Number(getStorage()?.getItem(KBPS_STORAGE_KEY));
    return KBPS_OPTIONS.includes(value) ? value : DEFAULT_KBPS;
  } catch {
    return DEFAULT_KBPS;
  }
}

export function saveKbps(kbps, getStorage = defaultStorage) {
  try {
    getStorage()?.setItem(KBPS_STORAGE_KEY, String(kbps));
    return true;
  } catch {
    return false;
  }
}

// ---------- 分頁可錄性（只取 origin，絕不顯示查詢字串） ----------
export function recordability(tab) {
  if (!tab || typeof tab !== 'object') return {ok: false, title: '未命名分頁', origin: '', reason: NOT_RECORDABLE};
  const title = String(tab.title ?? '').trim() || '未命名分頁';
  const url = typeof tab.url === 'string' ? tab.url : '';
  // 未取得網址（無 tabs 權限時可能如此）：交由背景程式於開始時驗證。
  if (!url) return {ok: true, title, origin: '', reason: ''};
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {ok: false, title, origin: '', reason: NOT_RECORDABLE};
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const origin = parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
    return {ok: false, title, origin, reason: NOT_RECORDABLE};
  }
  return {ok: true, title, origin: parsed.origin, reason: ''};
}

// ---------- 純函式：狀態 + 分頁 → 面板應顯示的內容 ----------
const STATE_LABEL = {
  idle: {text: '待命', tone: 'idle'},
  unavailable: {text: '無法錄音', tone: 'warn'},
  saved: {text: '已存檔', tone: 'idle'},
  starting: {text: '準備中…', tone: 'busy'},
  recording: {text: '錄音中', tone: 'rec'},
  saving: {text: '正在存檔…', tone: 'busy'},
  error: {text: '發生錯誤', tone: 'error'},
};

export function view(status, activeTab, prefs = {}) {
  const s = status && typeof status === 'object' ? status : {};
  const rec = recordability(activeTab);
  const kbps = KBPS_OPTIONS.includes(Number(prefs.kbps)) ? Number(prefs.kbps) : DEFAULT_KBPS;
  const mode = ['starting', 'recording', 'saving', 'error'].includes(s.state) ? s.state : 'idle';
  const idleLike = mode === 'idle' || mode === 'error';
  const recordingLike = mode === 'starting' || mode === 'recording';
  const isRec = mode === 'recording';
  const hasLast = mode === 'idle' && !!s.last;
  const startable = idleLike && rec.ok;

  let labelKey = mode;
  if (mode === 'idle') labelKey = hasLast ? 'saved' : rec.ok ? 'idle' : 'unavailable';
  const state = STATE_LABEL[labelKey];

  const focus = startable ? 'start' : isRec ? 'stop' : null;

  return {
    mode,
    focus,
    state,
    hint: HINT,
    sections: {
      idle: idleLike,
      quality: idleLike,
      last: hasLast,
      recording: recordingLike,
      saving: mode === 'saving',
      error: mode === 'error',
    },
    source: {
      title: rec.title,
      origin: rec.origin,
      recordable: rec.ok,
      warning: idleLike && !rec.ok ? rec.reason : '',
    },
    quality: {selected: kbps, options: KBPS_OPTIONS.slice()},
    last: hasLast
      ? {
          filename: String(s.last.filename || '（未知檔名）'),
          duration: formatClock(s.last.seconds),
          size: formatMegabytes(s.last.bytes),
          folder: SAVE_FOLDER,
        }
      : null,
    recording: {
      title: `正在錄：${s.title ? String(s.title) : '未命名分頁'}`,
      clock: formatClock(s.seconds),
      meter: meterValue(s.peak),
      size: formatMegabytes(s.bytes),
      peakHold: peakHoldLabel(s.peakHold),
      bitrate: Number.isFinite(s.kbps) ? `${s.kbps} kbps` : '—',
    },
    saving: {text: '正在存檔…'},
    error: mode === 'error'
      ? {message: String(s.error || UNKNOWN_ERROR), guidance: GUIDANCE}
      : null,
    buttons: {
      start: {visible: idleLike, enabled: startable, text: '● 錄成 MP3'},
      stop: {visible: recordingLike, enabled: isRec, text: '■ 停止並存 MP3'},
      cancel: {visible: recordingLike, enabled: isRec, text: '取消（不保存）'},
      show: {
        visible: hasLast,
        enabled: hasLast && Number.isInteger(s.last.downloadId),
        downloadId: hasLast ? s.last.downloadId : undefined,
        text: '在資料夾中顯示',
      },
      wav: {visible: idleLike, enabled: rec.ok, text: '進階：錄成無損 WAV'},
    },
  };
}

// ---------- 套用到 DOM（只用 textContent；焦點僅在模式改變時移動） ----------
const FOCUS_ID = {start: 'start', stop: 'stop'};

export function render(v, doc) {
  const prevMode = doc.body.dataset.mode;
  doc.body.dataset.mode = v.mode;
  const el = id => doc.getElementById(id);
  const setText = (id, t) => {
    const e = el(id);
    if (e) e.textContent = t ?? '';
  };
  const setHidden = (id, hidden) => {
    const e = el(id);
    if (e) e.hidden = hidden;
  };
  const setButton = (id, b) => {
    const e = el(id);
    if (!e) return;
    e.hidden = !b.visible;
    e.disabled = !b.enabled;
    if (b.text !== undefined) e.textContent = b.text;
  };

  const stateEl = el('state');
  if (stateEl) {
    stateEl.textContent = v.state.text;
    stateEl.dataset.tone = v.state.tone;
  }
  for (const [name, on] of Object.entries(v.sections)) setHidden(`${name}-section`, !on);

  for (const k of KBPS_OPTIONS) {
    const input = el(`kbps-${k}`);
    if (input) input.checked = k === v.quality.selected;
  }
  setText('source-title', v.source.title);
  setText('source-origin', v.source.origin);
  setText('source-warning', v.source.warning);
  setHidden('source-warning', !v.source.warning);
  setText('hint', v.hint);

  if (v.last) {
    setText('last-filename', v.last.filename);
    setText('last-duration', `長度 ${v.last.duration}`);
    setText('last-size', v.last.size);
    setText('last-folder', `已存到 ${v.last.folder}`);
  }

  setText('rec-title', v.recording.title);
  setText('clock', v.recording.clock);
  const meter = el('meter');
  if (meter) meter.value = v.recording.meter;
  setText('stat-size', v.recording.size);
  setText('stat-peak', v.recording.peakHold);
  setText('stat-bitrate', v.recording.bitrate);

  setText('saving-text', v.saving.text);
  setText('error-message', v.error ? v.error.message : '');
  setText('error-guidance', v.error ? v.error.guidance : '');

  setButton('start', v.buttons.start);
  setButton('stop', v.buttons.stop);
  setButton('cancel', v.buttons.cancel);
  setButton('show', v.buttons.show);
  setButton('wav', v.buttons.wav);

  // 模式改變時把焦點交給主要按鈕（錄音中為「停止」，待命為「錄成 MP3」）。
  if (v.focus && prevMode !== v.mode) {
    const target = el(FOCUS_ID[v.focus]);
    if (target && typeof target.focus === 'function') target.focus();
  }
}

// ---------- 瀏覽器接線 ----------
function wire(chromeApi, doc) {
  let status = {state: 'idle'};
  let tab = null;
  let kbps = loadKbps();

  const send = async message => {
    try {
      return await chromeApi.runtime.sendMessage(message);
    } catch {
      return undefined;
    }
  };
  const paint = () => render(view(status, tab, {kbps}), doc);
  const refresh = async () => {
    const next = await send({type: 'mp3-status'});
    if (next && typeof next === 'object' && next.state) status = next;
    paint();
  };
  const fail = message => {
    status = {...status, state: 'error', error: message};
    paint();
  };

  for (const k of KBPS_OPTIONS) {
    doc.getElementById(`kbps-${k}`)?.addEventListener('change', () => {
      kbps = k;
      saveKbps(k);
      paint();
    });
  }

  doc.getElementById('start')?.addEventListener('click', async () => {
    const r = recordability(tab);
    if (!r.ok || !tab) return;
    const res = await send({type: 'mp3-start', tabId: tab.id, title: r.title, origin: r.origin, kbps});
    if (res && res.error) return fail(String(res.error));
    if (res && res.state) {
      status = res;
      return paint();
    }
    if (!res) return fail('無法連線到錄音服務，請重新開啟面板再試');
    await refresh();
  });

  doc.getElementById('stop')?.addEventListener('click', async () => {
    const res = await send({type: 'mp3-stop'});
    if (res && res.error) fail(String(res.error));
  });

  doc.getElementById('cancel')?.addEventListener('click', async () => {
    if (!globalThis.confirm('取消後錄到的內容會直接捨棄，不會保存。確定取消？')) return;
    await send({type: 'mp3-cancel'});
  });

  doc.getElementById('show')?.addEventListener('click', () => {
    const id = status.last?.downloadId;
    if (Number.isInteger(id)) send({type: 'mp3-show', downloadId: id});
  });

  doc.getElementById('wav')?.addEventListener('click', async () => {
    const r = recordability(tab);
    if (!r.ok || !tab) return;
    await send({type: 'open-wav', tabId: tab.id, title: r.title, origin: r.origin});
    globalThis.close();
  });

  chromeApi.runtime.onMessage.addListener(message => {
    if (message?.type === 'mp3-state' && message.status && typeof message.status === 'object') {
      status = message.status;
      paint();
    }
    return undefined;
  });

  paint();
  (async () => {
    try {
      const [active] = await chromeApi.tabs.query({active: true, currentWindow: true});
      tab = active ?? null;
    } catch {
      tab = null;
    }
    await refresh();
  })();
}

if (globalThis.chrome?.runtime && globalThis.document) {
  wire(globalThis.chrome, globalThis.document);
}
