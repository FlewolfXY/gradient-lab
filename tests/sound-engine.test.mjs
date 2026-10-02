import assert from 'node:assert/strict';
import test from 'node:test';

// Model Tone's scheduling/ready boundaries, so slow fetches and out-of-order
// preset completion are deterministic instead of relying on network timing.
let pendingRooms = null;
let sampleFailure = false;
let synths = [];
let drawQueue = [];
const transport = {
  state: 'stopped', seconds: 0, bpm: { value: 80 },
  start() { this.state = 'started'; },
  pause() { this.state = 'paused'; },
  stop() { this.state = 'stopped'; },
};
class Node {
  constructor() {
    this.volume = { value: 0 };
    this.gain = { value: 1, rampTo(value) { this.value = value; } };
    this.releases = 0;
    synths.push(this);
  }
  connect() { return this; }
  chain() { return this; }
  start() { return this; }
  toDestination() { return this; }
  dispose() { this.disposed = true; }
  releaseAll() { this.releases++; }
  triggerAttackRelease() { this.attacks = (this.attacks || 0) + 1; }
}
class MonoSynth extends Node {
  triggerAttackRelease(note, duration, time) {
    if (this.lastAttack !== undefined && time <= this.lastAttack + 1e-6) {
      throw new Error('Start time must be strictly greater than previous start time');
    }
    this.lastAttack = time;
    super.triggerAttackRelease(note, duration, time);
  }
}
class PolySynth extends Node {
  constructor(Voice = Node, options = {}) {
    super(); this.Voice = Voice; this.options = options;
    this.maxPolyphony = 32; this.voices = [];
  }
  triggerAttackRelease(note, duration, time, velocity) {
    if (this.voices.length >= this.maxPolyphony) return;
    const voice = new this.Voice();
    voice.triggerAttackRelease(note, duration, time, velocity);
    this.voices.push(voice);
    super.triggerAttackRelease(note, duration, time, velocity);
  }
}
class Gain extends Node {
  constructor(value) { super(); this.gain.value = value; }
}
class Reverb extends Node {
  constructor() {
    super();
    this.ready = pendingRooms ? new Promise(resolve => pendingRooms.push(resolve)) : Promise.resolve();
  }
}
class Sampler extends Node {
  constructor(options) {
    super();
    queueMicrotask(() => sampleFailure ? options.onerror(new Error('sample unavailable')) : options.onload());
  }
}
class Part extends Node {
  constructor(callback, events) { super(); this.callback = callback; this.events = events; }
}
globalThis.Tone = {
  Gain, Reverb, Sampler, Part,
  Limiter: Node, PingPongDelay: Node, PolySynth, FMSynth: Node,
  Synth: Node, Filter: Node, MonoSynth, Chorus: Node, AMSynth: Node, FeedbackDelay: Node,
  start: async () => {}, now: () => 0,
  getTransport: () => transport,
  getDraw: () => ({ schedule(callback) { drawQueue.push(callback); } }),
  Frequency: note => ({ toNote: () => `note-${note}` }),
};
const { Engine } = await import('../docs/sound.js');
const score = () => ({
  tempo: 90, bars: 4,
  tracks: { melody: [[0, 1, 60, 90, [0, 0]]], chords: [[0, 4, 48, 75, [0, 0]]], bass: [[0, 4, 36, 90, [0, 0]]] },
});
function reset() {
  transport.state = 'stopped'; transport.seconds = 0;
  pendingRooms = null; sampleFailure = false; synths = []; drawQueue = [];
}

test('latest preset wins even when earlier sample/effect loads complete last', async () => {
  reset();
  const engine = new Engine();
  engine.load(score());
  pendingRooms = [];
  const first = engine.setPreset('piano');
  const second = engine.setPreset('ice');
  pendingRooms[1]();
  await second;
  assert.equal(engine.presetName, 'ice');
  const current = engine.preset;
  pendingRooms[0]();
  await first;
  assert.equal(engine.preset, current);
  assert.equal(engine.parts.length, 3);
});

test('switching sound preserves playback intent and position across rapid switches', async () => {
  reset();
  const engine = new Engine();
  engine.load(score()); await engine.setPreset('ice'); engine.play(7);
  pendingRooms = [];
  const first = engine.setPreset('forest');
  const second = engine.setPreset('machine');
  pendingRooms[1](); await second;
  assert.equal(engine.playing, true);
  assert.equal(engine.beat, 7);
  pendingRooms[0](); await first;
  assert.equal(engine.presetName, 'machine');
  assert.equal(engine.playing, true);
});

test('stop during a pending preset prevents surprise autoplay', async () => {
  reset();
  const engine = new Engine();
  engine.load(score()); await engine.setPreset('ice'); engine.play(5);
  pendingRooms = [];
  const loading = engine.setPreset('machine');
  engine.stop();
  pendingRooms[0](); await loading;
  assert.equal(engine.playing, false);
  assert.equal(engine.beat, 0);
});

test('pause releases sustained voices and rejects queued drawing callbacks', async () => {
  reset();
  const engine = new Engine();
  engine.load(score()); await engine.setPreset('ice'); engine.play(2);
  let notes = 0;
  engine.onNote = () => notes++;
  engine.parts[0].callback(0, engine.parts[0].events[0]);
  const releases = engine.preset.melody.releases;
  engine.pause();
  drawQueue.forEach(callback => callback());
  assert.equal(engine.playing, false);
  assert.ok(Math.abs(engine.beat - 2) < 1e-9);
  assert.equal(engine.preset.melody.releases, releases + 1);
  assert.equal(notes, 0);
  assert.equal(engine.output.gain.value, 0);
});

test('sample failure degrades to a usable synthesized piano without a global loading wait', async () => {
  reset(); sampleFailure = true;
  const engine = new Engine();
  engine.load(score());
  const notices = [];
  engine.onNotice = notice => notices.push(notice);
  await engine.setPreset('piano');
  engine.play();
  assert.equal(engine.playing, true);
  assert.equal(engine.presetName, 'piano');
  assert.equal(engine.preset.melody instanceof Sampler, false);
  assert.equal(notices.length, 1);
});

test('track switches and volume persist through rerender and preset changes', async () => {
  reset();
  const engine = new Engine();
  engine.setVolume(0.35); engine.setMuted(true);
  engine.setTrackEnabled('chords', false);
  engine.load(score()); await engine.setPreset('ice');
  assert.equal(engine.output.gain.value, 0);
  assert.equal(engine.parts[1].mute, true);
  engine.play();
  engine.setMuted(false);
  assert.equal(engine.output.gain.value, 0.35);
  engine.play(3); engine.load(score());
  assert.equal(engine.playing, true);
  assert.equal(engine.beat, 0);
  await engine.setPreset('machine');
  assert.equal(engine.parts[1].mute, true);
  engine.setVolume(5);
  assert.equal(engine.volume, 1);
  engine.stop();
});


test('all four hand-drawn voices remain available, and stop cancels a pending preview', async () => {
  reset();
  const engine = new Engine();
  engine.load(score()); await engine.setPreset('ice');
  engine.setInks(['spark', 'water', 'mist', 'root'].map((kind, i) => ({
    kind, beat: i, note: 60 + i, dur: 1, vel: 90, x: 0.3, y: 0.5,
  })));
  assert.equal(engine.inkParts.length, 4);
  engine.setTrackEnabled('ink', false);
  assert.ok(engine.inkParts.every(part => part.mute));
  engine.setTrackEnabled('ink', true);
  const preview = engine.triggerInk({ kind: 'spark', note: 70, dur: 1, vel: 100 });
  engine.stop();
  await preview;
  assert.equal(engine.inkRack.synths.spark.attacks, undefined);
  assert.equal(engine.output.gain.value, 0);
});


test('same-beat root notes use independent bass voices without MonoSynth restart collisions', async () => {
  reset();
  const engine = new Engine();
  engine.load(score()); await engine.setPreset('ice');
  engine.setInks([36, 40, 43, 48].map(note => ({
    kind: 'root', beat: 2, note, dur: 1.35, vel: 92, x: 0.5, y: 0.5,
  })));
  const root = engine.inkRack.synths.root;
  assert.ok(root instanceof PolySynth);
  assert.equal(root.Voice, MonoSynth);
  assert.equal(root.maxPolyphony, 8);
  const part = engine.inkParts[0];
  assert.doesNotThrow(() => part.events.forEach(event => part.callback(2, event)));
  assert.equal(root.voices.length, 4);
});

test('coalesced pointer previews are throttled per ink while the full score is retained', async () => {
  reset();
  const engine = new Engine();
  engine.load(score()); await engine.setPreset('ice');
  const marks = Array.from({ length: 20 }, (_, i) => ({
    kind: 'root', beat: i / 8, note: 40, dur: 1, vel: 90, x: i / 20, y: 0.5,
  }));
  engine.setInks(marks);
  await Promise.all(marks.map(mark => engine.triggerInk(mark)));
  assert.equal(engine.inkRack.synths.root.attacks, 1);
  assert.equal(engine.inkEvents.length, 20);
  assert.equal(engine.inkParts[0].events.length, 20);
  await engine.triggerInk({ ...marks[0], kind: 'spark' });
  assert.equal(engine.inkRack.synths.spark.attacks, 1);
});
