/*
 * Color companions: the gesture is the score. No random seed, pixel-to-time
 * scan, or playback clock lives here; the same timed events drive sound and
 * animation. All durations/positions below are beats, except explicit tMs.
 */
export const LIVE_TEMPO = 100;
export const LIVE_BEATS = 8;
const MAX_POINTS = 64;
const MAX_VOICES = 3;
const MAX_GESTURE_MS = 4800;
const KINDS = ['spark', 'water', 'mist', 'root'];
const COLORS = { spark: '#fbbf24', water: '#67e8f9', mist: '#c4b5fd', root: '#fb7185' };
const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const unit = value => clamp(finite(value, 0.5), 0, 1);
const modulo = (value, size) => { const remainder = value % size; return remainder < 0 ? remainder + size : remainder; };
const TIME_EPSILON = 1e-9;

function validAnalysis(analysis) {
  const { w, h, H, S, V } = analysis || {};
  const size = w * h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || size > 460800 ||
      !H || !S || !V || H.length < size || S.length < size || V.length < size) {
    throw new RangeError('图片颜色还没有准备好');
  }
}

/** A centre-weighted 3×3 patch of the actual traversed image, not its palette. */
function samplePatch(analysis, x, y) {
  validAnalysis(analysis);
  const { w, h, H, S, V } = analysis;
  const cx = Math.round(unit(x) * (w - 1)), cy = Math.round(unit(y) * (h - 1));
  let cosine = 0, sine = 0, saturation = 0, brightness = 0, total = 0;
  for (let py = Math.max(0, cy - 1); py <= Math.min(h - 1, cy + 1); py++) {
    for (let px = Math.max(0, cx - 1); px <= Math.min(w - 1, cx + 1); px++) {
      const i = py * w + px;
      if (![H[i], S[i], V[i]].every(Number.isFinite)) continue;
      const weight = (px === cx ? 2 : 1) * (py === cy ? 2 : 1);
      const sat = clamp(S[i], 0, 1), value = clamp(V[i], 0, 1);
      // Grey pixels do not invent a hue; red 359° and red 1° average to red.
      const hueWeight = sat * value * weight, angle = modulo(H[i], 360) * Math.PI / 180;
      cosine += Math.cos(angle) * hueWeight;
      sine += Math.sin(angle) * hueWeight;
      saturation += sat * weight;
      brightness += value * weight;
      total += weight;
    }
  }
  if (!total) throw new RangeError('这块图片没有可读取的颜色');
  return { hue: modulo(Math.atan2(sine, cosine) * 180 / Math.PI, 360),
    sat: saturation / total, val: brightness / total };
}

function patchColor({ hue, sat, val }) {
  const chroma = val * sat, secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const groups = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]];
  const rgb = groups[Math.min(5, Math.floor(hue / 60))].map(channel => Math.round((channel + val - chroma) * 255));
  return `rgb(${rgb.join(', ')})`;
}

function keyOf(result) {
  let tonic = result?.global?.tonicPc;
  if (!Number.isFinite(tonic)) {
    const named = typeof result?.tonic === 'string' ? result.tonic : result?.key?.split?.(' ')[0];
    tonic = Math.max(0, PITCH_NAMES.indexOf(named));
  }
  return { tonic: modulo(Math.round(tonic), 12),
    scale: (result?.mode || result?.global?.mode) === 'minor' ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9] };
}

/**
 * Warm pigment rings, green/dark pigment grounds, cyan/blue plucks, and
 * desaturated/purple pigment breathes. Brightness raises the register; all
 * voices use the artwork's one pentatonic key so overlapping paths agree.
 * Returned CSS color is the sampled pigment, not the instrument's UI swatch.
 */
export function sampleLivingNote(analysis, baseResult, x, y) {
  const patch = samplePatch(analysis, x, y), { hue, sat, val } = patch;
  const kind = val < 0.22 ? 'root' : sat < 0.2 ? 'mist'
    : hue < 75 || hue >= 335 ? 'spark' : hue < 165 ? 'root' : hue < 255 ? 'water' : 'mist';
  const { tonic, scale } = keyOf(baseResult);
  const [lo, hi] = kind === 'root' ? [36, 60] : kind === 'spark' ? [55, 86] : [48, 81];
  const target = clamp(lo + (hi - lo) * val + (hue / 360 - 0.5) * 4, lo, hi);
  let note = lo, distance = Infinity;
  for (let pitch = lo; pitch <= hi; pitch++) {
    if (!scale.includes(modulo(pitch - tonic, 12))) continue;
    const next = Math.abs(pitch - target);
    if (next < distance) { note = pitch; distance = next; }
  }
  return { kind, note, vel: Math.round(clamp(44 + sat * 31 + val * 24, 40, 104)),
    dur: { spark: 0.4, water: 0.5, mist: 0.9, root: 0.55 }[kind], color: patchColor(patch) };
}

function validColor(color) {
  if (typeof color !== 'string' || color.length > 80) return false;
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return true;
  const match = /^(rgb|rgba|hsl|hsla)\(\s*(.*?)\s*\)$/i.exec(color);
  if (!match) return false;
  const body = match[2];
  let channels;
  if (body.includes(',')) channels = body.split(',').map(value => value.trim());
  else {
    const sections = body.split('/');
    if (sections.length > 2) return false;
    channels = sections[0].trim().split(/\s+/);
    if (channels.length !== 3) return false;
    if (sections.length === 2) channels.push(sections[1].trim());
  }
  if (channels.length < 3 || channels.length > 4) return false;
  const values = channels.map(channel => /^([+-]?(?:\d+\.?\d*|\.\d+))(%|deg)?$/i.exec(channel));
  if (values.some(value => !value || !Number.isFinite(Number(value[1])))) return false;
  const inRange = (index, max, requiredUnit) => {
    const value = values[index];
    return (requiredUnit === undefined ? !value[2] || value[2] === '%' : value[2] === requiredUnit) &&
      Number(value[1]) >= 0 && Number(value[1]) <= (value[2] === '%' ? 100 : max);
  };
  if (match[1].toLowerCase().startsWith('hsl')) {
    if ((values[0][2] && values[0][2].toLowerCase() !== 'deg') || !inRange(1, 100, '%') || !inRange(2, 100, '%')) return false;
  } else if (![0, 1, 2].every(index => inRange(index, 255))) return false;
  return values.length === 3 || inRange(3, 1);
}

function safeColor(color, kind) { return validColor(color) ? color : COLORS[kind]; }

function voiceId(id) {
  return typeof id === 'string' && id.trim() ? id.slice(0, 100) : Number.isFinite(id) ? String(id) : 'living';
}

function cleanNote(value) {
  if (!value || !KINDS.includes(value.kind) || ![value.note, value.vel, value.dur].every(Number.isFinite) ||
      value.vel <= 0 || value.dur <= 0) return null;
  return { kind: value.kind, note: Math.round(clamp(value.note, 0, 127)),
    vel: Math.round(clamp(value.vel, 1, 127)), dur: clamp(value.dur, 0.01, 2),
    x: unit(value.x), y: unit(value.y), color: safeColor(value.color, value.kind) };
}

// Uniformly retain endpoints and the entire recorded span. Never rewrite time.
function bounded(points) {
  if (points.length <= MAX_POINTS) return points;
  return Array.from({ length: MAX_POINTS }, (_, i) => points[Math.round(i * (points.length - 1) / (MAX_POINTS - 1))]);
}

/**
 * tMs is elapsed time since pointer-down, not an absolute performance timestamp.
 * No quantization and no stretching: a 1-second gesture stays 1 second long.
 * Short gestures use 4 beats, longer ones 8; silence pads the remaining loop.
 * A tap still has its note envelope. offsetBeat may be set at release by the UI.
 */
export function createLivingVoice(samples, { id, tempo = LIVE_TEMPO, durationMs } = {}) {
  const bpm = clamp(finite(tempo, LIVE_TEMPO), 30, 300), msPerBeat = 60000 / bpm;
  const maxMs = Math.min(MAX_GESTURE_MS, LIVE_BEATS * msPerBeat);
  const suppliedDuration = Number.isFinite(durationMs) && durationMs >= 0 ? Math.min(durationMs, maxMs) : null;
  const normalized = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    const note = cleanNote(sample);
    if (!note || !Number.isFinite(sample.tMs)) continue;
    const tMs = Math.max(0, sample.tMs);
    if (tMs >= maxMs || (suppliedDuration !== null && tMs > suppliedDuration)) continue;
    normalized.push({ ...note, tMs });
  }
  normalized.sort((a, b) => a.tMs - b.tMs);
  // Several pointer notifications for the same instant are one attack; use the
  // latest position at that time. This also prevents accidental chord bursts.
  const distinct = normalized.filter((point, index) => index === normalized.length - 1 || point.tMs !== normalized[index + 1].tMs);
  const endMs = suppliedDuration ?? distinct.at(-1)?.tMs ?? 0;
  const loopBeats = endMs <= 4 * msPerBeat ? 4 : LIVE_BEATS;
  const points = bounded(distinct.filter(point => point.tMs / msPerBeat < loopBeats))
    .map(point => ({ ...point, beat: point.tMs / msPerBeat,
      dur: Math.min(point.dur, loopBeats - point.tMs / msPerBeat) }));
  const identity = voiceId(id);
  const events = points.map((point, index) => ({ id: `${identity}:n${index}`, beat: point.beat,
    dur: point.dur, note: point.note, vel: point.vel, kind: point.kind, x: point.x, y: point.y, color: point.color }));
  return { id: identity, points, events, loopBeats, muted: false, color: points[0]?.color || COLORS.mist,
    durationBeats: endMs / msPerBeat, durationMs: endMs, offsetBeat: 0 };
}

function loopOf(voice) { return voice?.loopBeats === 4 ? 4 : LIVE_BEATS; }
function offsetOf(voice) { return modulo(finite(voice?.offsetBeat, 0), LIVE_BEATS); }
function cleanEvents(voice) {
  const loop = loopOf(voice), events = [];
  for (const source of Array.isArray(voice?.events) ? voice.events : []) {
    const note = cleanNote(source);
    if (!note || !Number.isFinite(source.beat) || source.beat < 0 || source.beat >= loop) continue;
    events.push({ ...note, beat: source.beat, dur: Math.min(note.dur, loop - source.beat),
      id: typeof source.id === 'string' && source.id ? source.id.slice(0, 150) : `${voiceId(voice?.id)}:n${events.length}` });
  }
  events.sort((a, b) => a.beat - b.beat);
  return bounded(events);
}

/** The exact Engine.setInks / renderWav format; muted companions are omitted. */
export function buildLivingScore(baseResult, voices) {
  const result = { ...structuredClone(baseResult || {}), tempo: LIVE_TEMPO, bars: LIVE_BEATS / 4,
    tracks: { melody: [], chords: [], bass: [] } };
  const ink = [], identities = new Set();
  // Muting does not let a fourth companion enter the three reserved slots.
  for (const voice of (Array.isArray(voices) ? voices : []).filter(value => value && typeof value === 'object').slice(0, MAX_VOICES)) {
    if (voice.muted) continue;
    const loop = loopOf(voice), offset = offsetOf(voice);
    for (const event of cleanEvents(voice)) {
      for (let repeat = 0; repeat < LIVE_BEATS / loop; repeat++) {
        const originalId = `${event.id}:r${repeat}`;
        let id = originalId, collision = 1;
        while (identities.has(id)) id = `${originalId}:d${collision++}`;
        identities.add(id);
        // A note may naturally ring across the global seam. Its onset remains
        // in [0,8); the realtime Engine and WAV excerpt planner handle its tail.
        ink.push({ ...event, id, voiceId: voiceId(voice.id),
          beat: modulo(event.beat + offset + repeat * loop, LIVE_BEATS) });
      }
    }
  }
  ink.sort((a, b) => a.beat - b.beat);
  return { result, ink };
}

/**
 * Animation uses the same event phase and repeat IDs as buildLivingScore.
 * During silence it is inactive; after release it stays at the last point
 * instead of moving towards the start early. Wrap happens only at the loop.
 */
export function livingVoicePosition(voice, beat) {
  const loop = loopOf(voice);
  let elapsed = modulo(finite(beat, 0) - offsetOf(voice), LIVE_BEATS);
  // Offset addition/subtraction can differ by a few floating-point ulps.
  // Snap only mathematical loop seams, never the user's recorded rhythm.
  const seam = Math.round(elapsed / loop) * loop;
  if (Math.abs(elapsed - seam) < TIME_EPSILON) elapsed = seam % LIVE_BEATS;
  const localBeat = elapsed % loop, repeat = Math.floor(elapsed / loop), events = cleanEvents(voice);
  const points = (Array.isArray(voice?.points) ? voice.points : []).filter(point => point &&
    Number.isFinite(point.beat) && point.beat >= 0 && point.beat < loop)
    .map(point => ({ ...point, x: unit(point.x), y: unit(point.y) })).sort((a, b) => a.beat - b.beat);
  const path = bounded(points.length ? points : events);
  if (!path.length) return { x: 0.5, y: 0.5, active: false, beat: localBeat, eventId: null,
    kind: 'mist', color: COLORS.mist, note: 60 };
  let previous = path[0], next = path[0];
  for (const point of path) {
    if (point.beat <= localBeat + TIME_EPSILON) previous = point;
    else { next = point; break; }
    next = point;
  }
  const blend = next.beat > previous.beat ? clamp((localBeat - previous.beat) / (next.beat - previous.beat), 0, 1) : 0;
  let sounding = null;
  for (const event of events) {
    if (event.beat <= localBeat + TIME_EPSILON && localBeat < event.beat + event.dur - TIME_EPSILON) sounding = event;
  }
  const active = !voice?.muted && !!sounding, current = sounding || previous;
  return { x: previous.x + (next.x - previous.x) * blend, y: previous.y + (next.y - previous.y) * blend,
    active, beat: localBeat, eventId: active ? `${sounding.id}:r${repeat}` : null,
    kind: KINDS.includes(current.kind) ? current.kind : 'mist',
    color: safeColor(current.color, KINDS.includes(current.kind) ? current.kind : 'mist'), note: finite(current.note, 60) };
}


/**
 * Strict persistence boundary. Select only score-bearing fields: cached events,
 * drawing pulses, derived beats, and arbitrary runtime properties never change
 * saved-work identity. Unlike live-input helpers, this must not silently clamp,
 * reorder, merge, or discard any of the user's saved notes.
 */
export function normalizeLivingEnsemble(value) {
  const fail = detail => { throw new RangeError(`三声部作品${detail}，无法安全恢复`); };
  const record = item => item && typeof item === 'object' && !Array.isArray(item);
  if (!record(value) || value.v !== 1) fail('版本不受支持');
  if (value.tempo !== LIVE_TEMPO) fail('速度无效');
  if (!Array.isArray(value.voices) || value.voices.length > MAX_VOICES) fail('声部数量无效');
  const ids = new Set();
  const voices = value.voices.map(source => {
    if (!record(source)) fail('声部格式无效');
    if (typeof source.id !== 'string' || !source.id.trim() || source.id.length > 100 || ids.has(source.id)) fail('声部标识无效');
    ids.add(source.id);
    if (!Number.isFinite(source.durationMs) || source.durationMs < 0 || source.durationMs > MAX_GESTURE_MS) fail('录制时长无效');
    const loopBeats = source.durationMs <= 2400 ? 4 : LIVE_BEATS;
    if (source.loopBeats !== loopBeats) fail('循环长度与录制时长不符');
    if (!Number.isFinite(source.offsetBeat) || source.offsetBeat < 0 || source.offsetBeat >= LIVE_BEATS) fail('起始位置无效');
    if (typeof source.muted !== 'boolean') fail('静音状态无效');
    const sourcePoints = source.points === undefined ? source.samples : source.points;
    if (!Array.isArray(sourcePoints) || !sourcePoints.length || sourcePoints.length > MAX_POINTS) fail('笔迹数量无效');
    let previousTime = -1;
    const points = sourcePoints.map(point => {
      if (!record(point) || !KINDS.includes(point.kind)) fail('笔迹乐器无效');
      if (!['tMs', 'x', 'y', 'note', 'dur', 'vel'].every(key => Number.isFinite(point[key]))) fail('笔迹数值无效');
      if (point.tMs < 0 || point.tMs <= previousTime || point.tMs > source.durationMs || point.tMs >= loopBeats * 600 ||
          point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 ||
          !Number.isInteger(point.note) || point.note < 0 || point.note > 127 ||
          !Number.isInteger(point.vel) || point.vel < 1 || point.vel > 127 || point.dur <= 0 || point.dur > 2) fail('笔迹超出可恢复范围');
      if (!validColor(point.color)) fail('笔迹颜色无效');
      previousTime = point.tMs;
      return { tMs: point.tMs, x: point.x, y: point.y, note: point.note, dur: point.dur,
        vel: point.vel, kind: point.kind, color: point.color };
    });
    const voice = createLivingVoice(points, { id: source.id, tempo: LIVE_TEMPO, durationMs: source.durationMs });
    if (voice.points.length !== points.length || voice.loopBeats !== source.loopBeats ||
        voice.points.some((point, index) => Object.keys(points[index]).some(key => point[key] !== points[index][key]))) fail('笔迹会在恢复时发生变化');
    return { ...voice, offsetBeat: source.offsetBeat, muted: source.muted };
  });
  return { v: 1, tempo: LIVE_TEMPO, voices };
}
