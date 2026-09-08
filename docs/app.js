import { analyzeImage, summon, SCAN_NAMES } from './paint2score.js';
import { buildMidi } from './midi.js';
import { Engine, PRESETS } from './sound.js';

const PAINTINGS = [
  { id: 'mist', title: '蓝雾', file: 'paintings/mist.jpg' },
  { id: 'prism', title: '棱镜', file: 'paintings/prism.jpg' },
  { id: 'garden', title: '花园', file: 'paintings/garden.jpg' },
  { id: 'live', title: 'LIVE', file: 'paintings/live.jpg' },
];

const $ = (id) => document.getElementById(id);
const img = $('painting'), overlay = $('overlay'), wrap = $('canvasWrap'), hint = $('canvasHint');
const playBtn = $('playBtn'), stopBtn = $('stopBtn'), nowChord = $('nowChord'), keyReadout = $('keyReadout');
const statusEl = $('status');
const dpr = window.devicePixelRatio || 1;

const state = {
  painting: null,     // id 或 'upload'
  title: '',
  analysis: null,
  scan: 'lr',
  focus: null,
  tempo: 80,
  mode: '',
  seed: null,
  preset: 'piano',
  result: null,
  blobUrls: [],
};
const engine = new Engine();
window.__gl = { state, engine };

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

// ---------- URL 状态 ----------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('p') && PAINTINGS.some(x => x.id === p.get('p'))) state.painting = p.get('p');
  if (p.get('s') && SCAN_NAMES[p.get('s')]) state.scan = p.get('s');
  if (p.get('f')) { const [a, b] = p.get('f').split(',').map(Number); if (isFinite(a) && isFinite(b)) state.focus = [a, b]; }
  if (p.get('t')) state.tempo = Math.min(120, Math.max(50, parseInt(p.get('t')) || 80));
  if (p.get('m') === 'major' || p.get('m') === 'minor') state.mode = p.get('m');
  if (p.get('k') && PRESETS[p.get('k')]) state.preset = p.get('k');
  if (p.get('seed')) state.seed = parseInt(p.get('seed'));
}
function writeHash() {
  if (!state.painting || state.painting === 'upload') return;
  const p = new URLSearchParams();
  p.set('p', state.painting); p.set('s', state.scan);
  if (state.scan === 'ripple' && state.focus) p.set('f', state.focus.map(v => v.toFixed(3)).join(','));
  p.set('t', state.tempo);
  if (state.mode) p.set('m', state.mode);
  p.set('k', state.preset);
  if (state.seed !== null) p.set('seed', state.seed);
  history.replaceState(null, '', '#' + p.toString());
}

// ---------- 渲染 ----------

let renderTimer = null;
function requestRender(immediate = false) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(doRender, immediate ? 0 : 200);
}

function doRender() {
  if (!state.analysis) return;
  const t0 = performance.now();
  state.result = summon(state.analysis, {
    scan: state.scan, focus: state.scan === 'ripple' ? state.focus : null,
    tempo: state.tempo, mode: state.mode || null, seed: state.seed,
  });
  if (state.scan === 'ripple') state.focus = state.result.focus;
  engine.load(state.result);
  playBtn.disabled = false;
  const g = state.result.global;
  keyReadout.innerHTML = `${state.result.key}（判定分 ${g.modeScore.toFixed(2)}）<br>` +
    `${state.result.tempo} BPM · 种子 ${state.result.seed} · ${Math.round(performance.now() - t0)} ms`;
  buildDownloads();
  buildChordStrip();
  buildReport();
  drawOverlay();
  writeHash();
}

function buildDownloads() {
  state.blobUrls.forEach(u => URL.revokeObjectURL(u));
  state.blobUrls = [];
  const { melody, chords, bass } = state.result.tracks;
  const bpm = state.result.tempo;
  const stem = (state.title || 'painting').replace(/\s+/g, '_');
  const items = [
    ['melody.mid', buildMidi([['melody', melody]], bpm)],
    ['chords.mid', buildMidi([['chords', chords]], bpm)],
    ['bass.mid', buildMidi([['bass', bass]], bpm)],
    ['combined.mid', buildMidi([['melody', melody], ['chords', chords], ['bass', bass]], bpm)],
  ];
  const box = $('downloads');
  box.innerHTML = '';
  items.forEach(([name, blob]) => {
    const url = URL.createObjectURL(blob);
    state.blobUrls.push(url);
    const a = document.createElement('a');
    a.href = url; a.download = `${stem}-${name}`; a.textContent = name;
    box.appendChild(a);
  });
  const png = document.createElement('button');
  png.textContent = '标注图 .png';
  png.addEventListener('click', exportAnnotated);
  box.appendChild(png);
}

function buildChordStrip() {
  const box = $('chordStrip');
  box.innerHTML = '';
  state.result.chords.forEach((c, i) => {
    const chip = document.createElement('span');
    chip.className = 'chord-chip';
    chip.textContent = `${i + 1}·${c.label}`;
    chip.title = '从这一小节开始播放';
    chip.addEventListener('click', async () => { await armAudio(); engine.play(i * 4); });
    box.appendChild(chip);
  });
}

function hsvToCss(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
}

function buildReport() {
  const r = state.result, g = r.global;
  const modeCn = g.mode === 'major' ? '大调' : '小调';
  const focusTxt = r.scan === 'ripple' ? `，焦点 (${r.focus[0].toFixed(2)}, ${r.focus[1].toFixed(2)})` : '';
  const rows = r.barFeats.map((s, i) => {
    const c = r.chords[i];
    const why = c.reason + (c.tension ? '；' + c.tension : '');
    return `<tr data-bar="${i}"><td>${i + 1}</td>
      <td><span class="swatch" style="background:${hsvToCss(s.hue, s.sat, s.val)}"></span>${s.hue.toFixed(0)}°</td>
      <td>${s.sat.toFixed(2)}</td><td>${s.val.toFixed(2)}</td><td>${s.edge.toFixed(2)}</td>
      <td><b>${c.label}</b></td><td>${c.degree}</td><td class="why">${why}</td></tr>`;
  }).join('');
  $('report').innerHTML = `
    <h2>${state.title} 的召唤报告</h2>
    <p class="lede">
      扫描方式 <b>${SCAN_NAMES[r.scan]}</b>${focusTxt}（每小节读掉等量的颜料）。
      全画主色相 <b>${g.hue.toFixed(0)}°</b>（饱和度加权，灰色不投票）。
      冷暖 ${g.warmth.toFixed(2)}、明度 ${g.brightness.toFixed(2)} → 调式判定分 ${g.modeScore.toFixed(2)}（&gt;0.5 大调）→ <b>${r.tonic} ${modeCn}</b>。
      ${r.tempo} BPM，${r.bars} 小节，种子 ${r.seed}。
    </p>
    <table class="bar-table">
      <thead><tr><th>小节</th><th>色相</th><th>饱和</th><th>明度</th><th>细节</th><th>和弦</th><th>级数</th><th class="why">为什么</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details>
      <summary>五分钟乐理（这份报告用到的全部概念）</summary>
      <ul class="theory">
        <li><b>调 (Key)</b>：全曲的引力中心。这幅画是 ${r.tonic} ${modeCn}，${r.tonic} 听起来最像"家"。</li>
        <li><b>音级和弦</b>：调内六个常用和弦，大调 I ii iii IV V vi，小调 i III iv v VI VII。大写 = 大和弦（亮），小写 = 小和弦（暗）。砖全来自同一个音阶，随便排都协和。</li>
        <li><b>属功能</b>：离家最远、最想回家的和弦；每 4 小节拉一次，就是终止式的引力。</li>
        <li><b>7 音 / 9 音</b>：往和弦上加盖，声音变复杂变湿润。饱和度高就多盖一层。</li>
        <li><b>和弦音 vs 经过音</b>：强拍踩和弦音（稳），弱拍可以踩音阶其他音（流动）。</li>
        <li><b>音区</b>：同一个音名在不同八度。亮的区域住高处，暗的住低处。</li>
      </ul>
    </details>`;
}

// ---------- 画布与 overlay ----------

function sizeOverlay() {
  const r = img.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  overlay.width = w * dpr; overlay.height = h * dpr;
  overlay.style.width = w + 'px'; overlay.style.height = h + 'px';
  const wr = wrap.getBoundingClientRect();
  overlay.style.left = (r.left - wr.left) + 'px';
  overlay.style.top = (r.top - wr.top) + 'px';
  drawOverlay();
}
window.addEventListener('resize', sizeOverlay);

function drawGeometry(ctx, W, H, geo, beat, playing, labels = false, scale = 1) {
  const totalBars = state.result.bars;
  const bar = Math.max(0, Math.min(totalBars - 1, Math.floor(beat / 4)));
  const frac = Math.min(1, Math.max(0, (beat - bar * 4) / 4));

  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1 * scale;
  if (geo.type === 'lr') {
    geo.bounds.slice(1, -1).forEach(b => { ctx.beginPath(); ctx.moveTo(b * W, 0); ctx.lineTo(b * W, H); ctx.stroke(); });
  } else if (geo.type === 'tb') {
    geo.bounds.slice(1, -1).forEach(b => { ctx.beginPath(); ctx.moveTo(0, b * H); ctx.lineTo(W, b * H); ctx.stroke(); });
  } else {
    const [fx, fy] = geo.focus;
    geo.bounds.slice(1, -1).forEach(b => { ctx.beginPath(); ctx.arc(fx * W, fy * H, b * W, 0, Math.PI * 2); ctx.stroke(); });
    ctx.strokeStyle = 'rgba(251, 191, 36, .9)';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath(); ctx.arc(fx * W, fy * H, 6 * scale, 0, Math.PI * 2); ctx.stroke();
  }

  if (beat > 0 || playing) {
    const p0 = geo.bounds[bar], p1 = geo.bounds[bar + 1];
    const pos = p0 + (p1 - p0) * frac;
    ctx.strokeStyle = 'rgba(253, 164, 175, .95)';
    ctx.lineWidth = 2 * scale;
    ctx.shadowColor = 'rgba(253, 164, 175, 1)';
    ctx.shadowBlur = 10 * scale;
    if (geo.type === 'lr') {
      ctx.beginPath(); ctx.moveTo(pos * W, 0); ctx.lineTo(pos * W, H); ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(125, 211, 252, .06)'; ctx.fillRect(0, 0, pos * W, H);
    } else if (geo.type === 'tb') {
      ctx.beginPath(); ctx.moveTo(0, pos * H); ctx.lineTo(W, pos * H); ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(125, 211, 252, .06)'; ctx.fillRect(0, 0, W, pos * H);
    } else {
      const [fx, fy] = geo.focus;
      ctx.beginPath(); ctx.arc(fx * W, fy * H, Math.max(2, pos * W), 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(125, 211, 252, .06)';
      ctx.beginPath(); ctx.arc(fx * W, fy * H, Math.max(2, pos * W), 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  if (labels) {
    const fs = 15 * scale;
    ctx.font = `600 ${fs}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textBaseline = 'top';
    const label = (x, y, text, color) => {
      const tw = ctx.measureText(text).width;
      x = Math.max(2, Math.min(W - tw - 8 * scale, x)); y = Math.max(2, Math.min(H - fs - 6 * scale, y));
      ctx.fillStyle = 'rgba(10,15,26,.75)';
      ctx.fillRect(x - 4 * scale, y - 2 * scale, tw + 8 * scale, fs + 6 * scale);
      ctx.fillStyle = color; ctx.fillText(text, x, y);
    };
    state.result.chords.forEach((c, i) => {
      const b0 = geo.bounds[i], b1 = geo.bounds[i + 1];
      if (geo.type === 'lr') {
        label((b0 + b1) / 2 * W - 14 * scale, 8 * scale, c.label, '#7dd3fc');
        label(b0 * W + 4 * scale, H - fs - 10 * scale, c.degree, '#fbbf24');
      } else if (geo.type === 'tb') {
        label(8 * scale, (b0 + b1) / 2 * H - fs / 2, c.label, '#7dd3fc');
        label(W - 44 * scale, (b0 + b1) / 2 * H - fs / 2, c.degree, '#fbbf24');
      } else {
        const [fx, fy] = geo.focus, rm = (b0 + b1) / 2 * W;
        label(fx * W + rm * 0.7071, fy * H + rm * 0.7071, c.label, '#7dd3fc');
      }
    });
  }
  return bar;
}

function drawOverlay() {
  if (!state.result) return;
  const ctx = overlay.getContext('2d');
  const W = overlay.width / dpr, H = overlay.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const playing = engine.playing;
  const beat = engine.beat;
  const bar = drawGeometry(ctx, W, H, state.result.geometry, beat, playing);
  const active = playing || beat > 0;
  const chord = state.result.chords[bar];
  nowChord.textContent = active && chord ? `${chord.label}（${chord.degree}）` : '';
  document.querySelectorAll('.chord-chip').forEach((chip, i) => chip.classList.toggle('playing', active && i === bar));
  document.querySelectorAll('.bar-table tr[data-bar]').forEach(tr => tr.classList.toggle('playing', active && +tr.dataset.bar === bar));
}

function tick() { drawOverlay(); requestAnimationFrame(tick); }
requestAnimationFrame(tick);

function exportAnnotated() {
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  drawGeometry(ctx, W, H, state.result.geometry, 0, false, true, Math.max(1, W / 640));
  ctx.font = `500 ${Math.round(13 * Math.max(1, W / 640))}px -apple-system, "PingFang SC", sans-serif`;
  ctx.textBaseline = 'bottom';
  const foot = `${state.title} · ${state.result.key} · ${state.result.tempo} BPM · ${SCAN_NAMES[state.result.scan]} · Gradient Lab`;
  const tw = ctx.measureText(foot).width, pad = 6 * Math.max(1, W / 640);
  ctx.fillStyle = 'rgba(10,15,26,.75)'; ctx.fillRect(W - tw - pad * 3, H - 24 * Math.max(1, W / 640), tw + pad * 2, 22 * Math.max(1, W / 640));
  ctx.fillStyle = '#d8e3f2'; ctx.fillText(foot, W - tw - pad * 2, H - pad);
  const a = document.createElement('a');
  a.download = `${state.title}-annotated.png`;
  a.href = cv.toDataURL('image/png');
  a.click();
}

// ---------- 音频 ----------

let arming = null;
async function armAudio() {
  if (arming) return arming;
  arming = (async () => {
    await engine.ensureStarted();
    if (engine.presetName !== state.preset) {
      setStatus(`加载音色「${PRESETS[state.preset].name}」……`, 'busy');
      await engine.setPreset(state.preset);
      setStatus('');
    }
  })().finally(() => { arming = null; });
  return arming;
}

playBtn.addEventListener('click', async () => {
  try {
    await armAudio();
    engine.toggle();
  } catch (e) {
    setStatus('音频启动失败：' + e.message, 'err');
  }
});
stopBtn.addEventListener('click', () => engine.stop());
engine.onState = (playing) => { playBtn.textContent = playing ? '❚❚ 暂停' : '▶ 播放'; };
engine.onEnd = () => { playBtn.textContent = '▶ 播放'; };

// ---------- 交互 ----------

overlay.addEventListener('click', e => {
  if (!state.analysis) return;
  const r = overlay.getBoundingClientRect();
  state.focus = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  if (state.scan !== 'ripple') setScan('ripple');
  requestRender(true);
});

function setScan(scan) {
  state.scan = scan;
  document.querySelectorAll('.scan-btn').forEach(b => b.classList.toggle('active', b.dataset.scan === scan));
  $('rippleTip').hidden = scan !== 'ripple';
}
document.querySelectorAll('.scan-btn').forEach(btn => btn.addEventListener('click', () => { setScan(btn.dataset.scan); requestRender(true); }));

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}
document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => { setMode(btn.dataset.mode); requestRender(true); }));

const tempoSlider = $('tempoSlider');
tempoSlider.addEventListener('input', () => {
  state.tempo = parseInt(tempoSlider.value);
  $('tempoVal').textContent = state.tempo;
  requestRender();
});

$('rerollBtn').addEventListener('click', () => { state.seed = Math.floor(Math.random() * 10000); requestRender(true); });

$('shareBtn').addEventListener('click', async () => {
  if (state.painting === 'upload') { setStatus('上传的画只在你本地，链接无法带上它；换成内置画作即可分享。', 'err'); return; }
  writeHash();
  try { await navigator.clipboard.writeText(location.href); setStatus('链接已复制，打开即复现这一刻的画、读法、焦点与音色。'); }
  catch { setStatus(location.href); }
});

// 音色预设
const presetRow = $('presetRow');
Object.entries(PRESETS).forEach(([id, p]) => {
  const b = document.createElement('button');
  b.className = 'opt preset-btn' + (id === state.preset ? ' active' : '');
  b.dataset.preset = id;
  b.innerHTML = `${p.name}<small>${p.desc}</small>`;
  b.addEventListener('click', async () => {
    state.preset = id;
    document.querySelectorAll('.preset-btn').forEach(x => x.classList.toggle('active', x.dataset.preset === id));
    writeHash();
    if (engine.limiter) {
      setStatus(`加载音色「${p.name}」……`, 'busy');
      try { await engine.setPreset(id); setStatus(''); }
      catch (e) { setStatus('音色加载失败：' + e.message, 'err'); }
    }
  });
  presetRow.appendChild(b);
});

// 画廊
const gallery = $('gallery');
PAINTINGS.forEach(p => {
  const b = document.createElement('button');
  b.className = 'thumb'; b.dataset.id = p.id;
  b.innerHTML = `<img src="${p.file}" alt="${p.title}"><span>${p.title}</span>`;
  b.addEventListener('click', () => selectPainting(p.id));
  gallery.appendChild(b);
});

function loadImage(src, id, title, keepParams = false) {
  state.painting = id; state.title = title;
  if (!keepParams) { state.focus = null; state.seed = null; }
  state.analysis = null; state.result = null;
  playBtn.disabled = true;
  engine.stop();
  document.querySelectorAll('.thumb').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  hint.hidden = false; hint.textContent = '正在读画……';
  img.onload = () => {
    hint.hidden = true;
    sizeOverlay();
    try {
      state.analysis = analyzeImage(img);
    } catch (e) {
      setStatus('读图失败：' + e.message, 'err');
      return;
    }
    requestRender(true);
  };
  img.onerror = () => { hint.textContent = '图片加载失败'; };
  img.src = src;
}

function selectPainting(id, keepParams = false) {
  const p = PAINTINGS.find(x => x.id === id) || PAINTINGS[0];
  loadImage(p.file, p.id, p.title, keepParams);
}

$('uploadInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const title = f.name.replace(/\.[^.]+$/, '');
  let thumb = gallery.querySelector('[data-id="upload"]');
  if (!thumb) {
    thumb = document.createElement('button');
    thumb.className = 'thumb'; thumb.dataset.id = 'upload';
    thumb.addEventListener('click', () => loadImage(thumb.dataset.src, 'upload', thumb.dataset.title));
    gallery.prepend(thumb);
  }
  thumb.dataset.src = url; thumb.dataset.title = title;
  thumb.innerHTML = `<img src="${url}" alt="${title}"><span>${title}</span>`;
  history.replaceState(null, '', location.pathname);
  loadImage(url, 'upload', title);
});

// ---------- 启动 ----------

readHash();
setScan(state.scan);
setMode(state.mode);
tempoSlider.value = state.tempo; $('tempoVal').textContent = state.tempo;
document.querySelectorAll('.preset-btn').forEach(x => x.classList.toggle('active', x.dataset.preset === state.preset));
selectPainting(state.painting || PAINTINGS[0].id, true);
