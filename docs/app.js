import { analyzeImage, summon, brightestPoint, SCAN_NAMES } from './paint2score.js?v=20261003-1';
import { buildMidi } from './midi.js?v=20261003-1';
import { Engine, PRESETS, INKS } from './sound.js?v=20261003-1';
import { cleanInk, encodeInk, decodeInk, loadWorks, saveWork, removeWork } from './studio-storage.js?v=20261003-1';

import { replayEditPlans, encodeEditPlans, decodeEditPlans, normalizeEditPlans } from './creative-edits.js?v=20261003-1';
import { installCreativeStudio } from './creative-studio.js?v=20261003-1';

const PAINTINGS = [
  { id: 'prism', title: '棱镜', file: 'paintings/prism.jpg' },
  { id: 'mist', title: '蓝雾', file: 'paintings/mist.jpg' },
  { id: 'garden', title: '花园', file: 'paintings/garden.jpg' },
  { id: 'live', title: 'LIVE', file: 'paintings/live.jpg' },
];

const $ = (id) => document.getElementById(id);
const img = $('painting'), overlay = $('overlay'), wrap = $('canvasWrap'), hint = $('canvasHint');
const playBtn = $('playBtn'), stopBtn = $('stopBtn'), nowChord = $('nowChord'), keyReadout = $('keyReadout');
const statusEl = $('status');
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setPressed(button, on) { button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on)); }

const state = {
  painting: null,     // id 或 'upload'
  title: '',
  analysis: null,
  scan: 'ripple',
  focus: null,
  tempo: 80,
  mode: '',
  seed: null,
  preset: 'piano',
  result: null,
  blobUrls: [],
  everPlayed: false,
  tool: 'origin',
  inkKind: 'spark',
  ink: [],
  strokeSeq: 0,
  imageSource: '',
  loadVersion: 0,
  editPlans: [],
  editChanges: [],
};
const engine = new Engine();
window.__gl = { state, engine };
let playIntent = 0;
let creative = null;
let offlineBusy = false;
const anyDialogOpen = () => Boolean(document.querySelector('dialog[open]'));

// 音响起时在画上炸开的光点
const sparks = [];
engine.onNote = (ev, kind) => {
  if (kind === 'melody' && ev.pos) {
    sparks.push({ x: ev.pos[0], y: ev.pos[1], t: performance.now(), note: ev.note, vel: ev.vel, kind });
  } else if (kind === 'bass') {
    sparks.push({ t: performance.now(), kind, vel: ev.vel });
  }
  if (sparks.length > 80) sparks.splice(0, sparks.length - 80);
};
engine.onInk = ev => {
  const mark = state.ink.find(x => x.id === ev.id);
  if (mark) mark.pulse = performance.now();
};

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

// ---------- URL 状态 ----------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('p') && PAINTINGS.some(x => x.id === p.get('p'))) state.painting = p.get('p');
  if (p.get('s') && SCAN_NAMES[p.get('s')]) state.scan = p.get('s');
  if (p.get('f')) { const [a, b] = p.get('f').split(',').map(Number); if (isFinite(a) && isFinite(b)) state.focus = [a, b].map(v => Math.max(0, Math.min(1, v)));  }
  if (p.get('t')) state.tempo = Math.min(120, Math.max(50, parseInt(p.get('t')) || 80));
  if (p.get('m') === 'major' || p.get('m') === 'minor') state.mode = p.get('m');
  if (p.get('k') && PRESETS[p.get('k')]) state.preset = p.get('k');
  if (/^-?\d+$/.test(p.get('seed') || '')) state.seed = Number(p.get('seed')) >>> 0;
  state.ink = decodeInk(p.get('i'));
  try { state.editPlans = decodeEditPlans(p.get('e') || ''); }
  catch { state.editPlans = []; setStatus('分享中的修改记录无效，已打开原始乐谱。', 'err'); }
  state.strokeSeq = Math.max(0, ...state.ink.map(m => m.stroke));
}
function writeHash() {
  if (!state.painting || state.painting === 'upload') return;
  const p = new URLSearchParams();
  p.set('p', state.painting); p.set('s', state.scan);
  if (state.scan === 'ripple' && state.focus) p.set('f', state.focus.join(','));
  p.set('t', state.tempo);
  if (state.mode) p.set('m', state.mode);
  p.set('k', state.preset);
  if (state.seed !== null || state.result) p.set('seed', state.seed ?? state.result.seed);
  if (state.ink.length) p.set('i', encodeInk(state.ink));
  if (state.editPlans.length) p.set('e', encodeEditPlans(state.editPlans));
  history.replaceState(null, '', '#' + p.toString());
}

// ---------- 渲染 ----------

let renderTimer = null;
function requestRender(immediate = false) {
  if (offlineBusy) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(doRender, immediate ? 0 : 200);
}

function doRender() {
  clearTimeout(renderTimer); renderTimer = null;
  if (!state.analysis || offlineBusy) return;
  state.result = summon(state.analysis, {
    scan: state.scan, focus: state.scan === 'ripple' ? state.focus : null,
    tempo: state.tempo, mode: state.mode || null, seed: state.seed,
  });
  state.seed = state.result.seed;
  const edited = replayEditPlans(state.result, state.editPlans);
  state.result = edited.result; state.editChanges = edited.changes;
  if (state.scan === 'ripple') state.focus = state.result.focus;
  updateInkMapping();
  engine.load(state.result);
  engine.setInks(state.ink);
  playBtn.disabled = false;
  keyReadout.textContent = `${state.result.key} · ${state.result.tempo} BPM · ${state.result.bars} 小节`;
  lastPlaybackBar = -1;
  buildDownloads();
  buildChordStrip();
  buildReport();
  sparks.length = 0;
  updateHint();
  drawOverlay();
  writeHash();
  schedulePreload();
  if ($('saveBtn')) $('saveBtn').disabled = false;
  creative?.update();
  if (state.resumeAfterRender) {
    state.resumeAfterRender = false;
    const version = state.loadVersion;
    const intent = playIntent;
    armAudio().then(() => { if (intent === playIntent && version === state.loadVersion && state.result) engine.play(0); }).catch(e => setStatus('音频启动失败：' + e.message, 'err'));
  }
}

function updateHint() {
  if (!state.result) return;
  hint.classList.remove('loading');
  if (state.everPlayed) {
    hint.textContent = '现在在画上点几下，或划一笔';
    hint.hidden = state.tool !== 'ink';
    if (!hint.hidden) setTimeout(() => { if (state.everPlayed) hint.hidden = true; }, 2600);
    return;
  }
  hint.textContent = '点一下，音乐从这里荡开';
  hint.hidden = false;
}

function schedulePreload() {
  if (engine.preset || engine._loading) return;
  engine.setPreset(state.preset).catch(() => {});
}

function buildDownloads() {
  state.blobUrls.forEach(u => URL.revokeObjectURL(u));
  state.blobUrls = [];
  const { melody, chords, bass } = state.result.tracks;
  const ink = state.ink.map(m => [m.beat, m.dur, m.note, m.vel]);
  const bpm = state.result.tempo;
  const stem = (state.title || 'painting').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
  const items = [
    ['combined.mid', '完整乐谱 MIDI', buildMidi([
      ['melody', melody], ['chords', chords], ['bass', bass],
      ...(ink.length ? [['hand-painted', ink]] : []),
    ], bpm)],
    ['melody.mid', '旋律 MIDI', buildMidi([['melody', melody]], bpm)],
    ['chords.mid', '和弦 MIDI', buildMidi([['chords', chords]], bpm)],
    ['bass.mid', '低音 MIDI', buildMidi([['bass', bass]], bpm)],
    ...(ink.length ? [['painted.mid', '我的笔迹 MIDI', buildMidi([['hand-painted', ink]], bpm)]] : []),
  ];
  const box = $('downloads');
  box.innerHTML = '';
  items.forEach(([name, label, blob]) => {
    const url = URL.createObjectURL(blob);
    state.blobUrls.push(url);
    const a = document.createElement('a');
    a.href = url; a.download = `${stem}-${name}`; a.textContent = label;
    a.addEventListener('click', () => creative?.record('midi_download_clicked', { track: name.replace('.mid', '') }));
    if (name === 'combined.mid') a.className = 'primary-download';
    box.appendChild(a);
  });
  const png = document.createElement('button');
  png.textContent = '分析标注图 PNG';
  png.addEventListener('click', exportAnnotated);
  box.appendChild(png);
  const postcard = document.createElement('button');
  postcard.textContent = '音乐明信片 PNG';
  postcard.addEventListener('click', exportPostcard);
  box.appendChild(postcard);
}

function buildChordStrip() {
  const box = $('chordStrip');
  box.innerHTML = '';
  state.result.chords.forEach((c, i) => {
    const chip = document.createElement('button');
    chip.className = 'chord-chip';
    chip.textContent = `${i + 1}·${c.label}`;
    chip.type = 'button';
    chip.title = '从这一小节开始播放';
    chip.setAttribute('aria-label', `从第 ${i + 1} 小节 ${c.label} 开始播放`);
    chip.addEventListener('click', async () => {
      const version = state.loadVersion;
      const intent = ++playIntent;
      try { await armAudio(); if (intent === playIntent && version === state.loadVersion && state.result) engine.play(i * 4); }
      catch (e) { setStatus('音频启动失败：' + e.message, 'err'); }
    });
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
    <h2>${escapeHtml(state.title)} 的读画报告</h2>
    <p class="lede">
      扫描方式 <b>${SCAN_NAMES[r.scan]}</b>${focusTxt}（每小节读掉等量的颜料）。
      全画主色相 <b>${g.hue.toFixed(0)}°</b>（饱和度加权，灰色不投票）。
      冷暖 ${g.warmth.toFixed(2)}、明度 ${g.brightness.toFixed(2)} → 调式判定分 ${g.modeScore.toFixed(2)}（&gt;0.5 大调）→ <b>${r.tonic} ${modeCn}</b>。
      ${r.tempo} BPM，${r.bars} 小节，种子 ${r.seed}。
      ${state.editPlans.length ? '<br><b>这份表记录原始读画依据；当前乐谱还应用了以下修改：</b>' + state.editChanges.map(escapeHtml).join('；') : ''}
    </p>
    <table class="bar-table">
      <thead><tr><th>小节</th><th>色相</th><th>饱和</th><th>明度</th><th>细节</th><th>和弦</th><th>级数</th><th class="why">为什么</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details>
      <summary>五分钟乐理（这份报告用到的全部概念）</summary>
      <ul class="theory">
        <li><b>调 (Key)</b>：全曲的引力中心。这幅画是 ${r.tonic} ${modeCn}，${r.tonic} 听起来最像"家"。</li>
        <li><b>音级和弦</b>：大调常用 I ii iii IV V vi，小调常用 i III iv v VI VII。大写 = 大和弦，小写 = 小和弦。基础三和弦来自当前音阶；高饱和度还会加入更有张力的扩展音。</li>
        <li><b>属功能</b>：离家最远、最想回家的和弦；每 4 小节拉一次，就是终止式的引力。</li>
        <li><b>7 音 / 9 音</b>：往和弦上加盖，声音变复杂变湿润。饱和度高就多盖一层。</li>
        <li><b>和弦音 vs 经过音</b>：强拍踩和弦音（稳），弱拍可以踩音阶其他音（流动）。</li>
        <li><b>音区</b>：同一个音名在不同八度。亮的区域住高处，暗的住低处。</li>
      </ul>
    </details>`;
}

let lastPlaybackBar = -1;
let lastPlaybackActive = null;
let lastProgressAt = 0;
function colorName(hue, sat) {
  if (sat < 0.12) return '轻淡的灰调';
  return ['红色', '橙色', '黄色', '草绿色', '绿色', '青绿色', '青色', '湖蓝色', '蓝色', '紫色', '紫红色', '玫红色'][Math.round(hue / 30) % 12];
}
function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function updatePlaybackReadout(bar, beat, active) {
  const r = state.result;
  if (bar !== lastPlaybackBar || active !== lastPlaybackActive) {
    lastPlaybackBar = bar;
    lastPlaybackActive = active;
    const feat = r.barFeats[bar], chord = r.chords[bar];
    const departure = r.departures?.[bar] ?? 0;
    const hueStory = bar === 0 ? '第一小节先让和弦安家' : bar === r.bars - 1 ? '最后一小节让和弦回家'
      : bar % 4 === 3 ? '到了乐句转弯处，和弦带出一点期待'
      : departure < 0.34 ? '接近全画的色彩基调，和弦更安定' : departure < 0.67 ? '颜色开始变化，和弦也向外走一步' : '颜色偏离全画基调，和弦带出更强的张力';
    const brightness = feat.val > 0.65 ? '画面较亮，旋律向高处走' : feat.val < 0.35 ? '画面较暗，旋律落在较低的音区' : '适中的亮度，让旋律停在中间音区';
    const detail = ['细节舒缓，音符留出呼吸', '细节渐多，节奏轻轻流动', '细节丰富，音符更密一些', '纹理最密，节奏也变得活泼'][Math.min(3, Math.floor(feat.edge * 4))];
    if ($('barLabel')) $('barLabel').textContent = `第 ${bar + 1} / ${r.bars} 小节 · ${chord.label}`;
    if ($('barStory')) $('barStory').textContent = `${colorName(feat.hue, feat.sat)}：${hueStory}。${brightness}；${detail}。${state.editPlans.length ? ' 以上是原始读画依据；当前声音还保留了你的局部修改。' : ''}`;
    if ($('barSwatch')) $('barSwatch').style.background = hsvToCss(feat.hue, feat.sat, feat.val);
    nowChord.textContent = active && chord ? `${chord.label}（${chord.degree}）` : '';
    document.querySelectorAll('.chord-chip').forEach((chip, i) => {
      chip.classList.toggle('playing', active && i === bar);
      if (active && i === bar) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
    });
    document.querySelectorAll('.bar-table tr[data-bar]').forEach(tr => tr.classList.toggle('playing', active && +tr.dataset.bar === bar));
  }
  const now = performance.now();
  if (now - lastProgressAt > 100 || !active) {
    lastProgressAt = now;
    if ($('progressFill')) $('progressFill').style.width = `${beat / (r.bars * 4) * 100}%`;
    if ($('timeReadout')) $('timeReadout').textContent = `${formatTime(beat * 60 / r.tempo)} / ${formatTime(r.bars * 4 * 60 / r.tempo)}`;
  }
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
  if (!state.result || offlineBusy || creative?.comparing) return;
  const ctx = overlay.getContext('2d');
  const W = overlay.width / dpr, H = overlay.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const playing = engine.playing;
  const totalBeats = state.result.bars * 4;
  const beat = totalBeats > 0 ? ((engine.beat % totalBeats) + totalBeats) % totalBeats : 0;
  const bar = drawGeometry(ctx, W, H, state.result.geometry, beat, playing);
  const active = playing || beat > 0;
  drawInk(ctx, W, H);
  drawSparks(ctx, W, H);
  if (!playing && !reducedMotion) drawIdleRing(ctx, W, H);
  updatePlaybackReadout(bar, beat, active);
}

const SPARK_LIFE = 1400;
function drawInk(ctx, W, H, scale = 1) {
  if (!state.ink.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 连续拖动形成的点属于同一笔；画出一条真正留在画上的彩色声部。
  for (let i = 1; i < state.ink.length; i++) {
    const a = state.ink[i - 1], b = state.ink[i];
    if (a.stroke !== b.stroke || a.kind !== b.kind) continue;
    ctx.strokeStyle = INKS[b.kind].color + 'cc';
    ctx.lineWidth = 3.2 * scale;
    ctx.shadowColor = INKS[b.kind].color;
    ctx.shadowBlur = 5 * scale;
    ctx.beginPath();
    ctx.moveTo(a.x * W, a.y * H);
    ctx.lineTo(b.x * W, b.y * H);
    ctx.stroke();
  }

  const now = performance.now();
  for (const m of state.ink) {
    const color = INKS[m.kind].color;
    const x = m.x * W, y = m.y * H;
    ctx.shadowColor = color;
    ctx.shadowBlur = 7 * scale;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * scale, 0, Math.PI * 2);
    ctx.fill();
    if (m.pulse) {
      const age = Math.min(1, (now - m.pulse) / 850);
      if (age < 1) {
        ctx.shadowBlur = 12 * scale;
        ctx.strokeStyle = color + Math.round((1 - age) * 220).toString(16).padStart(2, '0');
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.arc(x, y, (5 + age * 18) * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawSparks(ctx, W, H) {
  const now = performance.now();
  for (let i = sparks.length - 1; i >= 0; i--) {
    if (now - sparks[i].t > SPARK_LIFE) sparks.splice(i, 1);
  }
  const geo = state.result.geometry;
  const base = Math.min(W, H);
  for (const s of sparks) {
    const age = (now - s.t) / SPARK_LIFE;
    const ease = 1 - Math.pow(1 - age, 3);
    if (s.kind === 'bass') {
      // 低音：从焦点/画面中心推出去一圈很淡的光环
      const [fx, fy] = geo.type === 'ripple' ? geo.focus : [0.5, 0.5];
      ctx.strokeStyle = `rgba(165, 180, 252, ${0.35 * (1 - age)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(fx * W, fy * H, 8 + ease * base * 0.35, 0, Math.PI * 2); ctx.stroke();
      continue;
    }
    // 旋律：在它来自的位置炸开。色相 = 音级（色相是调），大小 = 力度
    const hue = ((s.note % 12) * 30 + 200) % 360;
    const size = (6 + (s.vel / 127) * 10) * (base / 480);
    const x = s.x * W, y = s.y * H;
    const r = size * (0.6 + ease * 2.2);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `hsla(${hue}, 95%, 85%, ${0.95 * (1 - age)})`);
    grad.addColorStop(0.35, `hsla(${hue}, 90%, 70%, ${0.55 * (1 - age)})`);
    grad.addColorStop(1, `hsla(${hue}, 90%, 60%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    // 核心亮点
    ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - age) ** 2})`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(1, size * 0.28 * (1 - age)), 0, Math.PI * 2); ctx.fill();
  }
}

function drawIdleRing(ctx, W, H) {
  const geo = state.result.geometry;
  const [fx, fy] = geo.type === 'ripple' ? geo.focus : (state.analysis.bright || [0.5, 0.5]);
  const t = (performance.now() % 1800) / 1800;
  const base = Math.min(W, H);
  for (const k of [0, 0.5]) {
    const p = (t + k) % 1;
    ctx.strokeStyle = `rgba(251, 191, 36, ${0.7 * (1 - p)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(fx * W, fy * H, 6 + p * base * 0.09, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(251, 191, 36, .95)';
  ctx.beginPath(); ctx.arc(fx * W, fy * H, 3.5, 0, Math.PI * 2); ctx.fill();
}

let lastDrawAt = 0;
function tick(now) {
  if (!document.hidden && now - lastDrawAt >= (reducedMotion ? 100 : 30)) { drawOverlay(); lastDrawAt = now; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function exportAnnotated() {
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  drawGeometry(ctx, W, H, state.result.geometry, 0, false, true, Math.max(1, W / 640));
  drawInk(ctx, W, H, Math.max(1, W / 640));
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

function exportPostcard() {
  if (!state.result) return;
  const cv = document.createElement('canvas');
  const W = 1080, margin = 64;
  const pictureW = W - margin * 2;
  const pictureH = Math.round(Math.min(1000, pictureW * img.naturalHeight / img.naturalWidth));
  cv.width = W; cv.height = pictureH + 324;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff9eb'; ctx.fillRect(0, 0, W, cv.height);
  ctx.fillStyle = '#827762'; ctx.font = '500 20px sans-serif';
  ctx.fillText('GRADIENT LAB  /  A LITTLE PIECE OF SOUND', margin, 56);
  ctx.save();
  ctx.translate(margin, 88);
  // Fit rather than stretch panoramic or tall uploaded paintings.
  const fit = Math.min(pictureW / img.naturalWidth, pictureH / img.naturalHeight);
  const drawW = img.naturalWidth * fit, drawH = img.naturalHeight * fit;
  const x = (pictureW - drawW) / 2, imageY = (pictureH - drawH) / 2;
  ctx.fillStyle = '#eee8d9'; ctx.fillRect(0, 0, pictureW, pictureH);
  ctx.drawImage(img, x, imageY, drawW, drawH);
  ctx.translate(x, imageY); drawInk(ctx, drawW, drawH, 1.5); ctx.restore();
  const y = pictureH + 144;
  ctx.fillStyle = '#423d32'; ctx.font = '600 38px "PingFang SC", sans-serif';
  let title = state.title;
  while (ctx.measureText(title).width > pictureW && title.length > 1) title = title.slice(0, -2) + '…';
  ctx.fillText(title, margin, y);
  ctx.fillStyle = '#827762'; ctx.font = '23px "PingFang SC", sans-serif';
  ctx.fillText(`${state.result.key}  ·  ${state.tempo} BPM  ·  ${PRESETS[state.preset].name}`, margin, y + 44);
  ctx.font = '20px "PingFang SC", sans-serif';
  ctx.fillText('我把一幅画，留成了一小段声音。', margin, y + 90);
  const swatches = state.result.barFeats;
  const dotW = 15, startX = W - margin - swatches.length * 22;
  swatches.forEach((f, i) => { ctx.fillStyle = hsvToCss(f.hue, f.sat, f.val); ctx.fillRect(startX + i * 22, y + 76, dotW, dotW); });
  cv.toBlob(blob => {
    if (!blob) { setStatus('明信片暂时没有生成，请再试一次。', 'err'); return; }
    const url = URL.createObjectURL(blob);
    const dialog = $('postcardDialog');
    const preview = $('postcardPreview');
    const link = $('postcardDownload');
    const previousFocus = document.activeElement;
    preview.src = url;
    preview.alt = `${state.title}的音乐明信片`;
    link.href = url;
    link.download = `${state.title.replace(/[\\/:*?"<>|]/g, '_')}-音乐明信片.png`;
    $('postcardClose').onclick = () => dialog.close();
    dialog.onclose = () => {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      previousFocus?.focus();
    };
    link.onclick = () => setStatus('明信片已交给浏览器保存。想继续编曲，也可以带走完整 MIDI。');
    dialog.showModal();
    setStatus('你的音乐明信片做好了。');
  }, 'image/png');
}

// ---------- 音频 ----------

let arming = null;
async function armAudio() {
  if (offlineBusy) throw new Error('正在制作音频，请稍等。');
  if (!arming) {
    const requestedPreset = state.preset;
    arming = (async () => {
      await engine.ensureStarted();
      if (engine.presetName !== requestedPreset) {
        if (state.preset === requestedPreset) setStatus(`加载音色「${PRESETS[requestedPreset].name}」……`, 'busy');
        await engine.setPreset(requestedPreset);
        if (state.preset === requestedPreset) setStatus('');
      } else {
        await engine.ready;
      }
    })().finally(() => { arming = null; });
  }
  await arming;
  // A newer preset may have been selected while the first load was pending.
  if (engine.presetName !== state.preset) return armAudio();
  await engine.ready;
}

playBtn.addEventListener('click', async () => {
  if (offlineBusy || anyDialogOpen()) return;
  try {
    const intent = ++playIntent;
    const version = state.loadVersion;
    if (engine.playing) { engine.pause(); return; }
    playBtn.setAttribute('aria-busy', 'true');
    playBtn.textContent = '准备声音…';
    await armAudio();
    if (intent === playIntent && version === state.loadVersion && state.result) {
      playBtn.removeAttribute('aria-busy');
      creative?.record('playback_started');
      engine.toggle();
    }
  } catch (e) {
    playBtn.removeAttribute('aria-busy');
    playBtn.textContent = '▶ 再试一次';
    setStatus('音频启动失败：' + e.message, 'err');
  }
});
stopBtn.addEventListener('click', () => { playIntent++; playBtn.removeAttribute('aria-busy'); state.resumeAfterRender = false; engine.stop(); });
engine.onState = (playing) => {
  playBtn.textContent = playing ? '❚❚ 暂停' : playBtn.hasAttribute('aria-busy') ? '准备声音…' : '▶ 听听这幅画';
  playBtn.setAttribute('aria-pressed', String(playing));
  lastPlaybackBar = -1;
  if (playing && !state.everPlayed) { state.everPlayed = true; hint.hidden = true; }
};

// ---------- 交互 ----------

function canvasPoint(e) {
  const r = overlay.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  ];
}

function pointToBeat(x, y) {
  const geo = state.result.geometry;
  let value;
  if (geo.type === 'lr') value = x;
  else if (geo.type === 'tb') value = y;
  else {
    const aspect = state.analysis.h / state.analysis.w;
    value = Math.hypot(x - geo.focus[0], (y - geo.focus[1]) * aspect);
  }
  const b = geo.bounds;
  let bar = b.length - 2;
  for (let i = 0; i < b.length - 1; i++) {
    if (value <= b[i + 1]) { bar = i; break; }
  }
  const frac = Math.max(0, Math.min(1, (value - b[bar]) / Math.max(1e-6, b[bar + 1] - b[bar])));
  return Math.min(state.result.bars * 4 - 0.01, (bar + frac) * 4);
}

function pointToPitch(y, kind) {
  const scale = state.result.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const tonic = state.result.global.tonicPc;
  const target = kind === 'root' ? 57 - y * 17 : 86 - y * 34;
  let best = 60, dist = Infinity;
  const lo = kind === 'root' ? 36 : 48;
  const hi = kind === 'root' ? 62 : 88;
  for (let n = lo; n <= hi; n++) {
    if (!scale.includes(((n - tonic) % 12 + 12) % 12)) continue;
    const d = Math.abs(n - target);
    if (d < dist) { best = n; dist = d; }
  }
  return best;
}

function updateInkMapping() {
  if (!state.result) return;
  for (const m of state.ink) {
    m.beat = pointToBeat(m.x, m.y);
    m.note = pointToPitch(m.y, m.kind);
  }
}

let inkSyncTimer = null;
function syncInk(immediate = false) {
  clearTimeout(inkSyncTimer);
  inkSyncTimer = setTimeout(() => {
    engine.setInks(state.ink);
    if (state.result) buildDownloads();
    writeHash();
  }, immediate ? 0 : 80);
}

function setTool(tool) {
  state.tool = tool;
  setPressed(document.querySelector('.origin-tool'), tool === 'origin');
  document.querySelectorAll('.ink-swatch').forEach(b => setPressed(b, tool === 'ink' && b.dataset.ink === state.inkKind));
  $('paintTools').classList.toggle('ready', state.everPlayed || tool === 'ink');
  wrap.classList.toggle('inking', tool === 'ink');
}

async function chooseOrigin(point) {
  if (offlineBusy || anyDialogOpen()) return;
  creative?.changed();
  const intent = ++playIntent;
  const version = state.loadVersion;
  const audioReady = armAudio(); // 必须在用户手势内启动 AudioContext
  state.focus = point;
  if (state.scan !== 'ripple') setScan('ripple');
  clearTimeout(renderTimer);
  doRender();
  try {
    await audioReady;
    if (intent !== playIntent || version !== state.loadVersion || !state.result) return;
    engine.play(0);
    setTool('ink');
    hint.textContent = '现在在画上点几下，或划一笔';
    hint.hidden = false;
    setTimeout(() => { hint.hidden = true; }, 2600);
  } catch (err) {
    setStatus('音频启动失败：' + err.message, 'err');
  }
}

function addInkPoint(point, stroke) {
  if (offlineBusy || anyDialogOpen()) return;
  creative?.changed();
  // Keep the drawn and shared coordinates identical (not only visually close).
  const [x, y] = point.map(value => Math.round(value * 255) / 255);
  const previous = state.ink[state.ink.length - 1];
  if (previous && previous.stroke === stroke && Math.hypot(previous.x - x, previous.y - y) < 0.012) return;
  const kind = state.inkKind;
  const mark = {
    id: `${Date.now().toString(36)}-${state.ink.length}`,
    stroke, kind, x, y,
    beat: pointToBeat(x, y),
    note: pointToPitch(y, kind),
    dur: kind === 'mist' ? 2.2 : kind === 'root' ? 1.35 : 0.55,
    vel: kind === 'mist' ? 72 : kind === 'root' ? 92 : 98,
    pulse: performance.now(),
  };
  state.ink.push(mark);
  if (state.ink.length > 240) state.ink.splice(0, state.ink.length - 240);
  armAudio().then(() => { if (!offlineBusy && !anyDialogOpen()) engine.triggerInk(mark); }).catch(err => setStatus('点色失败：' + err.message, 'err'));
  syncInk();
}

let drawing = false;
let activeStroke = 0;
overlay.addEventListener('pointerdown', e => {
  if (!state.analysis || !state.result) return;
  e.preventDefault();
  const point = canvasPoint(e);
  if (state.tool === 'origin') {
    chooseOrigin(point);
    return;
  }
  drawing = true;
  activeStroke = ++state.strokeSeq;
  try { overlay.setPointerCapture(e.pointerId); } catch { /* synthetic events / older Safari */ }
  addInkPoint(point, activeStroke);
});
overlay.addEventListener('pointermove', e => {
  if (!drawing || state.tool !== 'ink') return;
  const coalesced = e.getCoalescedEvents?.();
  for (const p of (coalesced?.length ? coalesced : [e])) addInkPoint(canvasPoint(p), activeStroke);
});
overlay.addEventListener('pointerup', e => {
  if (!drawing) return;
  drawing = false;
  try { if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId); } catch {}
  syncInk(true);
});
overlay.addEventListener('pointercancel', () => { drawing = false; syncInk(true); });

document.querySelector('.origin-tool').addEventListener('click', () => {
  setTool('origin');
  hint.textContent = '点一下，重新选择音乐荡开的起点';
  hint.hidden = false;
});
document.querySelectorAll('.ink-swatch').forEach(btn => btn.addEventListener('click', () => {
  state.inkKind = btn.dataset.ink;
  document.querySelectorAll('.ink-swatch').forEach(x => setPressed(x, x === btn));
  setTool('ink');
  setStatus(`${INKS[state.inkKind].name} · ${INKS[state.inkKind].desc}：在画上点或划`);
  if (state.result) {
    const kind = state.inkKind;
    const note = pointToPitch(0.5, kind);
    armAudio().then(() => { if (!offlineBusy && !anyDialogOpen()) engine.triggerInk({ kind, note, dur: kind === 'mist' ? 1.2 : 0.4, vel: 64 }); })
      .catch(e => setStatus('试听暂未启动：' + e.message, 'err'));
  }
}));
$('inkUndo').addEventListener('click', () => {
  const last = state.ink[state.ink.length - 1]?.stroke;
  if (last === undefined) return;
  state.ink = state.ink.filter(m => m.stroke !== last);
  syncInk(true);
});
$('inkClear').addEventListener('click', () => {
  state.ink = [];
  syncInk(true);
});

function setScan(scan) {
  state.scan = scan;
  document.querySelectorAll('.scan-btn').forEach(b => setPressed(b, b.dataset.scan === scan));
  $('rippleTip').hidden = scan !== 'ripple';
}
document.querySelectorAll('.scan-btn').forEach(btn => btn.addEventListener('click', () => {
  setScan(btn.dataset.scan);
  setTool('ink');
  requestRender(true);
}));

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => setPressed(b, b.dataset.mode === mode));
}
document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => { setMode(btn.dataset.mode); requestRender(true); }));

const tempoSlider = $('tempoSlider');
tempoSlider.addEventListener('input', () => {
  state.tempo = parseInt(tempoSlider.value);
  $('tempoVal').textContent = state.tempo;
  requestRender();
});

$('rerollBtn').textContent = '换点演奏表情';
$('rerollBtn').addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 10000); requestRender(true);
  setStatus('保留旋律与和弦，只轻轻改变演奏力度和落键时机。');
});

$('shareBtn').addEventListener('click', async () => {
  if (state.painting === 'upload') { setStatus('上传的画只在你本地，链接无法带上它；换成内置画作即可分享。', 'err'); return; }
  writeHash();
  creative?.record('share_requested');
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus(state.ink.length ? '链接已复制，画作、读法、音色和你的笔迹都在里面。' : '链接已复制，打开即可还原这幅画的声音。');
  }
  catch { setStatus(location.href); }
});

// 音色预设
const presetRow = $('presetRow');
Object.entries(PRESETS).forEach(([id, p]) => {
  const b = document.createElement('button');
  b.className = 'opt preset-btn' + (id === state.preset ? ' active' : '');
  b.dataset.preset = id; b.setAttribute('aria-pressed', String(id === state.preset));
  b.innerHTML = `${p.name}<small>${p.desc}</small>`;
  b.addEventListener('click', async () => {
    state.preset = id;
    document.querySelectorAll('.preset-btn').forEach(x => setPressed(x, x.dataset.preset === id));
    writeHash();
    if (engine.limiter) {
      setStatus(`加载音色「${p.name}」……`, 'busy');
      try { await engine.setPreset(id); if (state.preset === id) setStatus(''); }
      catch (e) { if (state.preset === id) setStatus('音色加载失败：' + e.message, 'err'); }
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

async function loadImage(src, id, title, keepParams = false, restoredInk = []) {
  if (offlineBusy) return false;
  creative?.changed();
  const version = ++state.loadVersion;
  clearTimeout(renderTimer);
  clearTimeout(inkSyncTimer);
  drawing = false;
  state.painting = id;
  if (id === 'upload') history.replaceState(null, '', location.pathname + location.search);
  state.title = String(title).slice(0, 120);
  state.imageSource = src;
  if (!keepParams) { state.focus = null; state.seed = null; state.editPlans = []; state.editChanges = []; }
  previousRecipe = null;
  if ($('undoSurpriseBtn')) $('undoSurpriseBtn').hidden = true;
  state.ink = cleanInk(restoredInk);
  state.strokeSeq = Math.max(0, ...state.ink.map(m => m.stroke));
  setTool('origin');
  state.analysis = null; state.result = null;
  creative?.update();
  playBtn.removeAttribute('aria-busy');
  playBtn.disabled = true;
  if ($('saveBtn')) $('saveBtn').disabled = true;
  state.resumeAfterRender = engine.playing || state.resumeAfterRender;
  engine.stop();
  document.querySelectorAll('.thumb').forEach(t => setPressed(t, t.dataset.id === id));
  hint.hidden = false; hint.textContent = '正在读画……'; hint.classList.add('loading');
  const candidate = new Image();
  try {
    await new Promise((resolve, reject) => {
      candidate.onload = resolve;
      candidate.onerror = () => reject(new Error('图片无法打开，请试试 JPG、PNG 或 WebP。'));
      candidate.src = src;
    });
    if (version !== state.loadVersion) return false;
    if (!candidate.naturalWidth || !candidate.naturalHeight) throw new Error('这张图片没有可读取的尺寸。');
    if (candidate.naturalWidth * candidate.naturalHeight > 40000000) throw new Error('这张图尺寸太大，请缩小到 4000 万像素以内。');
    // Freeze uploaded images into a small local copy before analysis. The
    // sketchbook then reopens this exact source instead of re-compressing it
    // and silently changing the music on each save / restore.
    if (id === 'upload' && src.startsWith('blob:')) {
      src = compressImage(candidate);
      await new Promise((resolve, reject) => {
        candidate.onload = resolve;
        candidate.onerror = () => reject(new Error('图片压缩失败，请换一张试试。'));
        candidate.src = src;
      });
      if (version !== state.loadVersion) return false;
      state.imageSource = src;
      setUploadThumb(src, state.title);
    }
    state.analysis = analyzeImage(candidate);
    state.analysis.bright = brightestPoint(state.analysis);
    img.src = src;
    img.alt = state.title;
    await img.decode().catch(() => {});
    if (version !== state.loadVersion) return false;
    sizeOverlay();
    requestRender(true);
    return true;
  } catch (e) {
    if (version !== state.loadVersion) return false;
    state.resumeAfterRender = false;
    hint.classList.remove('loading');
    hint.textContent = '没能读懂这张图，换一张试试？';
    setStatus('读图失败：' + e.message, 'err');
    return false;
  }
}

function selectPainting(id, keepParams = false, restoredInk = []) {
  const p = PAINTINGS.find(x => x.id === id) || PAINTINGS[0];
  return loadImage(p.file, p.id, p.title, keepParams, restoredInk);
}

$('uploadInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) openFile(f);
  e.target.value = '';
});

// 把图拖到页面任何地方
const veil = $('dropVeil');
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); if (offlineBusy || anyDialogOpen()) return; dragDepth++; veil.classList.add('on'); });
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; veil.classList.remove('on'); } });
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; veil.classList.remove('on');
  if (offlineBusy || anyDialogOpen()) return;
  const f = [...(e.dataTransfer.files || [])].find(x => x.type.startsWith('image/'));
  if (f) openFile(f);
});
document.addEventListener('paste', e => {
  if (offlineBusy || anyDialogOpen()) return;
  const item = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith('image/'));
  if (item) openFile(item.getAsFile());
});

let currentUploadUrl = null;
function setUploadThumb(src, title) {
  let thumb = gallery.querySelector('[data-id="upload"]');
  if (!thumb) {
    thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'thumb'; thumb.dataset.id = 'upload';
    thumb.addEventListener('click', () => loadImage(thumb.dataset.src, 'upload', thumb.dataset.title));
    gallery.prepend(thumb);
  }
  thumb.dataset.src = src;
  thumb.dataset.title = title;
  const preview = document.createElement('img');
  preview.src = src; preview.alt = title;
  const label = document.createElement('span');
  label.textContent = title;
  thumb.replaceChildren(preview, label);
}

function openFile(f) {
  if (!f || offlineBusy || anyDialogOpen()) return;
  creative?.record('image_uploaded');
  if (!/^image\/(jpeg|png|webp|gif|avif|bmp)$/.test(f.type)) {
    setStatus('请选择 JPG、PNG、WebP、GIF、AVIF 或 BMP 图片；动图会读入其中一帧。', 'err');
    return;
  }
  if (f.size > 20 * 1024 * 1024) {
    setStatus('这张图超过 20 MB，请先缩小一点再带进来。', 'err');
    return;
  }
  const url = URL.createObjectURL(f);
  const previousUrl = currentUploadUrl;
  currentUploadUrl = url;
  const title = (f.name.replace(/\.[^.]+$/, '') || '我的画').slice(0, 120);
  setUploadThumb(url, title);
  history.replaceState(null, '', location.pathname + location.search);
  setStatus('你的图片只在这台设备中读画，不会上传。');
  loadImage(url, 'upload', title).finally(() => { if (previousUrl) URL.revokeObjectURL(previousUrl); });
  $('lab').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

// ---------- 灵感配方与本机小抽屉 ----------
const RECIPES = [
  { name: '浮光慢慢', preset: 'ice', scan: 'ripple', tempo: 64, mode: '', story: '让玻璃般的钟声从画里荡开，慢一点，听颜色留下的余韵。' },
  { name: '林间散步', preset: 'forest', scan: 'lr', tempo: 78, mode: '', story: '用温柔的木质音色从左向右读画，像沿着一条小路散步。' },
  { name: '纸上节拍', preset: 'machine', scan: 'tb', tempo: 108, mode: '', story: '从上往下翻阅画面，让细节变成轻快的电子节拍。' },
];
let recipeIndex = 0;
let previousRecipe = null;
function applySettings(settings) {
  state.scan = settings.scan; state.mode = settings.mode;
  state.tempo = settings.tempo; state.preset = settings.preset;
  state.seed = settings.seed ?? null;
  if ('editPlans' in settings) state.editPlans = normalizeEditPlans(settings.editPlans || []);
  if ('focus' in settings) state.focus = settings.focus;
  setScan(state.scan); setMode(state.mode);
  tempoSlider.value = state.tempo; $('tempoVal').textContent = state.tempo;
  document.querySelectorAll('.preset-btn').forEach(b => setPressed(b, b.dataset.preset === state.preset));
}
function currentSettings() {
  return { scan: state.scan, mode: state.mode, tempo: state.tempo, preset: state.preset,
    seed: state.seed ?? state.result?.seed ?? null, focus: state.focus ? [...state.focus] : null,
    editPlans: normalizeEditPlans(state.editPlans) };
}
async function changeRecipe(settings, description) {
  const intent = playIntent;
  const version = state.loadVersion;
  const wasPlaying = engine.playing;
  applySettings(settings);
  doRender();
  setStatus(description);
  if (engine.limiter) {
    const preset = state.preset;
    try { await engine.setPreset(preset); if (intent === playIntent && version === state.loadVersion && state.preset === preset && wasPlaying) engine.play(0); }
    catch (e) { setStatus('音色暂未加载：' + e.message, 'err'); }
  }
}
$('surpriseBtn')?.addEventListener('click', () => {
  if (!state.result) return;
  previousRecipe = currentSettings();
  const recipe = RECIPES[recipeIndex++ % RECIPES.length];
  changeRecipe({ ...recipe, seed: state.seed ?? state.result.seed }, `灵感配方「${recipe.name}」：${recipe.story} 你的画和笔迹都还在。`);
  if ($('undoSurpriseBtn')) $('undoSurpriseBtn').hidden = false;
});
$('undoSurpriseBtn')?.addEventListener('click', () => {
  if (!previousRecipe || !state.result) return;
  changeRecipe(previousRecipe, '已回到灵感配方之前的声音。');
  previousRecipe = null;
  $('undoSurpriseBtn').hidden = true;
});

function compressImage(source) {
  const ratio = Math.min(1, 640 / Math.max(source.naturalWidth, source.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(source.naturalWidth * ratio));
  cv.height = Math.max(1, Math.round(source.naturalHeight * ratio));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(source, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.8);
}
function imageForStorage() {
  return state.painting === 'upload' ? state.imageSource : compressImage(img);
}

function renderSavedWorks(works) {
  const box = $('savedWorks');
  if (!box) return;
  try { works ??= loadWorks(); }
  catch { box.textContent = '暂时无法读取本机小抽屉，仍可下载作品带走。'; return; }
  box.replaceChildren();
  if (!works.length) {
    const empty = document.createElement('p');
    empty.className = 'saved-empty';
    empty.textContent = '这里还空着。收藏一幅会唱歌的画吧，只存这台设备，最多 8 份。';
    box.appendChild(empty);
    return;
  }
  for (const work of works) {
    const card = document.createElement('article');
    card.className = 'saved-card';
    const open = document.createElement('button');
    open.className = 'saved-open'; open.type = 'button';
    open.setAttribute('aria-label', `打开作品：${work.title}`);
    const thumb = document.createElement('img');
    thumb.src = work.image || PAINTINGS.find(p => p.id === work.painting)?.file;
    thumb.alt = ''; thumb.loading = 'lazy';
    const name = document.createElement('strong'); name.textContent = work.title;
    const detail = document.createElement('small');
    detail.textContent = `${PRESETS[work.preset].name} · ${work.tempo} BPM · ${new Date(work.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;
    open.append(thumb, name, detail);
    open.addEventListener('click', async () => {
      creative?.record('work_restored');
      applySettings(work);
      if (work.painting === 'upload') {
        setUploadThumb(work.image, work.title);
        history.replaceState(null, '', location.pathname + location.search);
      }
      const src = work.painting === 'upload' ? work.image : PAINTINGS.find(p => p.id === work.painting).file;
      const loaded = await loadImage(src, work.painting, work.title, true, work.ink);
      if (loaded) {
        setStatus(`已打开「${work.title}」，参数和笔迹也回来了。`);
        if (engine.limiter) engine.setPreset(state.preset).catch(e => setStatus('音色暂未加载：' + e.message, 'err'));
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'saved-delete'; remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除本机作品：${work.title}`);
    remove.addEventListener('click', () => {
      try { renderSavedWorks(removeWork(work.id)); setStatus(`已从这台设备移除「${work.title}」。`); }
      catch { setStatus('这次没能删除，请检查浏览器是否允许本地存储。', 'err'); }
    });
    card.append(open, remove); box.appendChild(card);
  }
}
$('saveBtn')?.addEventListener('click', () => {
  if (!state.result) return;
  try {
    const works = saveWork({ ...currentSettings(), id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(), painting: state.painting, title: state.title,
      image: imageForStorage(), ink: state.ink });
    renderSavedWorks(works);
    creative?.record('work_saved');
    setStatus(`已收藏到本机小抽屉（${works.length}/8）。清除浏览器数据会移除它，喜欢的话也下载一份吧。`);
  } catch (e) { setStatus(e.message || '这次没能保存，仍可下载作品带走。', 'err'); }
});
window.addEventListener('storage', e => { if (e.key === 'gradient-lab:sketchbook:v1') renderSavedWorks(); });

// Leave native buttons, sliders and inputs their own keyboard behavior.
document.addEventListener('keydown', e => {
  if (offlineBusy || anyDialogOpen()) return;
  if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, button, a, summary, [contenteditable="true"]')) return;
  if (!state.result) return;
  e.preventDefault(); playBtn.click();
});
overlay.tabIndex = 0;
overlay.setAttribute('role', 'button');
overlay.setAttribute('aria-label', '音乐画布。按回车从画面中心开始，按空格播放或暂停；也可用鼠标或触摸作画。');
overlay.addEventListener('keydown', e => {
  if (e.key === 'Enter' && state.result) { e.preventDefault(); chooseOrigin(state.focus || [0.5, 0.5]); }
});

// Section navigation should not erase the reproducible composition in the URL.
document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', e => {
  const id = link.getAttribute('href').slice(1);
  const target = id ? $(id) : null;
  if (!id || target) {
    e.preventDefault();
    if (target) target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }
}));

// All score-changing controls invalidate in-flight model proposals. Capture runs
// before their individual handlers, including dynamically created gallery cards.
document.addEventListener('click', event => {
  if (event.target.closest('.preset-btn, .scan-btn, .mode-btn, .thumb, .saved-open, #rerollBtn, #surpriseBtn, #undoSurpriseBtn, #inkUndo, #inkClear')) creative?.changed();
}, true);
tempoSlider.addEventListener('input', () => creative?.changed(), true);

creative = installCreativeStudio({
  state, engine,
  settleRender: () => { if (renderTimer && !offlineBusy) doRender(); },
  snapshot: currentSettings,
  restore: applySettings,
  render: () => { clearTimeout(renderTimer); doRender(); },
  stopPlayback: () => { playIntent++; state.resumeAfterRender = false; playBtn.removeAttribute('aria-busy'); engine.stop(); },
  setOffline: value => { offlineBusy = value; },
  prepareOffline: async () => {
    playIntent++; state.resumeAfterRender = false; drawing = false;
    clearTimeout(renderTimer); clearTimeout(inkSyncTimer);
    engine.stop();
    if (arming) await arming.catch(() => {});
    await engine.ready;
    engine.stop();
  },
});

// ---------- 启动 ----------

readHash();
setScan(state.scan);
setMode(state.mode);
tempoSlider.value = state.tempo; $('tempoVal').textContent = state.tempo;
document.querySelectorAll('.preset-btn').forEach(x => setPressed(x, x.dataset.preset === state.preset));
selectPainting(state.painting || PAINTINGS[0].id, true, state.ink);
renderSavedWorks();
schedulePreload();
