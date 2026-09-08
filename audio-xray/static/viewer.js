/* audio-xray 图层视图 v1.5
 * 所有面板共享同一个时间→像素映射；播放头、选区、悬停十字线在 rAF 里同步。
 */

const trackId = window.TRACK_ID;
const player = document.getElementById('player');
const panelsEl = document.getElementById('panels');
const dpr = window.devicePixelRatio || 1;

const COLORS = {
  bg: '#0a0f1a', panel: '#101828', line: '#22304a',
  ice: '#7dd3fc', ice2: '#a5b4fc', glow: '#fbbf24',
  playhead: '#fda4af', dim: '#7d90ab', text: '#d8e3f2',
};
const SEG_PALETTE = ['#7dd3fc', '#a5b4fc', '#f0abfc', '#fda4af', '#fcd34d', '#86efac', '#67e8f9', '#c4b5fd'];
const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

let A = null;
let notes = null;
let panels = [];
let heatCqt = null, heatMel = null, heatChroma = null;

const state = {
  zoom: 1,
  selStart: null, selEnd: null,
  loop: false, snap: true,
  activeSeg: null,
  hover: null,          // {t, panelId, y}
};

// ---------- 小工具 ----------

function fmtTime(t, dec = 1) {
  const m = Math.floor(t / 60), s = t - m * 60;
  const ss = dec ? s.toFixed(dec) : Math.floor(s).toString();
  return `${m}:${(s < 10 ? '0' : '')}${ss}`;
}

function lerp(a, b, t) { return a + (b - a) * t; }

// 冷蓝"冰川"色带
const ICE_STOPS = [
  [0.00, [10, 15, 26]],
  [0.30, [26, 47, 84]],
  [0.55, [43, 106, 160]],
  [0.75, [86, 190, 233]],
  [0.90, [178, 235, 250]],
  [1.00, [255, 255, 255]],
];
function iceMap(v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < ICE_STOPS.length; i++) {
    if (v <= ICE_STOPS[i][0]) {
      const [p0, c0] = ICE_STOPS[i - 1], [p1, c1] = ICE_STOPS[i];
      const t = (v - p0) / (p1 - p0);
      return [lerp(c0[0], c1[0], t) | 0, lerp(c0[1], c1[1], t) | 0, lerp(c0[2], c1[2], t) | 0];
    }
  }
  return [255, 255, 255];
}

function heatCanvas(data, flipY) {
  const bins = data.length, cols = data[0].length;
  const oc = document.createElement('canvas');
  oc.width = cols; oc.height = bins;
  const ictx = oc.getContext('2d');
  const img = ictx.createImageData(cols, bins);
  for (let r = 0; r < bins; r++) {
    const src = flipY ? data[bins - 1 - r] : data[r];
    for (let c = 0; c < cols; c++) {
      const [R, G, B] = iceMap(src[c] / 99);
      const o = (r * cols + c) * 4;
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
  }
  ictx.putImageData(img, 0, 0);
  return oc;
}

// 和弦按根音着色：十二个根音 = 十二个色相，小三和弦更暗
function chordColor(label) {
  if (label === '—') return 'rgba(125, 144, 171, .18)';
  const minor = label.endsWith('m');
  const root = minor ? label.slice(0, -1) : label;
  const idx = PITCH_NAMES.indexOf(root);
  const hue = (idx * 30 + 200) % 360;
  return `hsla(${hue}, 60%, ${minor ? 34 : 50}%, .8)`;
}

function totalW() { return Math.max(300, panelsEl.clientWidth * state.zoom) - 2; }
function xOf(t) { return t / A.duration * totalW(); }
function tOf(x) { return x / totalW() * A.duration; }

function snapT(t) {
  if (!state.snap || !A.beat_times.length) return t;
  let best = A.beat_times[0], bd = Infinity;
  for (const b of A.beat_times) {
    const d = Math.abs(b - t);
    if (d < bd) { bd = d; best = b; }
  }
  return bd < 0.6 ? best : t;
}

// ---------- 面板定义 ----------

function drawLaneCurve(ctx, times, vals, y0, laneH, color, W) {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo < 1e-9 ? 1 : hi - lo;
  const pad = 3;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = xOf(times[i]);
    const y = y0 + laneH - pad - ((v - lo) / span) * (laneH - 2 * pad);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(xOf(times[times.length - 1]), y0 + laneH);
  ctx.lineTo(xOf(times[0]), y0 + laneH);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

const PANEL_DEFS = [
  {
    id: 'ruler', label: '段落 · 节拍 · 变化点', h: 52,
    draw(ctx, W, H) {
      A.segments.forEach((s, i) => {
        const c = SEG_PALETTE[i % SEG_PALETTE.length];
        ctx.fillStyle = c + '33';
        ctx.fillRect(xOf(s.start), 0, xOf(s.end) - xOf(s.start), H);
        ctx.fillStyle = c;
        ctx.font = '600 11px -apple-system, sans-serif';
        ctx.fillText(`段${i + 1}`, xOf(s.start) + 5, 15);
      });
      ctx.strokeStyle = 'rgba(253, 164, 175, .55)';
      ctx.setLineDash([3, 3]);
      for (const b of A.boundaries.slice(1, -1)) {
        ctx.beginPath(); ctx.moveTo(xOf(b), 0); ctx.lineTo(xOf(b), H); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(125, 211, 252, .45)';
      A.beat_times.forEach((b, i) => {
        const x = xOf(b);
        ctx.beginPath(); ctx.moveTo(x, H - (i % 4 === 0 ? 13 : 7)); ctx.lineTo(x, H); ctx.stroke();
      });
      const steps = [1, 2, 5, 10, 15, 30, 60];
      let step = steps.find(s => xOf(s) > 55) || 60;
      ctx.fillStyle = COLORS.dim; ctx.font = '10px -apple-system, sans-serif';
      for (let t = 0; t <= A.duration; t += step) {
        ctx.fillText(fmtTime(t, 0), xOf(t) + 3, H - 16);
      }
    },
  },
  {
    id: 'wave', label: '波形 · 素胚明度', h: 96,
    draw(ctx, W, H) {
      const n = A.wave.max.length, mid = H / 2;
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(125, 211, 252, .85)');
      grad.addColorStop(.5, 'rgba(165, 180, 252, .95)');
      grad.addColorStop(1, 'rgba(125, 211, 252, .85)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(i / n * W, mid - A.wave.max[i] * (mid - 4));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(i / n * W, mid - A.wave.min[i] * (mid - 4));
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(253, 164, 175, .3)';
      for (const b of A.boundaries.slice(1, -1)) {
        ctx.beginPath(); ctx.moveTo(xOf(b), 0); ctx.lineTo(xOf(b), H); ctx.stroke();
      }
    },
  },
  {
    id: 'cqt', label: '音高频谱 CQT · 每行 = 一个半音 · 横线 = C（八度分界）', h: 220,
    draw(ctx, W, H) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(heatCqt, 0, 0, W, H);
      // 每个八度的 C 画一条参考线
      ctx.strokeStyle = 'rgba(216, 227, 242, .18)';
      for (let oct = 0; oct <= 7; oct++) {
        const y = H - (oct * 12) / A.cqt.n_bins * H;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    },
    overlayExtra(ctx, W, H, scrollLeft) {
      ctx.font = '9px -apple-system, sans-serif';
      for (let oct = 0; oct <= 7; oct++) {
        const y = H - (oct * 12) / A.cqt.n_bins * H;
        ctx.fillStyle = 'rgba(10,15,26,.75)';
        ctx.fillRect(scrollLeft, y - 11, 20, 11);
        ctx.fillStyle = COLORS.dim;
        ctx.fillText('C' + (oct + 1), scrollLeft + 3, y - 2);
      }
    },
    hoverInfo(y, H) {
      const bin = Math.max(0, Math.min(A.cqt.n_bins - 1, Math.floor((1 - y / H) * A.cqt.n_bins)));
      return PITCH_NAMES[bin % 12] + (1 + Math.floor(bin / 12));
    },
  },
  {
    id: 'mel', label: 'Mel 频谱 · 高频空气与质感（鸟、气声、镲片都住在上面）', h: 120,
    draw(ctx, W, H) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(heatMel, 0, 0, W, H);
    },
  },
  {
    id: 'chords', label: '和弦候选（模板匹配，是猜测不是真理）', h: 34,
    draw(ctx, W, H) {
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      for (const c of A.chords) {
        const x0 = xOf(c.start), x1 = xOf(c.end);
        ctx.fillStyle = chordColor(c.label);
        ctx.fillRect(x0, 3, x1 - x0 - 1, H - 6);
        if (x1 - x0 > 26 && c.label !== '—') {
          ctx.fillStyle = '#0a0f1a';
          ctx.fillText(c.label, x0 + 6, H / 2 + 1);
        }
      }
      ctx.textBaseline = 'alphabetic';
    },
    hoverInfo(y, H, t) {
      const c = A.chords.find(c => t >= c.start && t < c.end);
      return c ? '和弦候选 ' + c.label : null;
    },
  },
  {
    id: 'chroma', label: 'Chroma 十二音级色带 · 和声的 Gradient', h: 132,
    draw(ctx, W, H) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(heatChroma, 0, 0, W, H);
      ctx.strokeStyle = 'rgba(10, 15, 26, .6)';
      for (let i = 1; i < 12; i++) {
        const y = H - i / 12 * H;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    },
    overlayExtra(ctx, W, H, scrollLeft) {
      ctx.font = '9px -apple-system, sans-serif';
      A.chroma.labels.forEach((name, i) => {
        const y = H - (i + 0.5) / 12 * H + 3;
        ctx.fillStyle = 'rgba(10,15,26,.7)';
        ctx.fillRect(scrollLeft, y - 9, 16, 11);
        ctx.fillStyle = COLORS.dim;
        ctx.fillText(name, scrollLeft + 2, y);
      });
    },
    hoverInfo(y, H) {
      const i = Math.max(0, Math.min(11, Math.floor((1 - y / H) * 12)));
      return '音级 ' + PITCH_NAMES[i];
    },
  },
  {
    id: 'bands', label: '', h: 168,
    lanes: [
      { key: 'high_db', name: '高频层 · 空气', color: 'rgba(178, 235, 250, .55)' },
      { key: 'mid_db', name: '中频层 · 人声与乐器主体', color: 'rgba(165, 180, 252, .5)' },
      { key: 'low_db', name: '低音层 · 地面', color: 'rgba(59, 130, 246, .55)' },
      { key: 'onset_strength', name: '节奏密度', color: 'rgba(240, 171, 252, .45)' },
    ],
    draw(ctx, W, H) {
      const laneH = H / this.lanes.length;
      this.lanes.forEach((lane, i) => {
        const y0 = i * laneH;
        if (i > 0) {
          ctx.strokeStyle = COLORS.line;
          ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();
        }
        drawLaneCurve(ctx, A.curves.times, A.curves[lane.key], y0, laneH, lane.color, W);
      });
    },
    overlayExtra(ctx, W, H, scrollLeft) {
      const laneH = H / this.lanes.length;
      ctx.font = '10px -apple-system, sans-serif';
      this.lanes.forEach((lane, i) => {
        const y = i * laneH + 13;
        ctx.fillStyle = 'rgba(10,15,26,.75)';
        const w = ctx.measureText(lane.name).width + 10;
        ctx.fillRect(scrollLeft + 8, y - 10, w, 14);
        ctx.fillStyle = COLORS.dim;
        ctx.fillText(lane.name, scrollLeft + 13, y);
      });
    },
    hoverInfo(y, H) {
      const i = Math.max(0, Math.min(this.lanes.length - 1, Math.floor(y / (H / this.lanes.length))));
      return this.lanes[i].name;
    },
  },
];

// ---------- 搭建面板 DOM ----------

function buildPanels() {
  panelsEl.innerHTML = '';
  panels = PANEL_DEFS.map(def => {
    const wrap = document.createElement('div');
    wrap.className = 'panel';
    wrap.style.height = def.h + 'px';
    const base = document.createElement('canvas');
    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    const label = document.createElement('div');
    label.className = 'panel-label';
    label.textContent = def.label;
    label.style.position = 'absolute';
    label.style.margin = '0';
    if (!def.label) label.style.display = 'none';
    const hit = document.createElement('div');
    hit.className = 'hitbox';
    wrap.append(base, overlay, label, hit);
    panelsEl.appendChild(wrap);
    const p = { def, wrap, base, overlay, label };
    attachInteraction(p, hit);
    return p;
  });
  layout();
}

function layout() {
  const W = totalW();
  for (const p of panels) {
    p.wrap.style.width = W + 'px';
    for (const c of [p.base, p.overlay]) {
      c.width = W * dpr; c.height = p.def.h * dpr;
      c.style.width = W + 'px'; c.style.height = p.def.h + 'px';
    }
    const ctx = p.base.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, p.def.h);
    p.def.draw(ctx, W, p.def.h);
  }
  updateLabels();
  drawOverlays();
}

function updateLabels() {
  const sl = panelsEl.scrollLeft;
  for (const p of panels) p.label.style.left = (sl + 12) + 'px';
}

// ---------- overlay：播放头 / 选区 / 悬停十字线 ----------

function drawOverlays() {
  const W = totalW();
  const cur = player.currentTime;
  const sl = panelsEl.scrollLeft;
  for (const p of panels) {
    const ctx = p.overlay.getContext('2d');
    const H = p.def.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 选区
    if (state.selStart != null && state.selEnd != null) {
      const x0 = xOf(state.selStart), x1 = xOf(state.selEnd);
      ctx.fillStyle = 'rgba(125, 211, 252, .13)';
      ctx.fillRect(x0, 0, x1 - x0, H);
      ctx.strokeStyle = 'rgba(125, 211, 252, .7)';
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
    }
    // 悬停十字线
    if (state.hover != null) {
      const hx = xOf(state.hover.t);
      ctx.strokeStyle = 'rgba(216, 227, 242, .3)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
      ctx.setLineDash([]);
      if (state.hover.panelId === p.def.id) {
        let info = fmtTime(state.hover.t);
        if (p.def.hoverInfo) {
          const extra = p.def.hoverInfo.call(p.def, state.hover.y, H, state.hover.t);
          if (extra) info = extra + ' · ' + info;
        }
        ctx.font = '11px -apple-system, sans-serif';
        const tw = ctx.measureText(info).width + 12;
        let bx = hx + 8;
        if (bx + tw > sl + panelsEl.clientWidth) bx = hx - tw - 8;
        ctx.fillStyle = 'rgba(10,15,26,.85)';
        ctx.fillRect(bx, 4, tw, 17);
        ctx.fillStyle = COLORS.text;
        ctx.fillText(info, bx + 6, 16);
      }
    }
    // 播放头
    const px = xOf(cur);
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = COLORS.playhead; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.shadowBlur = 0;
    if (p.def.id === 'ruler') {
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.closePath(); ctx.fill();
    }
    if (p.def.overlayExtra) p.def.overlayExtra.call(p.def, ctx, W, H, sl);
  }
}

// ---------- 交互 ----------

function attachInteraction(p, hit) {
  let downX = null, dragging = false;
  hit.addEventListener('mousedown', e => {
    downX = e.offsetX; dragging = false;
  });
  hit.addEventListener('mousemove', e => {
    state.hover = { t: tOf(e.offsetX), panelId: p.def.id, y: e.offsetY };
    if (downX != null) {
      if (Math.abs(e.offsetX - downX) > 4) dragging = true;
      if (dragging) {
        state.selStart = tOf(Math.min(downX, e.offsetX));
        state.selEnd = tOf(Math.max(downX, e.offsetX));
      }
    }
    drawOverlays();
  });
  hit.addEventListener('mouseup', e => {
    if (downX == null) return;
    if (dragging) {
      let a = snapT(state.selStart), b = snapT(state.selEnd);
      if (b - a < 0.05) { a = state.selStart; b = state.selEnd; }
      state.selStart = a; state.selEnd = b;
      player.currentTime = a;
      setActiveSegCard(null);
    } else {
      const t = tOf(e.offsetX);
      let handled = false;
      if (p.def.id === 'ruler') {
        for (const b of A.boundaries.slice(1, -1)) {
          if (Math.abs(xOf(b) - e.offsetX) < 6) {
            selectRange(Math.max(0, b - 4), Math.min(A.duration, b + 4), true);
            handled = true; break;
          }
        }
      }
      if (!handled) player.currentTime = Math.max(0, Math.min(A.duration - 0.01, snapT(t)));
    }
    downX = null; dragging = false;
    drawOverlays();
  });
  hit.addEventListener('mouseleave', () => {
    downX = null; dragging = false;
    state.hover = null;
    drawOverlays();
  });
}

function selectRange(a, b, autoplay) {
  state.selStart = a; state.selEnd = b;
  setLoop(true);
  player.currentTime = a;
  if (autoplay) player.play();
  drawOverlays();
}

// ---------- 控制条 ----------

const playBtn = document.getElementById('playBtn');
playBtn.addEventListener('click', () => player.paused ? player.play() : player.pause());
player.addEventListener('play', () => playBtn.textContent = '❚❚ 暂停');
player.addEventListener('pause', () => playBtn.textContent = '▶ 播放');

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    player.preservesPitch = true;
    player.webkitPreservesPitch = true;
    player.playbackRate = parseFloat(btn.dataset.speed);
  });
});

const loopBtn = document.getElementById('loopBtn');
function setLoop(v) { state.loop = v; loopBtn.classList.toggle('active', v); }
loopBtn.addEventListener('click', () => setLoop(!state.loop));

const snapBtn = document.getElementById('snapBtn');
snapBtn.addEventListener('click', () => {
  state.snap = !state.snap;
  snapBtn.classList.toggle('active', state.snap);
});

document.getElementById('clearSelBtn').addEventListener('click', () => {
  state.selStart = state.selEnd = null;
  setLoop(false);
  setActiveSegCard(null);
  drawOverlays();
});

document.getElementById('exportBtn').addEventListener('click', () => {
  if (state.selStart == null) { alert('先在时间轴上拖拽框选一段，再导出。'); return; }
  window.open(`/track/${trackId}/clip?start=${state.selStart.toFixed(3)}&end=${state.selEnd.toFixed(3)}`);
});

document.getElementById('zoomSlider').addEventListener('input', e => {
  const focusT = player.currentTime;
  const focusFrac = (xOf(focusT) - panelsEl.scrollLeft) / panelsEl.clientWidth;
  state.zoom = parseFloat(e.target.value);
  layout();
  panelsEl.scrollLeft = xOf(focusT) - Math.max(0.1, Math.min(0.9, focusFrac)) * panelsEl.clientWidth;
});

panelsEl.addEventListener('scroll', () => { updateLabels(); drawOverlays(); });
window.addEventListener('resize', layout);

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    player.paused ? player.play() : player.pause();
  }
});

// ---------- 段落卡片 & 笔记 ----------

function brightnessWord(hz) {
  if (hz < 1200) return '偏暗';
  if (hz < 2500) return '中性';
  return '明亮';
}

function buildSegmentCards() {
  const box = document.getElementById('segmentCards');
  box.innerHTML = '';
  A.segments.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'seg-card';
    card.dataset.idx = i;
    const c = SEG_PALETTE[i % SEG_PALETTE.length];
    card.innerHTML = `
      <div class="seg-head">
        <span class="seg-name" style="color:${c}">段${i + 1}</span>
        <span class="seg-time">${fmtTime(s.start)} – ${fmtTime(s.end)} · ${(s.end - s.start).toFixed(1)}s</span>
      </div>
      <div class="seg-narrative">${s.narrative || ''}</div>
      <div class="seg-stats">
        <span>响度 <b>${s.rms_db_rel > 0 ? '+' : ''}${s.rms_db_rel} dB</b></span>
        <span>亮度 <b>${brightnessWord(s.centroid_hz)}</b></span>
        <span>节奏密度 <b>${s.onset_per_sec}/秒</b></span>
        <span>主要音级 <b>${s.top_pitches.join(' ')}</b></span>
      </div>
      <textarea placeholder="这一段像什么？（潮湿木柜 / 鸟飞近 / 低音落地……）"></textarea>
    `;
    card.addEventListener('click', () => selectSegment(i));
    const ta = card.querySelector('textarea');
    ta.addEventListener('click', e => e.stopPropagation());
    ta.addEventListener('mousedown', e => e.stopPropagation());
    ta.value = (notes.segments && notes.segments[i]) || '';
    box.appendChild(card);
  });
}

function selectSegment(i) {
  const s = A.segments[i];
  setActiveSegCard(i);
  selectRange(s.start, s.end, true);
}

function setActiveSegCard(i) {
  state.activeSeg = i;
  document.querySelectorAll('.seg-card').forEach(c => {
    c.classList.toggle('active', c.dataset.idx == i && i != null);
  });
}

document.getElementById('saveNotesBtn').addEventListener('click', async () => {
  const segs = {};
  document.querySelectorAll('.seg-card').forEach(c => {
    const v = c.querySelector('textarea').value.trim();
    if (v) segs[c.dataset.idx] = v;
  });
  const payload = { global: document.getElementById('globalNotes').value, segments: segs };
  await fetch(`/track/${trackId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const st = document.getElementById('saveStatus');
  st.textContent = '已保存 ✓';
  setTimeout(() => st.textContent = '', 2000);
});

// ---------- 自相似矩阵 ----------

function buildSSM() {
  const cv = document.getElementById('ssmCanvas');
  const disp = Math.min(420, cv.parentElement.clientWidth - 2);
  cv.width = disp * dpr; cv.height = disp * dpr;
  cv.style.height = disp + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const oc = heatCanvas(A.ssm.data, false);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(oc, 0, 0, disp, disp);
  ctx.strokeStyle = 'rgba(253, 164, 175, .35)';
  const span = A.ssm.t1 - A.ssm.t0 || A.duration;
  for (const b of A.boundaries.slice(1, -1)) {
    const q = (b - A.ssm.t0) / span * disp;
    ctx.beginPath(); ctx.moveTo(q, 0); ctx.lineTo(q, disp); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, q); ctx.lineTo(disp, q); ctx.stroke();
  }
  cv.addEventListener('click', e => {
    const rect = cv.getBoundingClientRect();
    const t = A.ssm.t0 + (e.clientX - rect.left) / rect.width * span;
    player.currentTime = Math.max(0, Math.min(A.duration - 0.01, t));
    player.play();
  });
}

// ---------- 主循环 ----------

function tick() {
  if (state.loop && state.selStart != null && !player.paused) {
    if (player.currentTime >= state.selEnd - 0.03 || player.currentTime < state.selStart - 0.25) {
      player.currentTime = state.selStart;
    }
  }
  if (!player.paused) {
    const px = xOf(player.currentTime);
    const vw = panelsEl.clientWidth;
    if (px > panelsEl.scrollLeft + vw * 0.92 || px < panelsEl.scrollLeft) {
      panelsEl.scrollLeft = px - vw * 0.1;
    }
  }
  drawOverlays();
  const ro = document.getElementById('timeReadout');
  ro.textContent = `${fmtTime(player.currentTime)} / ${fmtTime(A.duration)}`;
  requestAnimationFrame(tick);
}

// ---------- 启动 ----------

async function init() {
  const [aRes, nRes] = await Promise.all([
    fetch(`/track/${trackId}/analysis.json`),
    fetch(`/track/${trackId}/notes`),
  ]);
  A = await aRes.json();
  notes = await nRes.json();

  heatCqt = heatCanvas(A.cqt.data, true);
  heatMel = heatCanvas(A.mel.data, true);
  heatChroma = heatCanvas(A.chroma.data, true);

  const keyText = A.key ? ` · 调性候选 ${A.key.label}` : '';
  document.getElementById('headerMeta').textContent =
    `${fmtTime(A.duration, 0)} · ${A.tempo_bpm} BPM（估计）${keyText} · ${A.segments.length} 段`;
  document.getElementById('globalNotes').value = notes.global || '';

  buildPanels();
  buildSegmentCards();
  buildSSM();
  requestAnimationFrame(tick);
}

init();
