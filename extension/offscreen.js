// Offscreen document: tab audio capture -> lamejs MP3 encoding.
// createRecorder(deps) holds the testable lifecycle; the bottom wires real browser globals
// and the chrome.runtime listener only when running inside an extension.
import {Mp3Stream, id3v2Tags, MP3_LIMIT} from './mp3.js';

const KBPS_OPTIONS = [128, 192, 320];
const SUPPORTED_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const LEVEL_INTERVAL_MS = 250;
const DRAIN_TIMEOUT_MS = 3000;

export function createRecorder(deps) {
  const send = msg => {
    try {
      Promise.resolve(deps.send(msg)).catch(() => {});
    } catch {}
  };
  let session = null;
  let lastFinish = Promise.resolve();

  function guard(s) {
    if (s.cancelled) throw new Error('錄音已取消');
  }

  // Detach listeners, stop tracks, disconnect nodes, close the AudioContext. Idempotent.
  async function release(s) {
    s.closed = true;
    if (s.timer != null) deps.clearInterval(s.timer);
    s.timer = null;
    if (s.context) s.context.onstatechange = null;
    if (s.stream) {
      for (const t of s.stream.getTracks?.() ?? []) {
        t.onended = null;
        try { t.stop(); } catch {}
      }
    }
    try { s.source?.disconnect(); s.node?.disconnect(); } catch {}
    if (s.node?.port) s.node.port.onmessage = null;
    try { await s.context?.close(); } catch {}
  }

  async function fail(s, err) {
    if (s.failed || s.cancelled) return;
    s.failed = true;
    await release(s);
    if (session === s) session = null;
    send({from: 'offscreen', type: 'error', message: err?.message || String(err)});
  }

  function drain(s) {
    return new Promise((resolve, reject) => {
      let timer = null;
      s.drained = () => {
        deps.clearTimeout(timer);
        s.drained = null;
        resolve();
      };
      timer = deps.setTimeout(() => {
        s.drained = null;
        reject(new Error('音訊處理逾時，本次寫入未提交。'));
      }, DRAIN_TIMEOUT_MS);
      s.node.port.postMessage('stop');
    });
  }

  async function finishSession(s, reason) {
    if (s.finishing || s.cancelled) return;
    s.finishing = true;
    try {
      if (s.node && s.context?.state === 'running') await drain(s);
      if (s.cancelled) return;
      await release(s);
      const chunks = s.mp3.finish();
      const blob = new deps.Blob([id3v2Tags({title: s.title, artist: s.artist}), ...chunks], {type: 'audio/mpeg'});
      const url = deps.URL.createObjectURL(blob);
      if (session === s) session = null;
      send({
        from: 'offscreen',
        type: 'finished',
        url,
        seconds: s.frames / s.sampleRate,
        bytes: blob.size,
        peakHold: s.peakHold,
        reason,
      });
    } catch (err) {
      await fail(s, err);
    }
  }

  function onPcm(s, e) {
    if (e.data?.done) {
      s.drained?.();
      return;
    }
    if (!e.data?.pcm || s.closed || s.full) return;
    const pcm = new Float32Array(e.data.pcm);
    let peak = 0;
    for (const v of pcm) {
      if (Number.isFinite(v)) {
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
    s.peak = Math.max(s.peak, peak);
    s.peakHold = Math.max(s.peakHold, peak);
    s.frames += pcm.length / 2;
    try {
      s.mp3.push(pcm);
    } catch (err) {
      if (err?.code === MP3_LIMIT) {
        s.full = true;
        if (!s.finishing) lastFinish = finishSession(s, 'limit');
      } else {
        lastFinish = fail(s, err);
      }
    }
  }

  function level(s) {
    if (s.peak >= 1) s.clips++;
    const msg = {
      from: 'offscreen',
      type: 'level',
      seconds: s.frames / s.sampleRate,
      bytes: s.mp3.bytes,
      peak: s.peak,
      peakHold: s.peakHold,
      clips: s.clips,
    };
    s.peak = 0;
    send(msg);
  }

  async function start(msg) {
    if (session) return {error: '已有錄音進行中'};
    if (typeof msg.streamId !== 'string' || !msg.streamId) return {error: '缺少分頁串流授權'};
    if (!KBPS_OPTIONS.includes(msg.kbps)) return {error: `不支援的位元率：${msg.kbps}`};

    const s = {
      title: typeof msg.title === 'string' ? msg.title : '',
      artist: typeof msg.artist === 'string' ? msg.artist : '',
      starting: true,
      frames: 0, peak: 0, peakHold: 0, clips: 0,
      sampleRate: 0,
      mp3: null, context: null, stream: null, source: null, node: null, timer: null,
      closed: false, cancelled: false, failed: false, finishing: false, full: false,
      drained: null,
    };
    session = s;
    try {
      s.stream = await deps.getUserMedia({
        audio: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId}},
        video: false,
      });
      guard(s);
      s.context = new deps.AudioContext();
      s.sampleRate = s.context.sampleRate;
      if (!SUPPORTED_RATES.includes(s.sampleRate)) throw new Error(`不支援的取樣率：${s.sampleRate} Hz`);
      s.mp3 = new Mp3Stream(deps.lamejs, s.sampleRate, msg.kbps, {maxBytes: deps.maxBytes});
      await s.context.audioWorklet.addModule('pcm-worklet.js');
      guard(s);
      s.node = new deps.AudioWorkletNode(s.context, 'pcm');
      s.source = s.context.createMediaStreamSource(s.stream);
      s.node.port.onmessage = e => onPcm(s, e);
      // Source feeds both the meter/encoder and the destination so the user still hears the tab.
      s.source.connect(s.node);
      s.node.connect(s.context.destination);
      s.source.connect(s.context.destination);
      await s.context.resume();
      guard(s);
      if (s.stream.getAudioTracks().some(t => t.readyState === 'ended')) {
        throw new Error('來源已關閉，請重新選擇分頁。');
      }
      s.stream.getAudioTracks().forEach(t => {
        t.onended = () => {
          lastFinish = finishSession(s, 'source-ended');
        };
      });
      s.context.onstatechange = () => {
        if (session === s && !s.finishing && s.context.state !== 'running') {
          lastFinish = fail(s, new Error('音訊裝置或 AudioContext 中斷，請重新開始'));
        }
      };
      s.starting = false;
      s.timer = deps.setInterval(() => level(s), LEVEL_INTERVAL_MS);
      return {ok: true, sampleRate: s.sampleRate};
    } catch (err) {
      await release(s);
      if (session === s) session = null;
      return {error: err?.message || String(err)};
    }
  }

  // Optional title/artist override the start values (background may learn them after start).
  function stop(msg = {}) {
    const s = session;
    if (!s || s.starting) return {error: '沒有進行中的錄音'};
    if (typeof msg.title === 'string') s.title = msg.title;
    if (typeof msg.artist === 'string') s.artist = msg.artist;
    if (!s.finishing) lastFinish = finishSession(s, 'stop');
    return {ok: true};
  }

  async function cancel() {
    const s = session;
    if (!s) return {ok: true};
    session = null;
    s.cancelled = true;
    await release(s);
    return {ok: true};
  }

  // Resolves once the most recent stop/limit/source-ended/error path has settled.
  async function settled() {
    await lastFinish;
  }

  async function handle(msg) {
    if (msg?.target !== 'offscreen') return null;
    switch (msg.type) {
      case 'start': return start(msg);
      case 'stop': return stop(msg);
      case 'cancel': return cancel();
      case 'revoke':
        try {
          deps.URL.revokeObjectURL(msg.url);
        } catch (err) {
          return {error: err?.message || String(err)};
        }
        return {ok: true};
      default:
        return {error: `未知訊息：${msg.type}`};
    }
  }

  return {
    handle,
    settled,
    get active() {
      return session !== null;
    },
  };
}

// ---- browser wiring (only inside the extension's offscreen document) ----
if (globalThis.chrome?.runtime?.onMessage) {
  const recorder = createRecorder({
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    lamejs: globalThis.lamejs,
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    send: msg => chrome.runtime.sendMessage(msg),
    setInterval: (f, ms) => globalThis.setInterval(f, ms),
    clearInterval: id => globalThis.clearInterval(id),
    setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
    clearTimeout: id => globalThis.clearTimeout(id),
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return false;
    recorder.handle(msg).then(
      response => sendResponse(response ?? {error: '無法處理的訊息'}),
      err => sendResponse({error: err?.message || String(err)}),
    );
    return true;
  });
}
