/* 画布召唤台前端：选画、选读法、点击设置涟漪焦点、播放时的扫描动画。 */

const img = document.getElementById('painting');
const overlay = document.getElementById('overlay');
const wrap = document.getElementById('canvasWrap');
const hint = document.getElementById('canvasHint');
const playBtn = document.getElementById('playBtn');
const nowChord = document.getElementById('nowChord');
const keyReadout = document.getElementById('keyReadout');
const statusEl = document.getElementById('status');
const dpr = window.devicePixelRatio || 1;

const state = {
  image: null,
  scan: 'lr',
  focus: null,       // [fx, fy] 比例坐标
  tempo: 80,
  mode: '',
  seed: null,
  result: null,      // /render 的返回
  audio: new Audio(),
};

// ---------- 渲染请求 ----------

let renderTimer = null;
function requestRender(immediate = false) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(doRender, immediate ? 0 : 250);
}

async function doRender() {
  if (!state.image) return;
  statusEl.textContent = '召唤中……';
  statusEl.classList.add('busy');
  playBtn.disabled = true;
  const wasPlaying = !state.audio.paused;
  state.audio.pause();

  const res = await fetch('/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: state.image, scan: state.scan,
      focus: state.scan === 'ripple' ? state.focus : null,
      tempo: state.tempo, mode: state.mode, seed: state.seed,
    }),
  });
  if (!res.ok) {
    statusEl.textContent = '召唤失败：' + (await res.text()).slice(0, 120);
    statusEl.classList.remove('busy');
    return;
  }
  state.result = await res.json();
  state.audio.src = state.result.urls.preview;
  playBtn.disabled = false;
  keyReadout.innerHTML = `${state.result.key}（判定分 ${state.result.mode_score}）<br>` +
    `${state.result.tempo} BPM · 种子 ${state.result.seed}`;
  statusEl.textContent = '';
  statusEl.classList.remove('busy');
  buildDownloads();
  buildChordStrip();
  drawOverlay();
  if (wasPlaying) state.audio.play();
}

function buildDownloads() {
  const u = state.result.urls;
  document.getElementById('downloads').innerHTML = `
    <a href="${u.melody}" download>melody.mid</a>
    <a href="${u.chords}" download>chords.mid</a>
    <a href="${u.bass}" download>bass.mid</a>
    <a href="${u.combined}" download>combined.mid</a>
    <a href="${u.annotated}" target="_blank">标注图</a>
    <a href="${u.report}" target="_blank">报告</a>`;
}

function buildChordStrip() {
  const box = document.getElementById('chordStrip');
  box.innerHTML = '';
  state.result.chords.forEach((c, i) => {
    const chip = document.createElement('span');
    chip.className = 'chord-chip';
    chip.textContent = `${i + 1}·${c.label}`;
    box.appendChild(chip);
  });
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
img.addEventListener('load', () => { hint.hidden = true; sizeOverlay(); });

function currentBeat() {
  return state.audio.currentTime / 60 * state.result.tempo;
}

function drawOverlay() {
  if (!state.result) return;
  const ctx = overlay.getContext('2d');
  const W = overlay.width / dpr, H = overlay.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const geo = state.result.geometry;
  const playing = !state.audio.paused && !state.audio.ended;
  const beat = playing ? currentBeat() : (state.audio.currentTime / 60 * state.result.tempo);
  const totalBars = state.result.bars;
  const bar = Math.min(totalBars - 1, Math.floor(beat / 4));
  const frac = Math.min(1, (beat - bar * 4) / 4);

  // 静态：小节边界（很淡）
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.lineWidth = 1;
  if (geo.type === 'lr') {
    geo.bounds.slice(1, -1).forEach(b => {
      ctx.beginPath(); ctx.moveTo(b * W, 0); ctx.lineTo(b * W, H); ctx.stroke();
    });
  } else if (geo.type === 'tb') {
    geo.bounds.slice(1, -1).forEach(b => {
      ctx.beginPath(); ctx.moveTo(0, b * H); ctx.lineTo(W, b * H); ctx.stroke();
    });
  } else {
    const [fx, fy] = geo.focus;
    geo.bounds.slice(1, -1).forEach(b => {
      ctx.beginPath(); ctx.arc(fx * W, fy * H, b * W, 0, Math.PI * 2); ctx.stroke();
    });
    // 焦点
    ctx.strokeStyle = 'rgba(251, 191, 36, .9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(fx * W, fy * H, 6, 0, Math.PI * 2); ctx.stroke();
  }

  // 动态：扫描位置
  if (state.audio.currentTime > 0 || playing) {
    const p0 = geo.bounds[bar], p1 = geo.bounds[bar + 1];
    const pos = p0 + (p1 - p0) * frac;
    ctx.strokeStyle = 'rgba(253, 164, 175, .95)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(253, 164, 175, 1)';
    ctx.shadowBlur = 10;
    if (geo.type === 'lr') {
      ctx.beginPath(); ctx.moveTo(pos * W, 0); ctx.lineTo(pos * W, H); ctx.stroke();
    } else if (geo.type === 'tb') {
      ctx.beginPath(); ctx.moveTo(0, pos * H); ctx.lineTo(W, pos * H); ctx.stroke();
    } else {
      const [fx, fy] = geo.focus;
      ctx.beginPath(); ctx.arc(fx * W, fy * H, Math.max(2, pos * W), 0, Math.PI * 2); ctx.stroke();
      // 已经扫过的区域轻微提亮
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(125, 211, 252, .05)';
      ctx.beginPath(); ctx.arc(fx * W, fy * H, Math.max(2, pos * W), 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // 当前和弦
  const chord = state.result.chords[bar];
  nowChord.textContent = chord ? `${chord.label}（${chord.degree}）` : '';
  document.querySelectorAll('.chord-chip').forEach((chip, i) => {
    chip.classList.toggle('playing', i === bar && (playing || state.audio.currentTime > 0));
  });
}

function tick() {
  drawOverlay();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- 交互 ----------

overlay.addEventListener('click', e => {
  if (!state.image) return;
  const r = overlay.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  if (state.scan !== 'ripple') {
    document.querySelectorAll('.scan-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.scan === 'ripple'));
    state.scan = 'ripple';
    document.getElementById('rippleTip').hidden = false;
  }
  state.focus = [fx, fy];
  requestRender(true);
});

document.querySelectorAll('.scan-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.scan-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.scan = btn.dataset.scan;
    document.getElementById('rippleTip').hidden = state.scan !== 'ripple';
    requestRender(true);
  });
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    requestRender(true);
  });
});

const tempoSlider = document.getElementById('tempoSlider');
tempoSlider.addEventListener('input', () => {
  state.tempo = parseInt(tempoSlider.value);
  document.getElementById('tempoVal').textContent = state.tempo;
  requestRender();
});

document.getElementById('rerollBtn').addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 10000);
  requestRender(true);
});

playBtn.addEventListener('click', () => {
  state.audio.paused ? state.audio.play() : state.audio.pause();
});
state.audio.addEventListener('play', () => playBtn.textContent = '❚❚ 暂停');
state.audio.addEventListener('pause', () => playBtn.textContent = '▶ 播放');
state.audio.addEventListener('ended', () => playBtn.textContent = '▶ 播放');

function selectPainting(name) {
  state.image = name;
  state.focus = null;
  state.seed = null;
  document.querySelectorAll('.thumb').forEach(t =>
    t.classList.toggle('active', t.dataset.name === name));
  img.src = '/painting/' + encodeURIComponent(name);
  requestRender(true);
}

document.querySelectorAll('.thumb').forEach(t => {
  t.addEventListener('click', () => selectPainting(t.dataset.name));
});

document.getElementById('uploadInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('image', f);
  const res = await fetch('/upload', { method: 'POST', body: fd });
  const { name } = await res.json();
  location.reload();
});

// 默认选第一幅
const firstThumb = document.querySelector('.thumb');
if (firstThumb) selectPainting(firstThumb.dataset.name);
