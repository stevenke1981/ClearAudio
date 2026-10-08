import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {floatToInt16, deinterleave, Mp3Stream, id3v2Title, id3v2Tags, MP3_LIMIT} from './mp3.js';

// Load the real vendored lamejs (classic script defining global `lamejs`) into a vm context.
const lameSource = readFileSync(fileURLToPath(new URL('./vendor/lame.min.js', import.meta.url)), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(lameSource + ';globalThis.lamejs=lamejs;', sandbox);
const lame = sandbox.lamejs;

const RATE = 48000;
function sine(seconds, hz = 440, amp = 0.5) {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = amp * Math.sin(2 * Math.PI * hz * i / RATE);
    out[2 * i] = v;
    out[2 * i + 1] = v;
  }
  return out;
}
function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

test('encodes 1 s of 440 Hz sine at 192 kbps into an MPEG stream of expected size', () => {
  const stream = new Mp3Stream(lame, RATE, 192);
  stream.push(sine(1));
  const bytes = concat(stream.finish());
  assert.ok(bytes.length >= 20000 && bytes.length <= 30000, `size ${bytes.length}`);
  assert.equal(stream.bytes, bytes.length);
  // First MPEG frame sync: 11 set bits.
  let idx = 0;
  while (idx + 1 < bytes.length && !(bytes[idx] === 0xff && (bytes[idx + 1] & 0xe0) === 0xe0)) idx++;
  assert.ok(idx < bytes.length - 1, 'no frame sync found');
  assert.equal(bytes[idx], 0xff);
  assert.equal((bytes[idx + 1] & 0xe0), 0xe0);
});

test('first byte of output is an MPEG frame sync (lamejs emits no leading tag)', () => {
  const stream = new Mp3Stream(lame, RATE, 192);
  stream.push(sine(0.5));
  const chunks = stream.finish().filter(c => c.length > 0);
  const first = chunks[0];
  assert.equal(first[0], 0xff);
  assert.equal(first[1] & 0xe0, 0xe0);
});

test('remainder buffering: odd-sized pushes produce the same bytes as one push', () => {
  const pcm = sine(1.3);
  const whole = new Mp3Stream(lame, RATE, 128);
  whole.push(pcm);
  const expected = concat(whole.finish());

  const odd = new Mp3Stream(lame, RATE, 128);
  let pos = 0;
  const sizes = [1, 333, 2, 1000, 4097, 7, 3001];
  let k = 0;
  while (pos < pcm.length) {
    const n = Math.min(sizes[k++ % sizes.length], pcm.length - pos);
    odd.push(pcm.subarray(pos, pos + n));
    pos += n;
  }
  const actual = concat(odd.finish());
  assert.equal(actual.length, expected.length);
  assert.deepEqual(Buffer.from(actual), Buffer.from(expected));
});

test('Mp3Stream finish is idempotent and push after finish throws', () => {
  const stream = new Mp3Stream(lame, RATE, 128);
  stream.push(sine(0.2));
  const first = concat(stream.finish());
  const again = concat(stream.finish());
  assert.deepEqual(again, first);
  assert.throws(() => stream.push(sine(0.1)), /已結束/);
});

test('maxBytes limit throws an Error mentioning 上限 with the limit code', () => {
  const stream = new Mp3Stream(lame, RATE, 192, {maxBytes: 100});
  let caught = null;
  try {
    stream.push(sine(1));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /上限/);
  assert.equal(caught.code, MP3_LIMIT);
  assert.ok(stream.bytes > 100);
});

test('floatToInt16 clamps out-of-range values and maps NaN to 0', () => {
  const out = floatToInt16(new Float32Array([1.5, -2, NaN, 0.5, -0.5, 0, Infinity]));
  assert.ok(out instanceof Int16Array);
  assert.deepEqual(Array.from(out), [32767, -32768, 0, 16384, -16384, 0, 32767]);
});

test('deinterleave splits stereo and drops a trailing unpaired sample', () => {
  const [l, r] = deinterleave(new Float32Array([1, 2, 3, 4, 5]));
  assert.deepEqual(Array.from(l), [1, 3]);
  assert.deepEqual(Array.from(r), [2, 4]);
});

test('id3v2Title writes an ID3v2.3 header with one UTF-16 TIT2 frame', () => {
  const tag = id3v2Title('Hi');
  assert.deepEqual(Array.from(tag.slice(0, 3)), [0x49, 0x44, 0x33]); // "ID3"
  assert.equal(tag[3], 3);  // version 2.3
  assert.equal(tag[4], 0);  // revision
  assert.equal(tag[5], 0);  // flags
  // Synchsafe tag size = frame length (10 header + 3 BOM/encoding + 4 UTF-16 code units) = 17.
  assert.deepEqual(Array.from(tag.slice(6, 10)), [0, 0, 0, 17]);
  assert.equal(tag.length, 10 + 17);
  assert.deepEqual(Array.from(tag.slice(10, 14)), [0x54, 0x49, 0x54, 0x32]); // "TIT2"
  // Plain big-endian 32-bit frame size, then 2 flag bytes.
  assert.deepEqual(Array.from(tag.slice(14, 18)), [0, 0, 0, 7]);
  assert.deepEqual(Array.from(tag.slice(18, 20)), [0, 0]);
  // Encoding byte 0x01 + BOM FF FE + "Hi" as UTF-16LE.
  assert.deepEqual(Array.from(tag.slice(20)), [0x01, 0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
});

test('id3v2Title uses synchsafe size for frames over 127 bytes', () => {
  const title = 'x'.repeat(200);          // body = 3 + 400 = 403, frame = 413
  const tag = id3v2Title(title);
  const size = 413;
  assert.deepEqual(Array.from(tag.slice(6, 10)), [0, 0, size >> 7, size & 0x7f]);
  assert.equal(tag[6], 0);
  assert.equal(tag[7], 0);
  assert.equal(tag[8], 3);
  assert.equal(tag[9], 29);
  assert.equal(tag.length, 10 + 413);
  // Frame size stays a plain 32-bit big-endian value.
  assert.deepEqual(Array.from(tag.slice(14, 18)), [0, 0, 1, 147]); // 403
});

test('id3v2Title encodes non-ASCII titles as UTF-16LE and trims blank titles to empty', () => {
  const tag = id3v2Title('  錄音  ');
  const text = Buffer.from(tag.slice(23)).toString('utf16le');
  assert.equal(text, '錄音');
  assert.equal(id3v2Title('').length, 0);
  assert.ok(id3v2Title('   ') instanceof Uint8Array);
  assert.equal(id3v2Title('   ').length, 0);
  assert.equal(id3v2Title(undefined).length, 0);
});

// Parses the frames of an ID3v2.3 tag produced by id3v2Tags: [{id, body}] with plain 32-bit sizes.
function parseFrames(tag) {
  const frames = [];
  const size = ((tag[6] & 0x7f) << 21) | ((tag[7] & 0x7f) << 14) | ((tag[8] & 0x7f) << 7) | (tag[9] & 0x7f);
  let o = 10;
  while (o < 10 + size) {
    const id = Buffer.from(tag.slice(o, o + 4)).toString('latin1');
    const len = (tag[o + 4] << 24 >>> 0) + (tag[o + 5] << 16) + (tag[o + 6] << 8) + tag[o + 7];
    frames.push({id, body: Buffer.from(tag.slice(o + 10, o + 10 + len))});
    o += 10 + len;
  }
  assert.equal(o, 10 + size, 'frames must exactly fill the synchsafe tag size');
  return frames;
}

test('id3v2Tags writes TIT2 and TPE1 frames with UTF-16 BOM bodies and correct sizes', () => {
  const tag = id3v2Tags({title: '夜空', artist: 'Suno'});
  assert.deepEqual(Array.from(tag.slice(0, 5)), [0x49, 0x44, 0x33, 3, 0]);
  const frames = parseFrames(tag);
  assert.deepEqual(frames.map(f => f.id), ['TIT2', 'TPE1']);
  // TIT2: body = 3 (encoding + BOM) + 2 code units * 2 bytes = 7; frame = 17.
  assert.equal(frames[0].body.length, 7);
  assert.deepEqual(Array.from(frames[0].body.subarray(0, 3)), [0x01, 0xff, 0xfe]);
  assert.equal(frames[0].body.subarray(3).toString('utf16le'), '夜空');
  // TPE1: body = 3 + 4 code units * 2 = 11; frame = 21.
  assert.equal(frames[1].body.length, 11);
  assert.deepEqual(Array.from(frames[1].body.subarray(0, 3)), [0x01, 0xff, 0xfe]);
  assert.equal(frames[1].body.subarray(3).toString('utf16le'), 'Suno');
  // Synchsafe tag size = 17 + 21 = 38.
  assert.equal(tag.length, 10 + 38);
  assert.deepEqual(Array.from(tag.slice(6, 10)), [0, 0, 0, 38]);
});

test('id3v2Tags omits blank fields and returns empty when both are blank', () => {
  assert.deepEqual(parseFrames(id3v2Tags({title: 'Only'})).map(f => f.id), ['TIT2']);
  assert.deepEqual(parseFrames(id3v2Tags({artist: 'Only'})).map(f => f.id), ['TPE1']);
  assert.equal(id3v2Tags({title: '  ', artist: ''}).length, 0);
  assert.equal(id3v2Tags().length, 0);
});

test('id3v2Tags with title only is byte-identical to id3v2Title', () => {
  assert.deepEqual(Buffer.from(id3v2Tags({title: 'Hi'})), Buffer.from(id3v2Title('Hi')));
});

test('id3v2Tags uses synchsafe sizes when the combined frames exceed 127 bytes', () => {
  const tag = id3v2Tags({title: 'x'.repeat(100), artist: 'y'.repeat(100)});
  // TIT2 frame = 10 + 3 + 200 = 213; TPE1 frame = 213; total 426 -> synchsafe.
  const total = 426;
  assert.deepEqual(Array.from(tag.slice(6, 10)), [0, 0, total >> 7, total & 0x7f]);
  assert.equal(tag.length, 10 + total);
  assert.equal(parseFrames(tag).length, 2);
});

test('real lamejs output follows an ID3 tag with TIT2 and TPE1 when prepended', () => {
  const stream = new Mp3Stream(lame, RATE, 128);
  stream.push(sine(0.3));
  const audio = concat(stream.finish());
  const tag = id3v2Tags({title: 'Song', artist: 'Artist'});
  const file = concat([tag, audio]);
  assert.equal(file[0], 0x49);
  assert.equal(file[tag.length], 0xff);
  assert.deepEqual(parseFrames(file.subarray(0, tag.length)).map(f => f.id), ['TIT2', 'TPE1']);
});

