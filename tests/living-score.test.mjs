import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_TEMPO, LIVE_BEATS, sampleLivingNote, createLivingVoice, buildLivingScore, livingVoicePosition, normalizeLivingEnsemble } from '../docs/living-score.js';
import { planAudioExport } from '../docs/audio-export.js';

const base = () => ({ tempo: 80, bars: 16, key: 'D 大调', tonic: 'D', mode: 'major',
  global: { tonicPc: 2, mode: 'major', brightness: 0.7 },
  tracks: { melody: [[0, 1, 62, 80]], chords: [[0, 4, 66, 60]], bass: [[0, 4, 38, 70]] },
  geometry: { type: 'lr', bounds: [0, 0.5, 1] } });
const sample = (tMs = 0, extra = {}) => ({ tMs, x: 0.1, y: 0.4, kind: 'spark', note: 74, vel: 84, dur: 0.4, color: '#ffd040', ...extra });
const approx = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
function image(w = 20, h = 20, pixel = () => [30, 0.8, 0.8]) {
  const H = [], S = [], V = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [hue, sat, val] = pixel(x, y); H.push(hue); S.push(sat); V.push(val);
  }
  return { w, h, H, S, V };
}
function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return value;
}

test('living mode has a fixed shared two-bar 4.8-second score', () => {
  assert.equal(LIVE_TEMPO, 100);
  assert.equal(LIVE_BEATS, 8);
  assert.equal(LIVE_BEATS * 60000 / LIVE_TEMPO, 4800);
  const source = base(), { result, ink } = buildLivingScore(source, []);
  assert.equal(result.tempo, 100); assert.equal(result.bars, 2);
  assert.equal(result.key, source.key);
  assert.deepEqual(result.tracks, { melody: [], chords: [], bass: [] });
  assert.deepEqual(ink, []);
});

test('four actual colored regions choose four instruments and preserve sampled pigment colors', () => {
  const pigments = [[30, 0.9, 0.8], [120, 0.8, 0.65], [215, 0.8, 0.85], [285, 0.6, 0.85]];
  const analysis = image(40, 20, x => pigments[Math.floor(x / 10)]);
  const notes = [0.1, 0.36, 0.64, 0.9].map(x => sampleLivingNote(analysis, base(), x, 0.5));
  assert.deepEqual(notes.map(note => note.kind), ['spark', 'root', 'water', 'mist']);
  assert.equal(new Set(notes.map(note => note.color)).size, 4);
  assert.ok(notes.every(note => /^rgb\(\d+, \d+, \d+\)$/.test(note.color)));
  assert.equal(notes[1].color, 'rgb(33, 166, 33)');
  assert.notDeepEqual(notes[0], notes[2]);
});

test('color response is local, deterministic, and has no position-only melody on a flat patch', () => {
  const uniform = image(), changedElsewhere = image(20, 20, x => x < 10 ? [30, 0.8, 0.8] : [220, 1, 0.5]);
  const note = sampleLivingNote(uniform, base(), 0.1, 0.2);
  assert.deepEqual(note, sampleLivingNote(changedElsewhere, base(), 0.1, 0.2));
  assert.deepEqual(note, sampleLivingNote(uniform, base(), 0.7, 0.9));
  assert.deepEqual(note, sampleLivingNote(uniform, base(), 0.1, 0.2));
});

test('patch hue is circular, grey stays mist, and black becomes a quiet low root', () => {
  const reds = image(3, 1, x => [x === 1 ? 1 : 359, 1, 1]);
  const red = sampleLivingNote(reds, base(), 0.5, 0.5);
  assert.equal(red.kind, 'spark'); assert.match(red.color, /^rgb\(255, [01], [01]\)$/);
  const grey = sampleLivingNote(image(1, 1, () => [180, 0, 0.8]), base(), 0, 0);
  assert.equal(grey.kind, 'mist'); assert.equal(grey.color, 'rgb(204, 204, 204)');
  const black = sampleLivingNote(image(1, 1, () => [0, 0, 0]), base(), 0, 0);
  assert.equal(black.kind, 'root'); assert.equal(black.color, 'rgb(0, 0, 0)');
  assert.ok(black.note < grey.note); assert.ok(black.vel < grey.vel);
});

test('brighter shades rise through a bounded register in the global major or minor pentatonic', () => {
  for (const mode of ['major', 'minor']) for (let tonic = 0; tonic < 12; tonic++) {
    const score = { ...base(), mode, global: { tonicPc: tonic } };
    const scale = mode === 'major' ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
    for (const hue of [20, 120, 210, 280]) {
      const notes = [0.3, 0.5, 0.7, 0.9].map(value => sampleLivingNote(image(1, 1, () => [hue, 0.8, value]), score, 0.5, 0.5));
      assert.ok(notes.every(note => scale.includes((note.note - tonic + 120) % 12)));
      assert.ok(notes.every((note, i) => !i || note.note >= notes[i - 1].note));
      assert.ok(notes.at(-1).note > notes[0].note);
      assert.ok(notes.every(note => note.note >= 36 && note.note <= 86 && note.vel >= 40 && note.vel <= 104));
    }
  }
});

test('malformed image analysis is rejected; finite coordinates and image-edge sampling are bounded', () => {
  const analysis = image(1, 1);
  const expected = sampleLivingNote(analysis, null, 0, 0);
  for (const [x, y] of [[-99, 80], [NaN, Infinity], [1, 1]]) assert.deepEqual(sampleLivingNote(analysis, null, x, y), expected);
  for (const value of [null, {}, { w: -1, h: 1 }, { w: 1.5, h: 1 }, { w: 999999, h: 999999 }, { ...analysis, H: [] }]) {
    assert.throws(() => sampleLivingNote(value, base(), 0, 0), RangeError);
  }
  assert.throws(() => sampleLivingNote(image(1, 1, () => [NaN, 1, 1]), base(), 0, 0), RangeError);
});

test('gesture sorting preserves exact real rhythm, initial delay, and silence padding without quantization', () => {
  const inputs = [sample(1017, { x: 0.9 }), sample(73, { x: 0.1 }), sample(307, { x: 0.4 })];
  const voice = createLivingVoice(inputs, { id: 'gesture', durationMs: 1200 });
  assert.equal(voice.loopBeats, 4); assert.equal(voice.durationBeats, 2);
  assert.deepEqual(voice.points.map(point => point.tMs), [73, 307, 1017]);
  [73, 307, 1017].forEach((time, i) => approx(voice.events[i].beat, time / 600));
  approx(voice.events[1].beat - voice.events[0].beat, 234 / 600);
  assert.equal(livingVoicePosition(voice, 0).active, false);
  assert.equal(livingVoicePosition(voice, 3.9).active, false);
  assert.equal(livingVoicePosition(voice, 3.9).x, 0.9);
});

test('adaptive 4/8-beat loops use release duration, never stretch a shorter gesture', () => {
  for (const [durationMs, loopBeats] of [[0, 4], [1000, 4], [2400, 4], [2400.1, 8], [4800, 8], [99999, 8]]) {
    const voice = createLivingVoice([sample(0), sample(700)], { id: 'adaptive', durationMs });
    assert.equal(voice.loopBeats, loopBeats);
    assert.ok(voice.durationMs <= 4800);
    assert.equal(voice.events[0].beat, 0);
    if (durationMs >= 700) approx(voice.events[1].beat, 700 / 600);
  }
  const inferred = createLivingVoice([sample(3000), sample(0)], { id: 'long' });
  assert.equal(inferred.loopBeats, 8); assert.equal(inferred.durationMs, 3000);
});

test('a tap is an audible one-note voice with one note per short loop', () => {
  const voice = createLivingVoice([sample()], { id: 'tap', durationMs: 0 });
  assert.equal(voice.points.length, 1); assert.equal(voice.events.length, 1);
  assert.equal(voice.events[0].beat, 0); assert.ok(voice.events[0].dur > 0);
  const { ink } = buildLivingScore(base(), [voice]);
  assert.deepEqual(ink.map(event => event.beat), [0, 4]);
  assert.equal(livingVoicePosition(voice, 0.1).active, true);
  assert.equal(livingVoicePosition(voice, 1).active, false);
  assert.equal(livingVoicePosition(voice, 4.1).active, true);
});

test('release and loop boundaries reject extra notes rather than collapsing them onto an endpoint', () => {
  const short = createLivingVoice([sample(0), sample(2399), sample(2400), sample(2500)], { id: 'short', durationMs: 2400 });
  assert.equal(short.events.length, 2); assert.equal(short.loopBeats, 4);
  assert.ok(short.events.every(event => event.beat >= 0 && event.beat < 4 && event.beat + event.dur <= 4));
  const long = createLivingVoice([sample(0), sample(4700), sample(4800), sample(9000)], { id: 'long', durationMs: 10000 });
  assert.equal(long.events.length, 2); assert.equal(long.loopBeats, 8);
  assert.ok(long.events.every(event => event.beat >= 0 && event.beat < 8 && event.beat + event.dur <= 8));
  assert.deepEqual(createLivingVoice([sample(0), sample(1500)], { durationMs: 1000 }).events.map(event => event.beat), [0]);
});

test('too-dense gestures retain original timestamps and both endpoints with at most 64 points', () => {
  const source = Array.from({ length: 10000 }, (_, i) => sample(i * 0.45, { x: i / 9999 }));
  const voice = createLivingVoice(source, { id: 'dense', durationMs: 4500 });
  assert.equal(voice.points.length, 64); assert.equal(voice.events.length, 64);
  assert.equal(voice.points[0].tMs, 0); assert.equal(voice.points.at(-1).tMs, source.at(-1).tMs);
  assert.equal(voice.points[0].x, 0); assert.equal(voice.points.at(-1).x, 1);
  assert.ok(voice.points.every(point => source.some(original => original.tMs === point.tMs)));
  assert.ok(voice.events.every((event, i) => !i || event.beat > voice.events[i - 1].beat));
});

test('negative/NaN values, duplicate timestamps, invalid kinds and unbounded notes cannot poison playback', () => {
  const voice = createLivingVoice([null, {}, sample(NaN), sample(Infinity), sample(0, { kind: '__proto__' }),
    sample(0, { vel: 0 }), sample(0, { dur: -1 }), sample(0, { note: NaN }),
    sample(-50, { x: 0.1 }), sample(0, { x: 0.9 }),
    sample(200, { x: NaN, y: -20, note: 2000, vel: 999, dur: 999, color: 'url(bad)' }),
    sample(400, { x: Infinity, y: 90, note: -30 })], { id: NaN, tempo: NaN, durationMs: NaN });
  assert.equal(voice.id, 'living'); assert.equal(voice.events.length, 3);
  assert.equal(voice.points[0].x, 0.9, 'same-time notifications keep the latest position');
  assert.equal(voice.events[1].note, 127); assert.equal(voice.events[2].note, 0);
  for (const event of voice.events) {
    assert.ok(['beat', 'dur', 'note', 'vel', 'x', 'y'].every(key => Number.isFinite(event[key])));
    assert.ok(event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1);
    assert.ok(event.dur > 0 && event.dur <= 2 && event.vel > 0 && event.vel <= 127);
  }
  assert.equal(voice.events[1].color, '#fbbf24');
  assert.deepEqual(createLivingVoice(null).events, []);
  for (const tempo of [0, -10, Infinity, NaN, 900]) {
    assert.ok(createLivingVoice([sample(0), sample(100)], { tempo }).events.every(event => Number.isFinite(event.beat)));
  }
});

test('three voice slots are bounded including muted slots, with at most 384 short-loop export events', () => {
  const sources = Array.from({ length: 64 }, (_, i) => sample(i * 30));
  const voices = Array.from({ length: 5 }, (_, i) => createLivingVoice(sources, { id: `voice${i}`, durationMs: 2100 }));
  const { ink } = buildLivingScore(base(), voices);
  assert.equal(ink.length, 3 * 64 * 2); assert.equal(new Set(ink.map(event => event.id)).size, ink.length);
  assert.deepEqual([...new Set(ink.map(event => event.voiceId))], ['voice0', 'voice1', 'voice2']);
  voices[1].muted = true;
  const muted = buildLivingScore(base(), voices).ink;
  assert.equal(muted.length, 2 * 64 * 2);
  assert.ok(muted.every(event => event.voiceId === 'voice0' || event.voiceId === 'voice2'));
});

test('build rejects malformed external events and gives repeated/duplicate IDs stable unique identities', () => {
  const good = createLivingVoice([sample(0), sample(500)], { id: 'same' });
  const bad = { ...good, events: [null, {}, ...good.events, { ...good.events[0], beat: NaN },
    { ...good.events[0], beat: -1 }, { ...good.events[0], beat: 8 }, { ...good.events[0], dur: 0 }] };
  const first = buildLivingScore(base(), [bad, good, null]);
  assert.equal(first.ink.length, 8); assert.equal(new Set(first.ink.map(event => event.id)).size, 8);
  assert.deepEqual(first, buildLivingScore(base(), [bad, good, null]));
  assert.ok(first.ink.every((event, i) => event.beat >= 0 && event.beat < 8 && (!i || event.beat >= first.ink[i - 1].beat)));
});

test('offset/repeats wrap in the shared loop and animation identifies the exact scheduled event', () => {
  const voice = createLivingVoice([sample(0, { x: 0.1 }), sample(600, { x: 0.9, kind: 'water', color: '#08afff' })], { id: 'offset', durationMs: 900 });
  voice.offsetBeat = 7.5;
  const { ink } = buildLivingScore(base(), [voice]);
  assert.deepEqual(ink.map(event => event.beat), [0.5, 3.5, 4.5, 7.5]);
  for (const event of ink) {
    const position = livingVoicePosition(voice, event.beat);
    assert.equal(position.active, true); assert.equal(position.eventId, event.id);
    assert.equal(position.note, event.note); assert.equal(position.kind, event.kind); assert.equal(position.color, event.color);
    approx(position.x, event.x); approx(position.y, event.y);
    assert.deepEqual(livingVoicePosition(voice, event.beat + 8), position);
  }
  const negative = { ...voice, offsetBeat: -0.5 };
  assert.deepEqual(buildLivingScore(base(), [negative]), buildLivingScore(base(), [voice]));
});

test('position interpolates recorded path then rests at its endpoint without a phantom return journey', () => {
  const voice = createLivingVoice([sample(0, { x: 0, y: 0 }), sample(600, { x: 0.5, y: 1 }), sample(1200, { x: 1, y: 0 })], { id: 'path', durationMs: 1300 });
  const midway = livingVoicePosition(voice, 0.5);
  approx(midway.x, 0.25); approx(midway.y, 0.5); assert.equal(midway.active, false);
  const rest = livingVoicePosition(voice, 3.9);
  assert.equal(rest.x, 1); assert.equal(rest.y, 0); assert.equal(rest.active, false); assert.equal(rest.eventId, null);
  assert.equal(livingVoicePosition(voice, 4).x, 0);
  const long = createLivingVoice([sample(0), sample(3000, { x: 0.9 })], { id: 'long', durationMs: 3100 });
  assert.equal(livingVoicePosition(long, 7.9).x, 0.9); assert.equal(livingVoicePosition(long, 7.9).active, false);
});

test('muted companions produce no export notes or active animation; empty/malformed positions stay finite', () => {
  const voice = createLivingVoice([sample()], { id: 'muted' }); voice.muted = true;
  assert.deepEqual(buildLivingScore(base(), [voice]).ink, []);
  assert.equal(livingVoicePosition(voice, 0).active, false);
  assert.equal(livingVoicePosition(voice, 0).eventId, null);
  for (const input of [null, {}, { points: [null, {}, { beat: NaN }], events: [null] }]) {
    for (const beat of [NaN, Infinity, -999]) {
      const position = livingVoicePosition(input, beat);
      assert.ok([position.x, position.y, position.beat].every(Number.isFinite));
      assert.equal(position.active, false);
    }
  }
});

test('all helpers preserve frozen inputs, detached score metadata, and deterministic repeated calls', () => {
  const analysis = deepFreeze(image()), score = deepFreeze(base());
  const pigment = sampleLivingNote(analysis, score, 0.2, 0.3);
  const points = deepFreeze([sample(0, pigment), sample(817, { ...pigment, x: 0.8 })]);
  const options = deepFreeze({ id: 'immutable', durationMs: 1100 });
  const original = JSON.stringify({ analysis, score, points, options });
  const voice = deepFreeze(createLivingVoice(points, options));
  const result = buildLivingScore(score, [voice]);
  assert.deepEqual(createLivingVoice(points, options), voice);
  assert.deepEqual(buildLivingScore(score, [voice]), result);
  assert.deepEqual(livingVoicePosition(voice, 0.25), livingVoicePosition(voice, 0.25));
  assert.equal(JSON.stringify({ analysis, score, points, options }), original);
  result.result.global.tonicPc = 9; result.result.geometry.bounds[1] = 0.2; result.ink[0].note = 1;
  assert.equal(score.global.tonicPc, 2); assert.equal(score.geometry.bounds[1], 0.5);
  assert.equal(voice.events[0].note, pigment.note);
});

test('live events feed the existing WAV planner with exact tempo, silence, kinds, and muted omissions', () => {
  const voices = [createLivingVoice([sample(0, { kind: 'water' }), sample(600, { kind: 'root' })], { id: 'duet', durationMs: 1200 }),
    createLivingVoice([sample(0, { kind: 'mist' })], { id: 'muted' })];
  voices[1].muted = true;
  const { result, ink } = buildLivingScore(base(), voices), plan = planAudioExport(result, ink);
  assert.equal(plan.tempo, 100); assert.equal(plan.musicDuration, 4.8);
  assert.deepEqual(plan.events.map(event => event.track), ['water', 'root', 'water', 'root']);
  assert.deepEqual(plan.events.map(event => event.time), [0, 0.6, 2.4, 3]);
  assert.ok(plan.events.every(event => event.duration > 0 && event.time + event.duration <= plan.musicDuration));
  assert.ok(!plan.events.some(event => ['melody', 'chords', 'bass', 'mist'].includes(event.track)));
});


test('fractional pointer timestamps and offset seams keep audio/animation onset IDs identical', () => {
  for (let phase = 0; phase < 50; phase++) {
    const voice = createLivingVoice(Array.from({ length: 20 }, (_, i) => sample(i * 109.17, { x: i / 20, dur: 0.1 })),
      { id: 'fractional', durationMs: 2200 });
    voice.offsetBeat = phase * 0.113;
    for (const event of buildLivingScore(base(), [voice]).ink) {
      const position = livingVoicePosition(voice, event.beat);
      assert.equal(position.eventId, event.id);
      assert.equal(position.active, true);
      approx(position.x, event.x);
    }
  }
});


function savedEnsemble() {
  const voices = [
    createLivingVoice([sample(73), sample(317, { x: 0.3, kind: 'water', color: 'rgb(0, 150, 200)' }),
      sample(1417, { x: 0.9, kind: 'mist', dur: 0.7 })], { id: 'short', durationMs: 1700 }),
    createLivingVoice([sample(0, { kind: 'root', note: 38, dur: 0.55 }),
      sample(1937, { x: 0.8, y: 0.9, kind: 'water', note: 62, dur: 1.7 }),
      sample(4799, { x: 0.1, y: 0.1, dur: 2 })], { id: 'long', durationMs: 4800 }),
    createLivingVoice([sample(0, { x: 0.5, kind: 'mist', color: '#abcdef' })], { id: 'tap', durationMs: 0 }),
  ];
  voices[0].offsetBeat = 7.137; voices[0].muted = true;
  voices[1].offsetBeat = 1.713;
  voices[2].offsetBeat = 0.113;
  return { v: 1, tempo: 100, voices };
}

test('persisted ensemble round-trips exact audible events, timed paths, phase, mute, and note tails', () => {
  const original = savedEnsemble(), serialized = JSON.parse(JSON.stringify(original));
  const restored = normalizeLivingEnsemble(serialized);
  assert.deepEqual(restored, original);
  assert.deepEqual(restored.voices.map(voice => voice.id), ['short', 'long', 'tap']);
  assert.deepEqual(restored.voices.map(voice => voice.loopBeats), [4, 8, 4]);
  assert.deepEqual(restored.voices[0].points.map(point => point.tMs), [73, 317, 1417]);
  assert.equal(restored.voices[0].muted, true);
  assert.equal(restored.voices[0].offsetBeat, 7.137);
  assert.ok(restored.voices[1].points.at(-1).dur < 0.01, 'a note clipped at a loop seam must not be inflated');
  assert.deepEqual(buildLivingScore(base(), restored.voices), buildLivingScore(base(), original.voices));
  for (let beat = 0; beat < 16; beat += 0.07163) {
    original.voices.forEach((voice, index) => assert.deepEqual(livingVoicePosition(restored.voices[index], beat), livingVoicePosition(voice, beat)));
  }
  assert.deepEqual(normalizeLivingEnsemble(restored), restored, 'normalization is idempotent');
});

test('persisted identity ignores bogus cached/runtime fields, and samples can be an input alias', () => {
  const clean = savedEnsemble(), noisy = structuredClone(clean);
  noisy.lastPlayed = Date.now(); noisy.preview = 'not a score field';
  for (const voice of noisy.voices) {
    voice.events = [{ note: NaN, kind: 'unknown', beat: Infinity }];
    voice.color = 'url(untrusted)'; voice.durationBeats = -999; voice.pulse = Infinity;
    for (const point of voice.points) { point.beat = 99; point.pulse = 888; point.runtimeId = 'unstable'; }
  }
  assert.deepEqual(normalizeLivingEnsemble(noisy), clean);
  const aliased = structuredClone(clean);
  for (const voice of aliased.voices) { voice.samples = voice.points; delete voice.points; }
  assert.deepEqual(normalizeLivingEnsemble(aliased), clean);
  assert.equal(JSON.stringify(normalizeLivingEnsemble(noisy)), JSON.stringify(normalizeLivingEnsemble(aliased)));
});

test('normalizing persisted work never mutates input and returns detached canonical objects', () => {
  const original = deepFreeze(savedEnsemble()), before = JSON.stringify(original);
  const restored = normalizeLivingEnsemble(original);
  restored.voices[0].points[0].note = 3;
  restored.voices[1].events[0].x = 0.9;
  restored.voices[2].muted = true;
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(original.voices[0].points[0].note, 3);
});

test('empty ensembles are valid, but schema versions, tempo, and oversized voice collections are rejected', () => {
  assert.deepEqual(normalizeLivingEnsemble({ v: 1, tempo: 100, voices: [] }), { v: 1, tempo: 100, voices: [] });
  const valid = savedEnsemble();
  for (const invalid of [null, [], {}, { ...valid, v: 0 }, { ...valid, v: 2 }, { ...valid, v: '1' },
    { ...valid, tempo: 80 }, { ...valid, tempo: '100' }, { ...valid, tempo: NaN },
    { ...valid, voices: null }, { ...valid, voices: [...valid.voices, valid.voices[0]] }]) {
    assert.throws(() => normalizeLivingEnsemble(invalid), RangeError);
  }
});

test('invalid persisted voice metadata rejects the entire work rather than shortening or changing it', () => {
  const valid = savedEnsemble();
  const changes = [
    voice => { voice.id = ''; }, voice => { voice.id = 8; }, voice => { voice.id = 'a'.repeat(101); },
    voice => { voice.durationMs = -1; }, voice => { voice.durationMs = NaN; },
    voice => { voice.durationMs = Infinity; }, voice => { voice.durationMs = 4800.01; },
    voice => { voice.loopBeats = 8; }, voice => { voice.loopBeats = 2; },
    voice => { voice.offsetBeat = -0.1; }, voice => { voice.offsetBeat = 8; },
    voice => { voice.offsetBeat = NaN; }, voice => { voice.offsetBeat = Infinity; },
    voice => { voice.muted = 'false'; }, voice => { delete voice.muted; },
    voice => { voice.points = []; }, voice => { delete voice.points; },
    voice => { voice.points = Array.from({ length: 65 }, () => ({ ...voice.points[0] })); },
  ];
  for (const change of changes) {
    const invalid = structuredClone(valid); change(invalid.voices[0]);
    const before = structuredClone(invalid);
    assert.throws(() => normalizeLivingEnsemble(invalid), RangeError);
    assert.deepEqual(invalid, before);
  }
  const duplicate = structuredClone(valid); duplicate.voices[1].id = duplicate.voices[0].id;
  assert.throws(() => normalizeLivingEnsemble(duplicate), RangeError);
  const longMismatch = structuredClone(valid); longMismatch.voices[1].loopBeats = 4;
  assert.throws(() => normalizeLivingEnsemble(longMismatch), RangeError);
});

test('bad saved point numbers, kinds, timing order, and colors cannot silently clamp, sort, or disappear', () => {
  const invalidFields = {
    tMs: [-1, NaN, Infinity, 1800, 2400], x: [-0.01, 1.01, NaN], y: [-0.01, 1.01, Infinity],
    note: [-1, 128, 60.5, NaN], vel: [0, 128, 50.5, NaN], dur: [0, -1, 0.001, 2.01, Infinity],
    kind: ['unknown', '__proto__', null],
    color: ['', '#zzzzzz', 'url(bad)', 'rgb( )', 'rgb(deg)', 'rgb(300, 0, 0)', 'rgba(1, 2, 3, 2)', 'hsl(30, 20, 20)'],
  };
  for (const [field, values] of Object.entries(invalidFields)) for (const value of values) {
    const invalid = savedEnsemble(); invalid.voices[0].points[0][field] = value;
    assert.throws(() => normalizeLivingEnsemble(invalid), RangeError, `${field}=${value}`);
  }
  for (const reorder of [points => points.reverse(), points => { points[1].tMs = points[0].tMs; },
    points => { delete points[0].tMs; }, points => { points[0] = null; }]) {
    const invalid = savedEnsemble(); reorder(invalid.voices[0].points);
    assert.throws(() => normalizeLivingEnsemble(invalid), RangeError);
  }
  const seam = { v: 1, tempo: 100, voices: [createLivingVoice([sample(0), sample(2399)], { id: 'seam', durationMs: 2400 })] };
  seam.voices[0].points[1].tMs = 2400;
  assert.throws(() => normalizeLivingEnsemble(seam), RangeError);
});

test('the maximum canonical recording and supported pigment colors restore without resampling', () => {
  const colors = ['#123', '#1234', '#123456', '#12345678', 'rgb(255, 0, 127)', 'rgba(1, 2, 3, 0.5)',
    'rgb(0% 50% 100% / 80%)', 'hsl(120 50% 50%)', 'hsla(120deg, 50%, 50%, 0.5)'];
  const points = Array.from({ length: 64 }, (_, i) => sample(i * 75, { color: colors[i % colors.length] }));
  const voice = createLivingVoice(points, { id: 'maximum', durationMs: 4800 });
  const restored = normalizeLivingEnsemble({ v: 1, tempo: 100, voices: [voice] });
  assert.equal(restored.voices[0].points.length, 64);
  assert.deepEqual(restored.voices[0], voice);
  assert.deepEqual(restored.voices[0].points.map(point => point.color), points.map(point => point.color));
});
