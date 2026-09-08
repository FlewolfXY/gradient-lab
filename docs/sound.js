/*
 * 声音引擎：Tone.js 实时播放 + "声音 Gradient" 预设。
 * 同一份 MIDI 骨架，一键换一个世界——这是 Procreate 里 Gradient Map 的听觉版。
 */

const SALAMANDER = 'https://tonejs.github.io/audio/salamander/';
const PIANO_NOTES = ['A1', 'C2', 'D#2', 'F#2', 'A2', 'C3', 'D#3', 'F#3', 'A3',
  'C4', 'D#4', 'F#4', 'A4', 'C5', 'D#5', 'F#5', 'A5', 'C6', 'D#6', 'F#6', 'A6', 'C7'];

export const PRESETS = {
  piano: { name: '钢琴', desc: '真钢琴采样，看清骨架' },
  ice: { name: '冰蓝透明', desc: '钟鸣 · 玻璃 pad · 长混响' },
  forest: { name: '潮湿森林', desc: '闷钢琴 · 木质 pad · 短混响' },
  machine: { name: '冷紫机械', desc: '方波脉冲 · 合成低音 · 延迟' },
};

function pianoSampler(release = 1.2) {
  const urls = {};
  PIANO_NOTES.forEach(n => urls[n] = n.replace('#', 's') + '.mp3');
  return new Tone.Sampler({ urls, release, baseUrl: SALAMANDER });
}

function buildPreset(name) {
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
    melody = pianoSampler(1.6); melody.volume.value = -4;
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
    melody = pianoSampler(); melody.volume.value = -2;
    chords = pianoSampler(1.8); chords.volume.value = -9;
    bass = pianoSampler(1.4); bass.volume.value = -5;
    melody.chain(reverb, bus);
    chords.chain(reverb, bus);
    bass.chain(reverb, bus);
    nodes.push(reverb);
  }
  nodes.push(melody, chords, bass);
  return { melody, chords, bass, bus, nodes, ready: Promise.all([reverb.ready, Tone.loaded()]) };
}

export class Engine {
  constructor() {
    this.limiter = null;
    this.preset = null;
    this.presetName = null;
    this.parts = [];
    this.result = null;
    this.onEnd = () => {};
    this.onState = () => {};
    this._endId = null;
  }

  async ensureStarted() {
    await Tone.start();
    if (!this.limiter) {
      this.limiter = new Tone.Limiter(-1).toDestination();
      Tone.getDestination().volume.value = -2;
    }
  }

  async setPreset(name) {
    if (this.presetName === name && this.preset) return;
    const wasPlaying = this.playing;
    const pos = this.beat;
    this.stop();
    if (this.preset) this.preset.nodes.forEach(n => n.dispose());
    this.preset = buildPreset(name);
    this.presetName = name;
    this.preset.bus.connect(this.limiter);
    await this.preset.ready;
    if (this.result) this.load(this.result, false);
    if (wasPlaying) this.play(pos);
  }

  load(result, resetPosition = true) {
    const wasPlaying = this.playing;
    const pos = resetPosition ? 0 : this.beat;
    this.stop();
    this.parts.forEach(p => p.dispose());
    this.parts = [];
    const T = Tone.getTransport();
    if (this._endId !== null) { T.clear(this._endId); this._endId = null; }
    this.result = result;
    if (!this.preset) return;
    T.bpm.value = result.tempo;
    const spb = 60 / result.tempo;
    const inst = this.preset;
    const mk = (events, synth, gain) => {
      const part = new Tone.Part((time, ev) => {
        const note = Tone.Frequency(ev.note, 'midi').toNote();
        synth.triggerAttackRelease(note, ev.dur * spb, time, (ev.vel / 127) * gain);
      }, events.map(([s, d, n, v]) => ({ time: s * spb, note: n, dur: d, vel: v })));
      part.start(0);
      return part;
    };
    this.parts = [
      mk(result.tracks.melody, inst.melody, 1.0),
      mk(result.tracks.chords, inst.chords, 0.9),
      mk(result.tracks.bass, inst.bass, 0.95),
    ];
    const endSec = result.bars * 4 * spb + 1.5;
    this._endId = T.scheduleOnce(() => { this.stop(); this.onEnd(); }, endSec);
    if (wasPlaying) this.play(pos);
  }

  play(fromBeat = null) {
    if (!this.result || !this.preset) return;
    const T = Tone.getTransport();
    if (fromBeat !== null) T.seconds = fromBeat * 60 / this.result.tempo;
    T.start();
    this.onState(true);
  }

  pause() { Tone.getTransport().pause(); this.onState(false); }

  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    const T = Tone.getTransport();
    T.stop(); T.seconds = 0;
    if (this.preset) {
      for (const s of [this.preset.melody, this.preset.chords, this.preset.bass]) {
        if (s.releaseAll) s.releaseAll();
        else if (s.triggerRelease) s.triggerRelease();
      }
    }
    this.onState(false);
  }

  get playing() { return Tone.getTransport().state === 'started'; }
  get beat() {
    if (!this.result) return 0;
    return Tone.getTransport().seconds / 60 * this.result.tempo;
  }
}
