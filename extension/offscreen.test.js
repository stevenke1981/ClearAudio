import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRecorder} from './offscreen.js';
import {id3v2Title} from './mp3.js';

// Fake lamejs encoder: returns 10 bytes per encodeBuffer call, 5 on flush.
class FakeEncoder {
  constructor(channels, rate, kbps) {
    this.args = [channels, rate, kbps];
    this.fail = false;
  }
  encodeBuffer(l) {
    if (this.fail) throw new Error('synthetic encoder failure');
    return new Int8Array(10);
  }
  flush() {
    return new Int8Array(5);
  }
}

function makeEnv(overrides = {}) {
  const env = {
    sent: [], posted: [], cleared: [], revoked: [], created: [],
    contexts: [], nodes: [], getUserMediaCalls: 0, constraints: null,
    interval: null, encoder: null,
  };
  env.track = {
    readyState: 'live', stopped: false, onended: null,
    stop() { this.stopped = true; },
  };
  env.stream = {getTracks: () => [env.track], getAudioTracks: () => [env.track]};
  const deps = {
    getUserMedia: async constraints => {
      env.getUserMediaCalls++;
      env.constraints = constraints;
      if (overrides.getUserMediaError) throw new Error(overrides.getUserMediaError);
      return env.stream;
    },
    AudioContext: class {
      constructor() {
        this.sampleRate = 48000;
        this.state = 'running';
        this.closed = false;
        this.destination = {};
        this.audioWorklet = {addModule: async () => {}};
        this.onstatechange = null;
        env.contexts.push(this);
      }
      createMediaStreamSource() {
        return {connect() {}, disconnect() {}};
      }
      async resume() {}
      async close() { this.state = 'closed'; this.closed = true; }
    },
    AudioWorkletNode: class {
      constructor(ctx, name) {
        this.name = name;
        this.connected = [];
        this.port = {
          onmessage: null,
          postMessage: message => {
            env.posted.push(message);
            if (message === 'stop') queueMicrotask(() => this.port.onmessage?.({data: {done: true}}));
          },
        };
        env.nodes.push(this);
      }
      connect() {}
      disconnect() {}
    },
    lamejs: {Mp3Encoder: class extends FakeEncoder {
      constructor(...args) {
        super(...args);
        env.encoder = this;
        if (overrides.encoderFail) this.fail = true;
      }
    }},
    URL: {
      createObjectURL: blob => { env.created.push(blob); return `blob:test/${env.created.length}`; },
      revokeObjectURL: url => env.revoked.push(url),
    },
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options.type;
        this.size = parts.reduce((n, p) => n + p.length, 0);
      }
    },
    send: message => { env.sent.push(message); },
    setInterval: fn => { env.interval = fn; return 7; },
    clearInterval: id => { env.cleared.push(id); },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    maxBytes: overrides.maxBytes,
  };
  env.deps = deps;
  env.recorder = createRecorder(deps);
  env.handle = msg => env.recorder.handle({target: 'offscreen', ...msg});
  env.pcm = (samples) => env.nodes[0].port.onmessage({data: {pcm: new Float32Array(samples).buffer}});
  env.tick = () => env.interval();
  env.settle = async () => { await env.recorder.settled(); await new Promise(r => setImmediate(r)); };
  return env;
}

test('start resolves with sample rate and requests tab stream', async () => {
  const env = makeEnv();
  const res = await env.handle({type: 'start', streamId: 'sid-1', kbps: 192, title: 'Demo'});
  assert.deepEqual(res, {ok: true, sampleRate: 48000});
  assert.equal(env.constraints.audio.mandatory.chromeMediaSource, 'tab');
  assert.equal(env.constraints.audio.mandatory.chromeMediaSourceId, 'sid-1');
  assert.equal(env.constraints.video, false);
  assert.equal(env.nodes[0].name, 'pcm');
  assert.equal(env.encoder.args[2], 192);
  assert.equal(env.recorder.active, true);
});

test('start with invalid kbps or missing stream id is rejected without capture', async () => {
  const env = makeEnv();
  assert.match((await env.handle({type: 'start', streamId: 'x', kbps: 64})).error, /位元率/);
  assert.match((await env.handle({type: 'start', streamId: '', kbps: 128})).error, /串流/);
  assert.equal(env.getUserMediaCalls, 0);
  assert.equal(env.recorder.active, false);
});

test('level is sent every tick with real PCM peak, peak hold and clip count', async () => {
  const env = makeEnv();
  await env.handle({type: 'start', streamId: 'sid', kbps: 128});
  env.pcm([0.5, -0.25, 0.1, 0.2]);
  env.tick();
  const [first] = env.sent.filter(m => m.type === 'level');
  assert.equal(first.from, 'offscreen');
  assert.equal(first.peak, 0.5);
  assert.equal(first.peakHold, 0.5);
  assert.equal(first.clips, 0);
  assert.equal(first.seconds, 2 / 48000);
  assert.equal(first.bytes, 0); // only 2 frames: no full 1152-frame block encoded yet

  env.pcm(new Float32Array(1152 * 2).fill(0.1)); // one full block -> encoder emits bytes
  env.tick();
  assert.ok(env.sent.filter(m => m.type === 'level')[1].bytes > 0);

  env.pcm([1, 0]);
  env.tick();
  const levels = env.sent.filter(m => m.type === 'level');
  assert.equal(levels.at(-1).peak, 1);
  assert.equal(levels.at(-1).peakHold, 1);
  assert.equal(levels.at(-1).clips, 1);

  env.tick(); // silent interval: peak resets, clips and peakHold stay
  const last = env.sent.filter(m => m.type === 'level').at(-1);
  assert.equal(last.peak, 0);
  assert.equal(last.peakHold, 1);
  assert.equal(last.clips, 1);
});

test('stop drains worklet, finishes encoder and reports finished with blob url and reason stop', async () => {
  const env = makeEnv();
  await env.handle({type: 'start', streamId: 'sid', kbps: 320, title: 'Test title'});
  env.pcm([0.3, 0.3, 0.3, 0.3]);
  assert.deepEqual(await env.handle({type: 'stop'}), {ok: true});
  await env.settle();

  assert.ok(env.posted.includes('stop'));
  const finished = env.sent.find(m => m.type === 'finished');
  assert.ok(finished, 'finished sent');
  assert.equal(finished.url, 'blob:test/1');
  assert.equal(finished.reason, 'stop');
  assert.equal(finished.seconds, 2 / 48000);
  assert.equal(finished.bytes, env.created[0].size);
  assert.equal(env.created[0].type, 'audio/mpeg');
  assert.deepEqual(Buffer.from(env.created[0].parts[0]), Buffer.from(id3v2Title('Test title')));
  assert.equal(env.track.stopped, true);
  assert.equal(env.contexts[0].closed, true);
  assert.ok(env.cleared.includes(7));
  assert.equal(env.recorder.active, false);
  assert.equal(env.sent.filter(m => m.type === 'error').length, 0);
});

test('finished without a title carries no ID3 tag part content', async () => {
  const env = makeEnv();
  await env.handle({type: 'start', streamId: 'sid', kbps: 128});
  await env.handle({type: 'stop'});
  await env.settle();
  assert.equal(env.created[0].parts[0].length, 0);
});

test('revoke releases the blob url', async () => {
  const env = makeEnv();
  assert.deepEqual(await env.handle({type: 'revoke', url: 'blob:test/9'}), {ok: true});
  assert.deepEqual(env.revoked, ['blob:test/9']);
});

test('cancel discards without finished and releases all resources', async () => {
  const env = makeEnv();
  await env.handle({type: 'start', streamId: 'sid', kbps: 128});
  env.pcm([0.4, 0.4]);
  assert.deepEqual(await env.handle({type: 'cancel'}), {ok: true});
  await env.settle();
  assert.equal(env.sent.filter(m => m.type === 'finished').length, 0);
  assert.equal(env.sent.filter(m => m.type === 'error').length, 0);
  assert.equal(env.created.length, 0);
  assert.equal(env.track.stopped, true);
  assert.equal(env.contexts[0].closed, true);
  assert.ok(env.cleared.includes(7));
  assert.equal(env.recorder.active, false);
  assert.ok(!env.posted.includes('stop'));
  // Cancel with nothing active is a harmless no-op.
  assert.deepEqual(await env.handle({type: 'cancel'}), {ok: true});
});

test('track ended finishes with reason source-ended', async () => {
  const env = makeEnv();
  await env.handle({type: 'start', streamId: 'sid', kbps: 128});
  env.pcm([0.2, 0.2]);
  env.track.onended();
  await env.settle();
  const finished = env.sent.find(m => m.type === 'finished');
  assert.equal(finished.reason, 'source-ended');
  assert.equal(env.track.stopped, true);
  assert.equal(env.recorder.active, false);
});

test('second start while recording is rejected', async () => {
  const env = makeEnv();
  assert.deepEqual(await env.handle({type: 'start', streamId: 'a', kbps: 128}), {ok: true, sampleRate: 48000});
  assert.deepEqual(await env.handle({type: 'start', streamId: 'b', kbps: 128}), {error: '已有錄音進行中'});
  assert.equal(env.getUserMediaCalls, 1);
  assert.equal(env.recorder.active, true);
});

test('start failure returns error and leaves no active session', async () => {
  const env = makeEnv({getUserMediaError: '使用者拒絕授權'});
  assert.deepEqual(await env.handle({type: 'start', streamId: 'a', kbps: 128}), {error: '使用者拒絕授權'});
  assert.equal(env.recorder.active, false);
  // A later start is accepted once the failed one is cleared.
  const retry = makeEnv();
  assert.equal((await retry.handle({type: 'start', streamId: 'a', kbps: 128})).ok, true);
});

test('stop without an active recording returns error', async () => {
  const env = makeEnv();
  assert.match((await env.handle({type: 'stop'})).error, /沒有進行中的錄音/);
});

test('encoder error releases everything and reports error message', async () => {
  const env = makeEnv({encoderFail: true});
  await env.handle({type: 'start', streamId: 'sid', kbps: 128});
  env.pcm(new Float32Array(1152 * 2).fill(0.2)); // full block so encodeBuffer runs
  await env.settle();
  const err = env.sent.find(m => m.type === 'error');
  assert.deepEqual(err, {from: 'offscreen', type: 'error', message: 'synthetic encoder failure'});
  assert.equal(env.track.stopped, true);
  assert.equal(env.contexts[0].closed, true);
  assert.ok(env.cleared.includes(7));
  assert.equal(env.recorder.active, false);
  assert.equal(env.sent.filter(m => m.type === 'finished').length, 0);
});

test('encoder size limit finishes with reason limit and keeps encoded audio', async () => {
  const env = makeEnv({maxBytes: 15});
  await env.handle({type: 'start', streamId: 'sid', kbps: 128});
  env.pcm(new Float32Array(2 * 1152 * 2).fill(0.1)); // two full blocks -> 20 bytes > 15
  await env.settle();
  const finished = env.sent.find(m => m.type === 'finished');
  assert.ok(finished, 'finished sent');
  assert.equal(finished.reason, 'limit');
  assert.equal(env.sent.filter(m => m.type === 'error').length, 0);
  assert.equal(env.track.stopped, true);
  assert.equal(env.recorder.active, false);
});

test('audio context suspension while recording fails and releases', async () => {
  const env = makeEnv();
  await env.handle({type: 'start', streamId: 'sid', kbps: 128});
  const ctx = env.contexts[0];
  ctx.state = 'suspended';
  ctx.onstatechange();
  await env.settle();
  assert.match(env.sent.find(m => m.type === 'error').message, /AudioContext/);
  assert.equal(env.track.stopped, true);
  assert.equal(env.recorder.active, false);
});

test('unrelated messages are ignored by the recorder', async () => {
  const env = makeEnv();
  assert.equal(await env.recorder.handle({type: 'start', streamId: 'x', kbps: 128}), null);
});
