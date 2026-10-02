/*
 * 声音引擎：Tone.js 实时播放 + "声音 Gradient" 预设。
 * 同一份 MIDI 骨架，一键换一个世界——这是 Procreate 里 Gradient Map 的听觉版。
 */

// Keep the runtime and a compact piano bank on the same origin: no CDN is
// required to hear the first note. Tone interpolates between sampled notes.
const SALAMANDER = new URL('./audio/salamander/', import.meta.url).href;
const PIANO_NOTES = ['A1', 'C2', 'F#2', 'C3', 'F#3', 'C4', 'F#4', 'C5', 'F#5', 'C6', 'F#6', 'C7'];
const SAMPLE_TIMEOUT_MS = 8000;

export const PRESETS = {
  piano: { name: '钢琴', desc: '干净琴音 · 听见线条' },
  ice: { name: '冰蓝透明', desc: '玻璃钟声 · 柔长回响' },
  forest: { name: '潮湿森林', desc: '温暖木质 · 轻柔回声' },
  machine: { name: '冷紫机械', desc: '跳动脉冲 · 电子颗粒' },
};

export const INKS = {
  spark: { name: '星火', color: '#fbbf24', desc: '钟鸣' },
  water: { name: '水纹', color: '#67e8f9', desc: '拨弦' },
  mist: { name: '雾气', color: '#c4b5fd', desc: '长音' },
  root: { name: '根系', color: '#fb7185', desc: '低音' },
};

function pianoSampler(release = 1.2) {
  const urls = {};
  PIANO_NOTES.forEach(n => urls[n] = n.replace('#', 's') + '.mp3');
  let resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  const sampler = new Tone.Sampler({
    urls, release, baseUrl: SALAMANDER, onload: resolve, onerror: reject,
  });
  sampler.sampleReady = ready;
  return sampler;
}

function pianoFallback(release = 1.2) {
  return new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 1, modulationIndex: 1.2,
    oscillator: { type: 'sine' }, modulation: { type: 'sine' },
    envelope: { attack: 0.003, decay: 0.7, sustain: 0.12, release },
    modulationEnvelope: { attack: 0.002, decay: 0.3, sustain: 0.05, release: 0.5 },
  });
}

// Shared with offline export so saved audio uses the same instruments/effects.
export function buildPreset(name, useSamples = true) {
  const makePiano = useSamples ? pianoSampler : pianoFallback;
  const bus = new Tone.Gain(1);
  const nodes = [bus];
  let melody, chords, bass, reverb;

  if (name === 'ice') {
    reverb = new Tone.Reverb({ decay: 7, wet: 0.55, preDelay: 0.03 });
    const delay = new Tone.PingPongDelay({ delayTime: '8n.', feedback: 0.3, wet: 0.22 });
    melody = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01, modulationIndex: 9, volume: -8,
      oscillator: { type: 'sine' }, modulation: { type: 'triangle' },
      envelope: { attack: 0.004, decay: 0.5, sustain: 0.08, release: 2.5 },
      modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0.05, release: 1 },
    });
    chords = new Tone.PolySynth(Tone.Synth, {
      volume: -16, oscillator: { type: 'triangle' },
      envelope: { attack: 0.9, decay: 0.4, sustain: 0.8, release: 3 },
    });
    const padFilter = new Tone.Filter(1400, 'lowpass');
    bass = new Tone.MonoSynth({
      volume: -10, oscillator: { type: 'sine' },
      envelope: { attack: 0.05, decay: 0.5, sustain: 0.6, release: 1.2 },
      filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 1, baseFrequency: 120, octaves: 2 },
    });
    melody.chain(delay, reverb, bus);
    chords.chain(padFilter, reverb, bus);
    bass.chain(reverb, bus);
    nodes.push(reverb, delay, padFilter);
  } else if (name === 'forest') {
    reverb = new Tone.Reverb({ decay: 3.2, wet: 0.4 });
    const lp = new Tone.Filter(2200, 'lowpass');
    melody = makePiano(1.6); melody.volume.value = -4;
    const chorus = new Tone.Chorus(0.6, 3.5, 0.4).start();
    chords = new Tone.PolySynth(Tone.AMSynth, {
      volume: -18, harmonicity: 1.5,
      oscillator: { type: 'triangle' }, modulation: { type: 'sine' },
      envelope: { attack: 0.7, decay: 0.6, sustain: 0.7, release: 2.2 },
    });
    bass = new Tone.MonoSynth({
      volume: -9, oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.8 },
      filterEnvelope: { attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.6, baseFrequency: 90, octaves: 2.5 },
    });
    melody.chain(lp, reverb, bus);
    chords.chain(chorus, reverb, bus);
    bass.chain(reverb, bus);
    nodes.push(reverb, lp, chorus);
  } else if (name === 'machine') {
    reverb = new Tone.Reverb({ decay: 1.8, wet: 0.25 });
    const delay = new Tone.FeedbackDelay({ delayTime: '16n', feedback: 0.35, wet: 0.25 });
    melody = new Tone.PolySynth(Tone.Synth, {
      volume: -12, oscillator: { type: 'pulse', width: 0.3 },
      envelope: { attack: 0.002, decay: 0.15, sustain: 0.25, release: 0.3 },
    });
    const mf = new Tone.Filter(3200, 'lowpass');
    chords = new Tone.PolySynth(Tone.Synth, {
      volume: -18, oscillator: { type: 'fatsawtooth', count: 3, spread: 18 },
      envelope: { attack: 0.3, decay: 0.3, sustain: 0.7, release: 1.2 },
    });
    const cf = new Tone.Filter(900, 'lowpass');
    bass = new Tone.MonoSynth({
      volume: -8, oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.3, sustain: 0.5, release: 0.4 },
      filterEnvelope: { attack: 0.005, decay: 0.2, sustain: 0.2, release: 0.4, baseFrequency: 80, octaves: 3 },
    });
    melody.chain(mf, delay, reverb, bus);
    chords.chain(cf, reverb, bus);
    bass.chain(bus);
    nodes.push(reverb, delay, mf, cf);
  } else {
    reverb = new Tone.Reverb({ decay: 2.6, wet: 0.28 });
    melody = makePiano(); melody.volume.value = -2;
    chords = makePiano(1.8); chords.volume.value = -9;
    bass = makePiano(1.4); bass.volume.value = -5;
    melody.chain(reverb, bus);
    chords.chain(reverb, bus);
    bass.chain(reverb, bus);
    nodes.push(reverb);
  }
  nodes.push(melody, chords, bass);
  return { melody, chords, bass, bus, nodes,
    ready: Promise.all([reverb.ready, ...[melody, chords, bass].map(s => s.sampleReady)]),
  };
}

export function buildInkRack(bus) {
  const room = new Tone.Reverb({ decay: 4.5, wet: 0.42 });
  const sparkle = new Tone.PingPongDelay({ delayTime: '8n.', feedback: 0.22, wet: 0.18 });
  const waterFilter = new Tone.Filter(3400, 'lowpass');
  const mistFilter = new Tone.Filter(1800, 'lowpass');

  const spark = new Tone.PolySynth(Tone.FMSynth, {
    volume: -9, harmonicity: 4.01, modulationIndex: 10,
    oscillator: { type: 'sine' }, modulation: { type: 'triangle' },
    envelope: { attack: 0.003, decay: 0.55, sustain: 0.04, release: 2.2 },
    modulationEnvelope: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.8 },
  });
  const water = new Tone.PolySynth(Tone.Synth, {
    volume: -11, oscillator: { type: 'triangle' },
    envelope: { attack: 0.006, decay: 0.28, sustain: 0.12, release: 1.1 },
  });
  const mist = new Tone.PolySynth(Tone.AMSynth, {
    volume: -17, harmonicity: 1.25,
    oscillator: { type: 'sine' }, modulation: { type: 'triangle' },
    envelope: { attack: 0.55, decay: 0.5, sustain: 0.72, release: 2.6 },
  });
  // A vertical stroke can place several root notes at the exact same beat.
  // Give each attack its own MonoSynth voice rather than restarting one
  // oscillator at an identical audio time (which Tone correctly rejects).
  const root = new Tone.PolySynth(Tone.MonoSynth, {
    volume: -11, oscillator: { type: 'sine' },
    envelope: { attack: 0.015, decay: 0.45, sustain: 0.55, release: 1.1 },
    filterEnvelope: { attack: 0.01, decay: 0.28, sustain: 0.3, release: 0.8, baseFrequency: 90, octaves: 2.2 },
  });

  root.maxPolyphony = 8; // keep layered bass controlled on dense strokes

  spark.chain(sparkle, room, bus);
  water.chain(waterFilter, room, bus);
  mist.chain(mistFilter, room, bus);
  root.chain(room, bus);
  return {
    synths: { spark, water, mist, root },
    nodes: [room, sparkle, waterFilter, mistFilter, spark, water, mist, root],
    ready: room.ready,
  };
}

function disposeNodes(rack) {
  if (rack) rack.nodes.forEach(node => node.dispose());
}

function release(synth) {
  if (synth?.releaseAll) synth.releaseAll();
  else if (synth?.triggerRelease) synth.triggerRelease();
}

function within(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Audio loading timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Engine {
  constructor() {
    this.limiter = null;
    this.output = null;
    this.preset = null;
    this.presetName = null;
    this.parts = [];
    this.inkParts = [];
    this.inkRack = null;
    this.inkEvents = [];
    this.result = null;
    this.onState = () => {};
    this.onNote = () => {};
    this.onInk = () => {};
    this.onNotice = () => {}; // ({ message, kind }) — sample fallback / loading errors
    this._loading = null;
    this._presetRequest = 0;
    this._requestedPreset = null;
    this._pendingPreset = false;
    this._resumeAfterPreset = false;
    this._resumeBeat = 0;
    this._drawGeneration = 0;
    this._volume = 0.8;
    this._muted = false;
    this._outputActive = false;
    this._lastInkPreviewAt = {};
    this.tracks = { melody: true, chords: true, bass: true, ink: true };
  }

  /** Audio context is only resumed by ensureStarted(), inside a user gesture. */
  init() {
    if (this.limiter) return;
    if (typeof Tone === 'undefined') throw new Error('声音引擎未加载，请刷新后重试');
    this.output = new Tone.Gain(0).toDestination();
    this.limiter = new Tone.Limiter(-1).connect(this.output);
  }

  _ensureInkRack() {
    this.init();
    if (!this.inkRack) this.inkRack = buildInkRack(this.limiter);
    return this.inkRack;
  }

  async ensureStarted() {
    this.init();
    await Tone.start();
  }

  setPreset(name) {
    if (!PRESETS[name]) return Promise.reject(new Error('未知音色'));
    if (this._requestedPreset === name && this._loading) return this._loading;
    if (this.presetName === name && this.preset && !this._pendingPreset) return Promise.resolve();
    this.init();
    const request = ++this._presetRequest;
    this._requestedPreset = name;
    // Rapid switches inherit the original intent, not the temporary paused state.
    if (!this._pendingPreset) {
      this._resumeAfterPreset = this.playing;
      this._resumeBeat = this.beat;
    }
    this._pendingPreset = true;
    this._halt(false);
    this._loading = (async () => {
      let candidate;
      try {
        candidate = buildPreset(name);
        try {
          await within(candidate.ready, SAMPLE_TIMEOUT_MS);
        } catch (error) {
          disposeNodes(candidate);
          candidate = null;
          if (request !== this._presetRequest) return;
          if (name !== 'piano' && name !== 'forest') throw error;
          candidate = buildPreset(name, false);
          await within(candidate.ready, SAMPLE_TIMEOUT_MS);
          if (request === this._presetRequest) {
            this.onNotice({ kind: 'info', message: '钢琴采样暂时未能加载，已切换为轻巧的合成琴音，仍可继续创作。' });
          }
        }
        if (request !== this._presetRequest) {
          disposeNodes(candidate);
          return;
        }
        this.parts.forEach(part => part.dispose());
        this.parts = [];
        disposeNodes(this.preset);
        this.preset = candidate;
        this.presetName = name;
        candidate.bus.connect(this.limiter);
        this._pendingPreset = false;
        if (this.result) this.load(this.result, false);
        if (this._resumeAfterPreset) this.play(this._resumeBeat);
        this._resumeAfterPreset = false;
      } catch (error) {
        disposeNodes(candidate);
        if (request !== this._presetRequest) return;
        this._pendingPreset = false;
        this._requestedPreset = null;
        this._loading = null;
        // The old rack is still valid when a new effect fails to initialize.
        if (this._resumeAfterPreset && this.preset) this.play(this._resumeBeat);
        this._resumeAfterPreset = false;
        throw error;
      }
    })();
    return this._loading;
  }

  load(result, resetPosition = true) {
    const wasPlaying = this.playing;
    const pos = resetPosition ? 0 : this.beat;
    this._halt(resetPosition);
    this.parts.forEach(p => p.dispose());
    this.parts = [];
    this.result = result;
    if (resetPosition) this._resumeBeat = 0;
    if (!result || !this.preset || this._pendingPreset) return;
    const T = Tone.getTransport();
    T.bpm.value = result.tempo;
    const spb = 60 / result.tempo;
    const inst = this.preset;
    const draw = Tone.getDraw();
    const mk = (events, synth, gain, kind) => {
      const part = new Tone.Part((time, ev) => {
        if (!this.tracks[kind]) return;
        const note = Tone.Frequency(ev.note, 'midi').toNote();
        synth.triggerAttackRelease(note, ev.dur * spb, time, (ev.vel / 127) * gain);
        const generation = this._drawGeneration;
        draw.schedule(() => {
          if (generation === this._drawGeneration && this.playing) this.onNote(ev, kind);
        }, time);
      }, events.map(([s, d, n, v, position]) => ({ time: s * spb, note: n, dur: d, vel: v, pos: position })));
      part.mute = !this.tracks[kind];
      part.loop = true;
      part.loopStart = 0;
      part.loopEnd = result.bars * 4 * spb;
      part.start(0);
      return part;
    };
    this.parts = [
      mk(result.tracks.melody, inst.melody, 1.0, 'melody'),
      mk(result.tracks.chords, inst.chords, 0.9, 'chords'),
      mk(result.tracks.bass, inst.bass, 0.95, 'bass'),
    ];
    T.loop = true;
    T.loopStart = 0;
    T.loopEnd = result.bars * 4 * spb;
    T.seconds = pos * spb;
    this.setInks(this.inkEvents);
    if (wasPlaying) this.play(pos);
  }

  setInks(events) {
    this.inkEvents = events || [];
    this.inkParts.forEach(p => p.dispose());
    this.inkParts = [];
    if (this.inkRack) Object.values(this.inkRack.synths).forEach(release);
    if (!this.result || !this.inkEvents.length) return;
    const rack = this._ensureInkRack();
    const spb = 60 / this.result.tempo;
    const loopEnd = this.result.bars * 4 * spb;
    const draw = Tone.getDraw();
    for (const kind of Object.keys(INKS)) {
      const source = this.inkEvents.filter(e => e.kind === kind);
      if (!source.length) continue;
      const part = new Tone.Part((time, ev) => {
        if (!this.tracks.ink) return;
        const note = Tone.Frequency(ev.note, 'midi').toNote();
        rack.synths[kind].triggerAttackRelease(note, ev.dur * spb, time, ev.vel / 127);
        const generation = this._drawGeneration;
        draw.schedule(() => {
          if (generation === this._drawGeneration && this.playing) this.onInk(ev);
        }, time);
      }, source.map(e => ({
        time: e.beat * spb, id: e.id, note: e.note, dur: e.dur,
        vel: e.vel, kind: e.kind, x: e.x, y: e.y,
      })));
      part.mute = !this.tracks.ink;
      part.loop = true;
      part.loopStart = 0;
      part.loopEnd = loopEnd;
      part.start(0);
      this.inkParts.push(part);
    }
  }

  async triggerInk(mark) {
    if (!this.tracks.ink || !INKS[mark.kind]) return;
    const generation = this._drawGeneration;
    await this.ensureStarted();
    const rack = this._ensureInkRack();
    await rack.ready;
    if (generation !== this._drawGeneration || !this.tracks.ink) return;
    const time = Tone.now();
    // Coalesced pointer events may all resume in the same microtask batch.
    // Preview at most 25 notes/sec per ink; all marks remain in the score.
    if (time - (this._lastInkPreviewAt[mark.kind] ?? -Infinity) < 0.04) return;
    this._lastInkPreviewAt[mark.kind] = time;
    this._outputActive = true;
    this._updateOutput();
    const note = Tone.Frequency(mark.note, 'midi').toNote();
    const seconds = Math.max(0.12, mark.dur * 60 / (this.result?.tempo || 80));
    rack.synths[mark.kind].triggerAttackRelease(note, seconds, time, mark.vel / 127);
  }

  play(fromBeat = null) {
    if (!this.result) return;
    if (this._pendingPreset) {
      this._resumeAfterPreset = true;
      if (fromBeat !== null) this._resumeBeat = fromBeat;
      return;
    }
    if (!this.preset) return;
    const T = Tone.getTransport();
    if (fromBeat !== null) T.seconds = fromBeat * 60 / this.result.tempo;
    this._outputActive = true;
    this._updateOutput();
    T.start();
    this.onState(true);
  }

  pause() {
    this._resumeAfterPreset = false;
    this._halt(false);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  _halt(reset) {
    if (!this.limiter) return;
    const T = Tone.getTransport();
    if (reset) { T.stop(); T.seconds = 0; }
    else T.pause();
    ++this._drawGeneration;
    // Silence effect tails as well as held notes; previewing a new ink or
    // pressing play reopens this short fade without a click.
    this._outputActive = false;
    this._updateOutput();
    if (this.preset) [this.preset.melody, this.preset.chords, this.preset.bass].forEach(release);
    if (this.inkRack) Object.values(this.inkRack.synths).forEach(release);
    this.onState(false);
  }

  stop() {
    this._resumeAfterPreset = false;
    this._resumeBeat = 0;
    this._halt(true);
  }

  setVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    this._volume = Math.max(0, Math.min(1, number));
    this._updateOutput();
  }

  setMuted(muted) {
    this._muted = Boolean(muted);
    this._updateOutput();
  }

  _updateOutput() {
    if (this.output) this.output.gain.rampTo(this._muted || !this._outputActive ? 0 : this._volume, 0.04);
  }

  setTrackEnabled(kind, enabled) {
    if (!(kind in this.tracks)) return;
    this.tracks[kind] = Boolean(enabled);
    if (kind === 'ink') {
      this.inkParts.forEach(p => { p.mute = !enabled; });
      if (!enabled && this.inkRack) Object.values(this.inkRack.synths).forEach(release);
    } else {
      const index = ['melody', 'chords', 'bass'].indexOf(kind);
      if (this.parts[index]) this.parts[index].mute = !enabled;
      if (!enabled && this.preset) release(this.preset[kind]);
    }
  }

  get volume() { return this._volume; }
  get muted() { return this._muted; }
  get ready() { return this._loading || Promise.resolve(); }
  get playing() { return this.limiter ? Tone.getTransport().state === 'started' : false; }
  get beat() {
    if (!this.result || !this.limiter) return 0;
    return Tone.getTransport().seconds / 60 * this.result.tempo;
  }
}
