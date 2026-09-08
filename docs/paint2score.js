/*
 * Paint → Score 核心算法（paint_to_midi.py 的纯前端移植）
 *
 * 扫描 = 给每个像素一个"到达时间"的标量场 F：
 *   lr: F = x   tb: F = y   ripple: F = 到焦点的距离
 * 小节 / 时值槽 = F 的等像素量分位带（每一段"读"掉同样多的颜料）。
 *
 * 为了实时交互，把像素按 F 排序一次并建前缀和，
 * 任意分位带的统计量都变成 O(log n) 的区间查询。
 */

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

const MAJOR_DEGREES = [
  ['I', 0, 'maj'], ['ii', 2, 'min'], ['iii', 4, 'min'],
  ['IV', 5, 'maj'], ['V', 7, 'maj'], ['vi', 9, 'min'],
];
const MINOR_DEGREES = [
  ['i', 0, 'min'], ['III', 3, 'maj'], ['iv', 5, 'min'],
  ['v', 7, 'min'], ['VI', 8, 'maj'], ['VII', 10, 'maj'],
];
const FAMILIES_MAJOR = [['主功能', [0, 5]], ['下属功能', [3, 1]], ['属功能', [4, 2]]];
const FAMILIES_MINOR = [['主功能', [0, 4]], ['下属功能', [2, 1]], ['属功能', [5, 3]]];

const RHYTHM_TEMPLATES = [
  [[0, 2], [2, 2]],
  [[0, 1.5], [1.5, 1.5], [3, 1]],
  [[0, 1], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1]],
  [[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]],
];

export const SCAN_NAMES = { lr: '左 → 右', tb: '上 → 下', ripple: '涟漪' };

// ---------------- 随机数（可复现） ----------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rnd, lo, hi) { return lo + Math.floor(rnd() * (hi - lo)); }   // [lo, hi)
function randNormal(rnd, sd) {
  const u = Math.max(1e-12, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
}

// ---------------- 图像分析 ----------------

/** 从 <img> / canvas 源提取 HSV、明度与边缘密度。宽度统一缩到 width。 */
export function analyzeImage(source, width = 480) {
  const sw = source.naturalWidth || source.videoWidth || source.width;
  const sh = source.naturalHeight || source.videoHeight || source.height;
  const w = Math.min(width, sw);
  const h = Math.max(1, Math.round(sh * w / sw));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const n = w * h;
  const H = new Float32Array(n), S = new Float32Array(n), V = new Float32Array(n), gray = new Float32Array(n);
  let hash = 2166136261;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hue = 0;
    if (d > 1e-9) {
      if (mx === r) hue = ((g - b) / d) % 6;
      else if (mx === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    H[i] = hue;
    S[i] = mx > 1e-9 ? d / mx : 0;
    V[i] = mx;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    if ((i & 7) === 0) {
      hash ^= rgba[i * 4] + (rgba[i * 4 + 1] << 8) + (rgba[i * 4 + 2] << 16);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }

  // np.gradient：内部中心差分，边界单侧差分
  const edges = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = x === 0 ? gray[i + 1] - gray[i]
        : x === w - 1 ? gray[i] - gray[i - 1]
          : (gray[i + 1] - gray[i - 1]) / 2;
      const gy = y === 0 ? gray[i + w] - gray[i]
        : y === h - 1 ? gray[i] - gray[i - w]
          : (gray[i + w] - gray[i - w]) / 2;
      edges[i] = Math.hypot(gx, gy);
    }
  }
  const sortedE = Float32Array.from(edges).sort();
  const eRef = sortedE[Math.min(n - 1, Math.floor(0.95 * (n - 1)))] + 1e-9;

  return { w, h, H, S, V, edges, eRef, hash: hash % 10000 };
}

function circularMean(cos, sin) {
  return (Math.atan2(sin, cos) * 180 / Math.PI + 360) % 360;
}

export function analyzeGlobal(img) {
  const { H, S, V } = img;
  let c = 0, s = 0, vsum = 0;
  for (let i = 0; i < H.length; i++) {
    const wgt = S[i] * S[i] + 1e-6;
    const a = H[i] * Math.PI / 180;
    c += Math.cos(a) * wgt; s += Math.sin(a) * wgt;
    vsum += V[i];
  }
  const hue = circularMean(c, s);
  const hueIdx = Math.round(hue / 30) % 12;
  const tonicPc = (hueIdx * 7) % 12;
  const warmth = (Math.cos(hue * Math.PI / 180) + 1) / 2;
  const brightness = vsum / H.length;
  const modeScore = 0.55 * brightness + 0.45 * warmth;
  return { hue, warmth, brightness, tonicPc, mode: modeScore > 0.5 ? 'major' : 'minor', modeScore };
}

/** 默认涟漪焦点：粗网格上的最亮格子中心。 */
export function brightestPoint(img) {
  const { w, h, V } = img;
  const gw = 32, gh = Math.max(4, Math.round(32 * h / w));
  let best = -1, bx = 0.5, by = 0.5;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * w / gw), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * w / gw));
      const y0 = Math.floor(gy * h / gh), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * h / gh));
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += V[y * w + x]; cnt++; }
      const m = sum / cnt;
      if (m > best) { best = m; bx = (gx + 0.5) / gw; by = (gy + 0.5) / gh; }
    }
  }
  return [bx, by];
}

// ---------------- 扫描场 ----------------

export class ScanField {
  constructor(img, scan = 'lr', focus = null) {
    const { w, h, H, S, V, edges } = img;
    const n = w * h;
    this.scan = scan; this.w = w; this.h = h; this.n = n;
    const F = new Float32Array(n);
    if (scan === 'ripple') {
      const fx = focus[0] * w, fy = focus[1] * h;
      this.focusPx = [fx, fy];
      for (let i = 0; i < n; i++) F[i] = Math.hypot((i % w) - fx, Math.floor(i / w) - fy);
    } else if (scan === 'tb') {
      for (let i = 0; i < n; i++) F[i] = Math.floor(i / w);
    } else {
      for (let i = 0; i < n; i++) F[i] = i % w;
    }
    // 按 F 排序像素索引
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => F[a] - F[b]);
    this.Fsorted = new Float32Array(n);
    for (let k = 0; k < n; k++) this.Fsorted[k] = F[order[k]];

    // 前缀和：cos·S² sin·S² S V edge V² V²·y V²·x
    const P = 8;
    const pre = new Float64Array((n + 1) * P);
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const wgt = S[i] * S[i] + 1e-6, a = H[i] * Math.PI / 180, v2 = V[i] * V[i];
      const o = (k + 1) * P, p = k * P;
      pre[o] = pre[p] + Math.cos(a) * wgt;
      pre[o + 1] = pre[p + 1] + Math.sin(a) * wgt;
      pre[o + 2] = pre[p + 2] + S[i];
      pre[o + 3] = pre[p + 3] + V[i];
      pre[o + 4] = pre[p + 4] + edges[i];
      pre[o + 5] = pre[p + 5] + v2;
      pre[o + 6] = pre[p + 6] + v2 * Math.floor(i / w);
      pre[o + 7] = pre[p + 7] + v2 * (i % w);
    }
    this.pre = pre; this.P = P;
  }

  /** F 的 p 分位数（线性插值，同 np.quantile）。 */
  q(p) {
    p = Math.min(1, Math.max(0, p));
    const pos = p * (this.n - 1), lo = Math.floor(pos), hi = Math.min(this.n - 1, lo + 1);
    return this.Fsorted[lo] + (this.Fsorted[hi] - this.Fsorted[lo]) * (pos - lo);
  }

  _lowerBound(v) {
    let lo = 0, hi = this.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.Fsorted[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  /** 分位带 [p0,p1) 在排序序列中的区间 [k0,k1)。非空兜底。 */
  bandRange(p0, p1) {
    const a = this.q(p0);
    let k0 = this._lowerBound(a);
    let k1 = p1 >= 1 ? this.n : this._lowerBound(this.q(p1));
    if (k1 <= k0) { k0 = Math.min(k0, this.n - 1); k1 = k0 + 1; }
    return [k0, k1];
  }

  /** 区间统计：色相、饱和、明度、边缘、亮度重心。 */
  stats(p0, p1) {
    const [k0, k1] = this.bandRange(p0, p1);
    const P = this.P, a = k0 * P, b = k1 * P, pre = this.pre, cnt = k1 - k0;
    const g = (j) => pre[b + j] - pre[a + j];
    const v2 = g(5);
    return {
      hue: circularMean(g(0), g(1)),
      sat: g(2) / cnt,
      val: g(3) / cnt,
      edgeRaw: g(4) / cnt,
      cy: v2 < 1e-9 ? 0.5 : (g(6) / v2) / Math.max(1, this.h - 1),
      cx: v2 < 1e-9 ? 0.5 : (g(7) / v2) / Math.max(1, this.w - 1),
    };
  }

  barBounds(nBars) {
    const out = [];
    for (let k = 0; k <= nBars; k++) out.push(this.q(k / nBars));
    return out;
  }
}

// ---------------- 和弦 ----------------

function hueDiff(a, b) { return ((a - b + 180) % 360 + 360) % 360 - 180; }

function computeDepartures(bars, g) {
  const meanSat = bars.reduce((s, b) => s + b.sat, 0) / bars.length;
  const raw = bars.map(s => {
    const dHue = Math.min(1, Math.abs(hueDiff(s.hue, g.hue)) / 90);
    const dVal = Math.min(1, Math.abs(s.val - g.brightness) * 2);
    const dSat = Math.min(1, Math.abs(s.sat - meanSat) * 1.5);
    return 0.5 * dHue + 0.3 * dVal + 0.2 * dSat;
  });
  const idx = raw.map((_, i) => i).sort((a, b) => raw[a] - raw[b]);
  const rank = new Array(raw.length);
  idx.forEach((i, r) => rank[i] = r);
  const n = Math.max(1, bars.length - 1);
  return rank.map(r => r / n);
}

function pickChord(strip, g, barI, nBars, departure, prev) {
  const degrees = g.mode === 'major' ? MAJOR_DEGREES : MINOR_DEGREES;
  const families = g.mode === 'major' ? FAMILIES_MAJOR : FAMILIES_MINOR;
  let deg, reason;
  if (barI === 0) {
    deg = degrees[0]; reason = '第一小节：先在主和弦上安家，让耳朵知道“家”在哪';
  } else if (barI === nBars - 1) {
    deg = degrees[0]; reason = '最后一小节：回到主和弦收束';
  } else if (barI % 4 === 3) {
    const [, cands] = families[2];
    deg = degrees[cands[0]];
    if (prev && deg[0] === prev.degree) deg = degrees[cands[1]];
    reason = '第 4 小节位置：拉向属功能，制造“该回家了”的引力';
  } else {
    const tier = Math.min(2, Math.floor(departure * 3));
    const [famName, cands] = families[tier];
    const side = hueDiff(strip.hue, g.hue) >= 0 ? 0 : 1;
    deg = degrees[cands[side]];
    if (prev && deg[0] === prev.degree) deg = degrees[cands[1 - side]];
    reason = `偏离全画基调 ${departure.toFixed(2)}（0 = 最像基调）→ ${famName}`;
  }
  const [name, interval, quality] = deg;
  const rootPc = (g.tonicPc + interval) % 12;
  const third = quality === 'maj' ? 4 : 3;
  const pcs = [rootPc, (rootPc + third) % 12, (rootPc + 7) % 12];
  let label = PITCH_NAMES[rootPc] + (quality === 'min' ? 'm' : '');
  let tension = '';
  const scale = g.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  if (strip.sat > 0.45) {
    const isMaj7 = quality === 'maj' && g.mode === 'major';
    pcs.push((rootPc + (isMaj7 ? 11 : 10)) % 12);
    label += isMaj7 ? 'maj7' : '7';
    tension = '饱和度高 → 加 7 音';
  }
  if (strip.sat > 0.7) {
    const ninth = (rootPc + 2) % 12;
    if (scale.includes((ninth - g.tonicPc + 12) % 12)) {
      pcs.push(ninth); label += '(9)'; tension = '饱和度很高 → 加 7、9 音';
    }
  }
  const octave = strip.val > 0.55 ? 4 : 3;
  const base = 12 * (octave + 1) + rootPc;
  const notes = [];
  let prevN = base;
  pcs.forEach((pc, i) => {
    const nn = i === 0 ? base : prevN + (((pc - prevN) % 12) + 12) % 12;
    notes.push(nn); prevN = nn;
  });
  return { label, degree: name, notes, reason, tension, pcs };
}

// ---------------- 旋律与贝斯 ----------------

function scalePool(g, lo = 48, hi = 84) {
  const scale = g.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const out = [];
  for (let n = lo; n <= hi; n++) if (scale.includes(((n - g.tonicPc) % 12 + 12) % 12)) out.push(n);
  return out;
}
const nearest = (arr, t) => arr.reduce((b, n) => Math.abs(n - t) < Math.abs(b - t) ? n : b, arr[0]);

function makeMelody(field, bars, chords, g, rnd, nBars) {
  const pool = scalePool(g);
  const events = [];
  let prevNote = null;
  bars.forEach((strip, barI) => {
    const chord = chords[barI];
    const level = Math.min(3, Math.floor(strip.edge * 4));
    const template = RHYTHM_TEMPLATES[level];
    const registerShift = Math.trunc((strip.val - 0.5) * 14);
    template.forEach(([onset, dur], slotI) => {
      const p0 = (barI + onset / 4) / nBars;
      const p1 = (barI + Math.min(4, onset + dur) / 4) / nBars;
      const st = field.stats(p0, p1);
      if (st.val < 0.06) return;                        // 近黑 = 休止
      // tb 扫描轴本身是 y，改用横向位置（右 = 高音，像钢琴键盘）
      let cy = field.scan === 'tb' ? 1 - st.cx : st.cy;
      cy = (cy - 0.5) * 1.8 + 0.5;
      const target = 76 - Math.trunc(cy * 24) + registerShift;
      let cands = pool;
      if (slotI === 0) {
        const chordTones = pool.filter(n => chord.pcs.slice(0, 3).includes(n % 12));
        if (chordTones.length) cands = chordTones;
      }
      let note = nearest(cands, target);
      if (prevNote !== null && Math.abs(note - prevNote) > 7) {
        const pulled = cands.filter(n => Math.abs(n - prevNote) <= 7);
        if (pulled.length) note = nearest(pulled, target);
      }
      const vel = Math.max(30, Math.min(110, Math.trunc(58 + strip.sat * 40 + randInt(rnd, -5, 6))));
      const start = Math.max(0, barI * 4 + onset + randNormal(rnd, 0.008));
      events.push([start, dur * 0.92, note, vel]);
      prevNote = note;
    });
  });
  return events;
}

function makeBass(bars, chords) {
  const events = [];
  bars.forEach((strip, barI) => {
    const root = chords[barI].notes[0] - 12;
    if (strip.edge > 0.5 && barI !== bars.length - 1) {
      events.push([barI * 4, 2.8, root, 78]);
      events.push([barI * 4 + 3, 0.9, root, 64]);
    } else {
      events.push([barI * 4, 3.9, root, 74]);
    }
  });
  return events;
}

function makeChordEvents(chords) {
  const events = [];
  chords.forEach((c, barI) => c.notes.forEach(n => events.push([barI * 4, 3.9, n, 52])));
  return events;
}

// ---------------- 主流程 ----------------

/**
 * @param img  analyzeImage 的结果
 * @param opts { scan, focus:[fx,fy]|null, bars, tempo, key, mode, seed }
 */
export function summon(img, opts = {}) {
  const nBars = opts.bars || 16;
  const tempo = opts.tempo || 80;
  const scan = opts.scan || 'lr';
  const seed = opts.seed ?? img.hash;
  const rnd = mulberry32(seed);

  const g = analyzeGlobal(img);
  if (opts.key) g.tonicPc = PITCH_NAMES.indexOf(opts.key);
  if (opts.mode) g.mode = opts.mode;

  let focus = opts.focus;
  if (scan === 'ripple' && !focus) focus = brightestPoint(img);
  const field = new ScanField(img, scan, focus);

  const bars = [];
  for (let k = 0; k < nBars; k++) {
    const st = field.stats(k / nBars, (k + 1) / nBars);
    bars.push({ hue: st.hue, sat: st.sat, val: st.val, edge: Math.min(1, st.edgeRaw / img.eRef * 2.5) });
  }
  const departures = computeDepartures(bars, g);
  const chords = [];
  bars.forEach((s, i) => chords.push(pickChord(s, g, i, nBars, departures[i], chords[i - 1] || null)));

  const melody = makeMelody(field, bars, chords, g, rnd, nBars);
  const bass = makeBass(bars, chords);
  const chordEvents = makeChordEvents(chords);

  const bounds = field.barBounds(nBars);
  const geometry = scan === 'lr' ? { type: 'lr', bounds: bounds.map(b => b / img.w) }
    : scan === 'tb' ? { type: 'tb', bounds: bounds.map(b => b / img.h) }
      : { type: 'ripple', focus, bounds: bounds.map(b => b / img.w) };

  return {
    key: `${PITCH_NAMES[g.tonicPc]} ${g.mode === 'major' ? '大调' : '小调'}`,
    tonic: PITCH_NAMES[g.tonicPc], mode: g.mode,
    global: g, tempo, bars: nBars, seed, scan, focus,
    barFeats: bars, departures, chords, geometry,
    tracks: { melody, chords: chordEvents, bass },
  };
}
