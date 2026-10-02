/* Save the actual studio instruments as a portable, uncompressed stereo WAV. */
import { buildPreset, buildInkRack, PRESETS, INKS } from './sound.js?v=20261003-1';

const SAMPLE_RATE = 44100;
const MAX_SECONDS = 180;
const MAX_EVENTS = 24000;
let exporting = false;

/** Pure scheduling plan: bounded, sorted events in seconds, independent of Tone. */
export function planAudioExport(result, inkEvents = [], seconds = null) {
  const tempo = Number(result?.tempo), bars = Number(result?.bars);
  if (!Number.isFinite(tempo) || tempo < 30 || tempo > 300 || !Number.isInteger(bars) || bars < 1 || bars > 64) {
    throw new Error('乐谱还没有准备好，请先选择一幅画。');
  }
  if (seconds !== null && seconds !== 20 && seconds !== 30) throw new Error('请选择 20 秒、30 秒或完整一遍。');
  const spb = 60 / tempo, loopDuration = bars * 4 * spb;
  const musicDuration = seconds ?? loopDuration;
  const duration = seconds ?? loopDuration + 8;
  if (duration > MAX_SECONDS) throw new Error('这首小曲较长，请先导出 20 秒或 30 秒片段。');
  const source = [];
  const add = (track, beat, length, note, velocity, gain = 1) => {
    if (![beat, length, note, velocity].every(Number.isFinite)) return;
    if (beat < 0 || beat >= bars * 4 || length <= 0 || note < 0 || note > 127 || velocity <= 0) return;
    source.push({ track, time: beat * spb, duration: length * spb, note: Math.round(note), velocity: Math.min(127, velocity) / 127 * gain });
    if (source.length > MAX_EVENTS) throw new Error('笔迹太密了，请减少一些笔迹后再导出。');
  };
  for (const [track, gain] of [['melody', 1], ['chords', 0.9], ['bass', 0.95]]) {
    for (const event of result.tracks?.[track] || []) {
      if (Array.isArray(event)) add(track, ...event.slice(0, 4), gain);
    }
  }
  for (const event of inkEvents || []) {
    if (event && Object.hasOwn(INKS, event.kind)) add(event.kind, event.beat, event.dur, event.note, event.vel);
  }
  const events = [];
  for (let offset = 0; offset < musicDuration; offset += loopDuration) {
    for (const event of source) {
      const time = offset + event.time;
      if (time >= musicDuration) continue;
      events.push({ ...event, time, duration: Math.min(event.duration, musicDuration - time) });
      if (events.length > MAX_EVENTS) throw new Error('笔迹太密了，请减少一些笔迹后再导出。');
    }
  }
  if (!events.length) throw new Error('这幅画还没有可导出的音符。');
  events.sort((a, b) => a.time - b.time);
  return { events, tempo, duration, musicDuration, fadeOut: seconds === null ? 0.5 : 0.8 };
}

/** 16-bit little-endian PCM; never mutates the source audio channels. */
export function encodeWav(buffer, { fadeIn = 0.008, fadeOut = 0.5 } = {}) {
  const channels = buffer?.numberOfChannels, frames = buffer?.length, rate = buffer?.sampleRate;
  if (!Number.isInteger(channels) || channels < 1 || channels > 2 || !Number.isInteger(frames) || frames < 1 ||
      !Number.isInteger(rate) || rate < 8000 || rate > 96000 || frames / rate > MAX_SECONDS) {
    throw new Error('声音文件格式无效，请重试。');
  }
  const dataSize = frames * channels * 2;
  const output = new ArrayBuffer(44 + dataSize), view = new DataView(output);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, dataSize, true);
  const samples = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  if (samples.some(channel => channel.length < frames)) throw new Error('声音文件不完整，请重试。');
  const fadeInFrames = Math.max(0, Math.min(frames / 2, Math.round((Number(fadeIn) || 0) * rate)));
  const fadeOutFrames = Math.max(0, Math.min(frames / 2, Math.round((Number(fadeOut) || 0) * rate)));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    const envelope = Math.min(1, fadeInFrames ? frame / fadeInFrames : 1,
      fadeOutFrames ? (frames - 1 - frame) / fadeOutFrames : 1);
    for (let channel = 0; channel < channels; channel++, offset += 2) {
      const raw = Number(samples[channel][frame]);
      const value = Math.max(-1, Math.min(1, Number.isFinite(raw) ? raw * envelope : 0));
      view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

function within(promise, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('声音加载超时，请重试。')), ms);
  })]).finally(() => clearTimeout(timer));
}

function dispose(rack) {
  for (const node of rack?.nodes || []) { try { node.dispose(); } catch { /* continue releasing the other nodes */ } }
}

/**
 * Caller must stop playback, await engine.ready, and disable audio interaction
 * until this promise settles. Tone.Offline temporarily changes Tone's context.
 * Mixer mute/volume are intentionally ignored: exports contain the full score.
 */
export async function renderWav(result, inkEvents, presetName, { seconds = null, onProgress = () => {} } = {}) {
  if (exporting) throw new Error('上一份声音还在制作中，请稍等。');
  if (!Object.hasOwn(PRESETS, presetName)) throw new Error('请选择一种音色。');
  if (!globalThis.Tone?.Offline) throw new Error('声音引擎还没有加载，请刷新后重试。');
  const plan = planAudioExport(result, inkEvents, seconds);
  const originalContext = Tone.getContext();
  let preset, ink, limiter, gain, offlineContext, rendered;
  let sampleFallback = false;
  const warnings = [];
  const report = (stage, message) => { try { onProgress({ stage, message }); } catch { /* progress UI cannot interrupt rendering */ } };
  exporting = true;
  try {
    report('preparing', '正在准备这首小曲的声音…');
    rendered = await Tone.Offline(async context => {
      offlineContext = context;
      context.transport.bpm.value = plan.tempo;
      gain = new Tone.Gain(0.8).toDestination();
      limiter = new Tone.Limiter(-1).connect(gain);
      preset = buildPreset(presetName);
      try { await within(preset.ready); }
      catch (error) {
        dispose(preset); preset = null;
        if (presetName !== 'piano' && presetName !== 'forest') throw error;
        preset = buildPreset(presetName, false);
        await within(preset.ready);
        sampleFallback = true;
        warnings.push('钢琴采样未能加载，这份音频使用合成琴音。');
        report('fallback', warnings[0]);
      }
      preset.bus.connect(limiter);
      if (plan.events.some(event => Object.hasOwn(INKS, event.track))) {
        ink = buildInkRack(limiter);
        await within(ink.ready);
      }
      for (const event of plan.events) {
        const synth = Object.hasOwn(INKS, event.track) ? ink.synths[event.track] : preset[event.track];
        // Schedule through the offline clock, so PolySynth allocates/recycles
        // voices at each note rather than allocating the whole song at once.
        context.transport.schedule(time => {
          synth.triggerAttackRelease(Tone.Frequency(event.note, 'midi').toNote(), event.duration, time, event.velocity);
        }, event.time);
      }
      context.transport.start(0);
      report('rendering', '正在把画里的声音收进文件…');
    }, plan.duration, 2, SAMPLE_RATE);
    report('encoding', '正在装好可以带走的 WAV…');
    const nativeBuffer = typeof rendered.get === 'function' ? rendered.get() : rendered;
    const blob = encodeWav(nativeBuffer, { fadeOut: plan.fadeOut });
    report('done', '声音已经准备好了。');
    return { blob, duration: plan.duration, musicDuration: plan.musicDuration, presetName, sampleFallback, warnings };
  } finally {
    // Tone 15's Offline() does not restore the global context if its callback
    // rejects; explicitly restore it on success AND every failure path.
    Tone.setContext(originalContext);
    dispose(ink); dispose(preset);
    try { limiter?.dispose(); } catch { /* cleanup */ }
    try { gain?.dispose(); } catch { /* cleanup */ }
    try { rendered?.dispose?.(); } catch { /* cleanup */ }
    try { offlineContext?.dispose?.(); } catch { /* cleanup */ }
    exporting = false;
  }
}
