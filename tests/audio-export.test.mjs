import assert from 'node:assert/strict';
import test from 'node:test';
import { planAudioExport, encodeWav, renderWav } from '../docs/audio-export.js';

const score = () => ({ tempo: 120, bars: 4, tracks: {
  melody: [[0, 1, 60, 100], [14, 2, 64, 90]],
  chords: [[0, 4, 48, 80]], bass: [[0, 4, 36, 90]],
} });

test('WAV has independently readable PCM headers, stereo interleaving and finite clipped samples', async () => {
  const left = new Float32Array([-1, 0.5, NaN, 3]), right = new Float32Array([1, -0.5, Infinity, -3]);
  const blob = encodeWav({ numberOfChannels: 2, length: 4, sampleRate: 44100,
    getChannelData: channel => [left, right][channel] }, { fadeIn: 0, fadeOut: 0 });
  assert.equal(blob.type, 'audio/wav');
  const buffer = await blob.arrayBuffer(), data = new DataView(buffer);
  const label = start => String.fromCharCode(...new Uint8Array(buffer, start, 4));
  assert.equal(label(0), 'RIFF'); assert.equal(label(8), 'WAVE'); assert.equal(label(12), 'fmt '); assert.equal(label(36), 'data');
  assert.equal(data.getUint32(4, true), buffer.byteLength - 8);
  assert.equal(data.getUint16(20, true), 1); assert.equal(data.getUint16(22, true), 2);
  assert.equal(data.getUint32(24, true), 44100); assert.equal(data.getUint32(28, true), 176400);
  assert.equal(data.getUint16(32, true), 4); assert.equal(data.getUint16(34, true), 16);
  assert.equal(data.getUint32(40, true), 16);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => data.getInt16(44 + i * 2, true)),
    [-32768, 32767, 16384, -16384, 0, 0, 32767, -32768]);
  assert.equal(left[3], 3, 'encoding must not mutate source channels');
});

test('WAV fades both edges and rejects incomplete or oversized audio', async () => {
  const buffer = { numberOfChannels: 1, length: 1000, sampleRate: 10000,
    getChannelData: () => new Float32Array(1000).fill(0.5) };
  const data = new DataView(await (encodeWav(buffer)).arrayBuffer());
  assert.equal(data.getInt16(44, true), 0);
  assert.equal(data.getInt16(44 + 999 * 2, true), 0);
  assert.ok(data.getInt16(44 + 400 * 2, true) > 0);
  assert.throws(() => encodeWav({ ...buffer, length: 2000000 }), /格式/);
  assert.throws(() => encodeWav({ ...buffer, getChannelData: () => new Float32Array(4) }), /不完整/);
});

test('excerpt plans loop short works, include all four inks, and stop notes at exact duration', () => {
  const inks = ['spark', 'water', 'mist', 'root'].map((kind, i) => ({ kind, beat: i, dur: 100, note: 60 + i, vel: 90 }));
  const plan = planAudioExport(score(), inks, 20);
  assert.equal(plan.duration, 20); assert.equal(plan.musicDuration, 20);
  assert.equal(plan.events.filter(event => event.track === 'melody').length, 5);
  for (const kind of ['spark', 'water', 'mist', 'root']) assert.equal(plan.events.filter(event => event.track === kind).length, 3);
  assert.ok(plan.events.every(event => event.time >= 0 && event.time + event.duration <= 20));
  assert.ok(plan.events.every((event, i) => !i || event.time >= plan.events[i - 1].time));
  assert.equal(plan.events.find(event => event.track === 'chords').velocity, 80 / 127 * 0.9);
  const full = planAudioExport(score(), inks);
  assert.equal(full.musicDuration, 8); assert.equal(full.duration, 16);
  assert.ok(full.events.every(event => event.time + event.duration <= 8));
});

test('invalid notes cannot create NaN, unbounded duration or unsupported export modes', () => {
  const value = score();
  value.tracks.melody.push([NaN, 1, 50, 90], [-1, 1, 50, 90], [0, 0, 50, 90], [0, 1, 128, 90], [30, 1, 50, 90]);
  const plan = planAudioExport(value, [{ kind: '__proto__', beat: 0, dur: 1, note: 40, vel: 100 }], 30);
  assert.ok(plan.events.every(event => Number.isFinite(event.time) && Number.isFinite(event.duration)));
  assert.throws(() => planAudioExport({ ...score(), tempo: 0 }), /乐谱/);
  assert.throws(() => planAudioExport(score(), [], 999), /请选择/);
  assert.throws(() => planAudioExport({ ...score(), tempo: 30, bars: 64 }), /较长/);
});

function mockTone({ sampleFailure = false, roomFailure = false, renderFailure = false } = {}) {
  const nodes = [], attacks = [], contexts = [];
  const realtime = { name: 'realtime' };
  let current = realtime;
  class Node {
    constructor() { this.volume = { value: 0 }; nodes.push(this); }
    chain() { return this; } connect() { return this; } start() { return this; }
    toDestination() { return this; } dispose() { this.disposed = true; }
    triggerAttackRelease(note, duration, time, velocity) { attacks.push({ synth: this, note, duration, time, velocity }); }
  }
  class Sampler extends Node {
    constructor(options) { super(); queueMicrotask(() => sampleFailure ? options.onerror(new Error('sample failed')) : options.onload()); }
  }
  class Reverb extends Node {
    constructor() { super(); this.ready = roomFailure ? Promise.reject(new Error('reverb failed')) : Promise.resolve(); }
  }
  const tone = {
    Sampler, Reverb, Gain: Node, Limiter: Node, PolySynth: Node, MonoSynth: Node, Synth: Node,
    FMSynth: Node, AMSynth: Node, Filter: Node, Chorus: Node, PingPongDelay: Node, FeedbackDelay: Node,
    Frequency: note => ({ toNote: () => `midi-${note}` }),
    getContext: () => current, setContext: value => { current = value; },
    async Offline(callback, duration, channels, rate) {
      const callbacks = [];
      const context = { transport: { bpm: { value: 120 }, start() {},
        schedule(fn, time) { callbacks.push({ fn, time }); } }, dispose() { this.disposed = true; } };
      contexts.push(context); current = context;
      await callback(context); // Like Tone 15, a rejected callback skips restore.
      current = realtime;
      if (renderFailure) throw new Error('render failed');
      callbacks.forEach(({ fn, time }) => fn(time));
      const audio = { numberOfChannels: channels, length: Math.round(duration * rate), sampleRate: rate,
        getChannelData: () => new Float32Array(Math.round(duration * rate)) };
      return { get: () => audio, dispose() { this.disposed = true; } };
    },
  };
  return { tone, nodes, attacks, contexts, realtime, Sampler };
}

test('offline export uses existing piano/ink instruments, full mix, and restores/reclaims its context', async () => {
  const previous = globalThis.Tone, mock = mockTone(); globalThis.Tone = mock.tone;
  try {
    const stages = [];
    const saved = await renderWav(score(), [{ kind: 'root', beat: 2, dur: 1, note: 36, vel: 90 }], 'piano', {
      seconds: 20, onProgress: value => stages.push(value.stage),
    });
    assert.equal(saved.duration, 20); assert.equal(saved.sampleFallback, false);
    assert.equal(saved.blob.size, 44 + 20 * 44100 * 4);
    assert.equal(mock.attacks.filter(attack => attack.synth instanceof mock.Sampler).length, 11);
    assert.equal(mock.attacks.filter(attack => !(attack.synth instanceof mock.Sampler)).length, 3);
    assert.deepEqual(stages, ['preparing', 'rendering', 'encoding', 'done']);
    assert.equal(mock.tone.getContext(), mock.realtime);
    assert.ok(mock.nodes.every(node => node.disposed)); assert.ok(mock.contexts.every(context => context.disposed));
  } finally { globalThis.Tone = previous; }
});

test('sample fallback is explicit; failed callback/render always restores context and allows retry', async () => {
  const previous = globalThis.Tone;
  try {
    const fallback = mockTone({ sampleFailure: true }); globalThis.Tone = fallback.tone;
    const saved = await renderWav(score(), [], 'forest', { seconds: 20 });
    assert.equal(saved.sampleFallback, true); assert.match(saved.warnings[0], /合成琴音/);
    for (const failure of [{ roomFailure: true }, { renderFailure: true }]) {
      const failed = mockTone(failure); globalThis.Tone = failed.tone;
      await assert.rejects(() => renderWav(score(), [], 'ice'), /failed/);
      assert.equal(failed.tone.getContext(), failed.realtime);
      assert.ok(failed.nodes.every(node => node.disposed));
      assert.ok(failed.contexts.every(context => context.disposed));
    }
    const retry = mockTone(); globalThis.Tone = retry.tone;
    assert.equal((await renderWav(score(), [], 'machine')).presetName, 'machine');
  } finally { globalThis.Tone = previous; }
});

test('parallel exports are rejected, while exceptions in progress UI cannot lose an export', async () => {
  const previous = globalThis.Tone, mock = mockTone(); globalThis.Tone = mock.tone;
  try {
    const first = renderWav(score(), [], 'piano', { onProgress() { throw new Error('UI failed'); } });
    await assert.rejects(() => renderWav(score(), [], 'piano'), /上一份/);
    const saved = await first;
    assert.ok(saved.blob.size > 44); assert.equal(mock.tone.getContext(), mock.realtime);
  } finally { globalThis.Tone = previous; }
});
