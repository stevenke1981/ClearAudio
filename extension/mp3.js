// Pure MP3 encoding helpers (ES module, no browser APIs) for the offscreen recorder.
// Contract: see MP3-CONTRACT.md "編碼" section.

export const FRAME = 1152;               // MPEG-1 Layer III samples per frame
export const MP3_LIMIT = 'MP3_LIMIT';    // Error.code raised when maxBytes is exceeded
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

// Float32 [-1, 1] -> Int16. Out-of-range values are clamped, NaN becomes 0.
export function floatToInt16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let v = input[i];
    if (Number.isNaN(v)) v = 0;
    v = Math.max(-1, Math.min(1, v));
    const scaled = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
    out[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return out;
}

// Interleaved stereo [L0,R0,L1,R1,...] -> [L, R]. A trailing unpaired sample is dropped.
export function deinterleave(interleaved) {
  const frames = Math.floor(interleaved.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = interleaved[2 * i];
    right[i] = interleaved[2 * i + 1];
  }
  return [left, right];
}

// Streams interleaved stereo Float32 into lamejs in FRAME-sized blocks.
export class Mp3Stream {
  constructor(lame, sampleRate, kbps, {maxBytes = DEFAULT_MAX_BYTES} = {}) {
    if (!lame?.Mp3Encoder) throw new Error('lamejs 未載入');
    this.encoder = new lame.Mp3Encoder(2, sampleRate, kbps);
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.total = 0;
    this.rest = new Float32Array(0); // interleaved samples not yet forming a full block
    this.finished = false;
  }

  get bytes() {
    return this.total;
  }

  push(interleaved) {
    if (this.finished) throw new Error('MP3 編碼已結束');
    const input = new Float32Array(this.rest.length + interleaved.length);
    input.set(this.rest, 0);
    input.set(interleaved, this.rest.length);
    const blockSamples = FRAME * 2;
    let offset = 0;
    try {
      while (input.length - offset >= blockSamples) {
        this.#encode(input.subarray(offset, offset + blockSamples));
        offset += blockSamples;
        this.#checkLimit();
      }
    } finally {
      // Keep only unencoded samples so a limit error never leaves already-encoded audio behind.
      this.rest = input.slice(offset);
    }
  }

  // Encodes any leftover partial block, flushes the encoder and returns every chunk.
  finish() {
    if (this.finished) return this.chunks;
    const frames = Math.floor(this.rest.length / 2);
    if (frames > 0) this.#encode(this.rest.subarray(0, frames * 2));
    this.rest = new Float32Array(0);
    this.#take(this.encoder.flush());
    this.finished = true;
    return this.chunks;
  }

  #encode(samples) {
    const [left, right] = deinterleave(samples);
    this.#take(this.encoder.encodeBuffer(floatToInt16(left), floatToInt16(right)));
  }

  #take(out) {
    if (!out || out.length === 0) return;
    // Copy: lamejs may reuse its internal output buffer.
    const chunk = new Uint8Array(out.buffer, out.byteOffset, out.byteLength).slice();
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  // Only push() enforces the limit; finish() must always be able to emit the file it has.
  #checkLimit() {
    if (this.total > this.maxBytes) {
      const err = new Error(`MP3 輸出已達上限（${this.maxBytes} 位元組）`);
      err.code = MP3_LIMIT;
      throw err;
    }
  }
}

function synchsafe(n) {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

// ID3v2.3 tag holding one TIT2 (title) frame, UTF-16 with BOM. Blank title -> empty array.
export function id3v2Title(title) {
  const text = String(title ?? '').trim();
  if (!text) return new Uint8Array(0);

  // Text frame body: encoding byte 0x01 (UTF-16 with BOM), BOM FF FE, UTF-16LE code units.
  const body = new Uint8Array(3 + text.length * 2);
  body[0] = 0x01;
  body[1] = 0xff;
  body[2] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    body[3 + 2 * i] = code & 0xff;
    body[4 + 2 * i] = code >>> 8;
  }

  // Frame header: ID, plain 32-bit big-endian size, 2 flag bytes.
  const frame = new Uint8Array(10 + body.length);
  frame.set([0x54, 0x49, 0x54, 0x32], 0); // "TIT2"
  const size = body.length;
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  frame.set(body, 10);

  // Tag header: "ID3", version 2.3.0, flags 0, synchsafe size of the frame data.
  const header = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, ...synchsafe(frame.length)]);
  const tag = new Uint8Array(header.length + frame.length);
  tag.set(header, 0);
  tag.set(frame, header.length);
  return tag;
}
