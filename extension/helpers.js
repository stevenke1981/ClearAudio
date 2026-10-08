export function suggestedName(title, now = new Date()) {
  const stem = String(title || 'tab-audio').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 70) || 'tab-audio';
  return `ClearAudio-${stem}-${now.toISOString().replace(/[:.]/g, '-')}.wav`;
}
export function peakOf(buffer) {
  let peak = 0;
  for (const sample of new Float32Array(buffer)) if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
  return peak;
}
export function meterLabel(peak) {
  return peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS${peak >= 1 ? ' · 峰值達滿刻度' : ''}` : '尚無非靜音訊號';
}
export async function createEmptyDestination(handle) {
  const current = await handle.getFile();
  if (current.size !== 0) throw Error('所選檔案已有內容，未寫入。請改用新的檔名。');
  return handle.createWritable();
}
// ---- v0.3 console metering helpers (pure, no DOM) ----
export const HISTORY_CAPACITY = 300; // 30 s at one paint per 100 ms
export const WAV_HEADER_BYTES = 56;  // header() in wav.js writes a 56-byte preamble
export function dbOf(peak) {
  return Number.isFinite(peak) && peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}
// Maps peak to 0..1 over -60..0 dBFS; silence and invalid input map to 0.
export function meterValue(peak) {
  const db = Math.min(0, Math.max(-60, dbOf(peak)));
  return (db + 60) / 60;
}
// Bar colour tier: clip at >= 0 dBFS, warn at >= -6 dBFS, otherwise ok.
export function barTone(peak) {
  const db = dbOf(peak);
  const EPS = 1e-9; // absorb float rounding at the exact -6 dBFS line
  return db >= -EPS ? 'clip' : db >= -6 - EPS ? 'warn' : 'ok';
}
export function peakHoldLabel(peak) {
  return peak > 0 ? `${dbOf(peak).toFixed(1)} dBFS` : '—';
}
export function formatRate(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz < 1000) return `${hz} Hz`;
  return `${+(hz / 1000).toFixed(2)} kHz`;
}
export function formatMegabytes(bytes) {
  return Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1e6).toFixed(2)} MB` : '—';
}
// mm:ss (h:mm:ss from one hour); tenths=true appends .t for the live timer.
export function formatClock(seconds, tenths = false) {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const t = Math.floor(total * 10);
  const whole = Math.floor(t / 10);
  const h = Math.floor(whole / 3600), m = Math.floor(whole % 3600 / 60), s = whole % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${h ? h + ':' : ''}${pad(m)}:${pad(s)}${tenths ? '.' + (t % 10) : ''}`;
}
export function formatTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
// Fixed-capacity ring buffer of peaks; toArray() returns oldest first.
export class PeakHistory {
  constructor(capacity = HISTORY_CAPACITY) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.head = 0;
    this.length = 0;
  }
  push(peak) {
    this.buf[this.head] = Number.isFinite(peak) && peak > 0 ? peak : 0;
    this.head = (this.head + 1) % this.capacity;
    this.length = Math.min(this.length + 1, this.capacity);
  }
  clear() {
    this.head = 0;
    this.length = 0;
  }
  toArray() {
    const start = (this.head - this.length + this.capacity) % this.capacity;
    const out = [];
    for (let i = 0; i < this.length; i++) out.push(this.buf[(start + i) % this.capacity]);
    return out;
  }
}
// Rectangles for a right-aligned rolling history; silent slots produce no bar.
export function historyBars(values, width, height, capacity = HISTORY_CAPACITY) {
  const slot = width / capacity, bars = [];
  const recent = values.slice(-capacity), offset = capacity - recent.length;
  recent.forEach((peak, i) => {
    const v = meterValue(peak);
    if (v <= 0) return;
    const h = v * height;
    bars.push({x: (offset + i) * slot, y: height - h, w: Math.max(1, slot * 0.75), h, tone: barTone(peak)});
  });
  return bars;
}
