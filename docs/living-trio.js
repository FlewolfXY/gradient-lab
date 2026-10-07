import { renderWav } from './audio-export.js?v=20261006-1';
import { buildMidi } from './midi.js?v=20261006-1';
import { LIVE_TEMPO, LIVE_BEATS, sampleLivingNote, createLivingVoice, buildLivingScore, livingVoicePosition, normalizeLivingEnsemble } from './living-score.js?v=20261006-1';

const $ = id => document.getElementById(id);
const NAMES = ['一点星火', '一圈水纹', '一缕微风'];
const ACCENTS = ['#f0c568', '#82d3cd', '#c8b5ef'];
const MAX_MS = LIVE_BEATS * 60000 / LIVE_TEMPO;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Your gesture becomes a partner. Audio and moving heads share recorded beats. */
export function installLivingTrio(api) {
  const engine = api.engine, canvas = $('trioCanvas'), picture = $('trioPainting');
  const context = canvas.getContext('2d');
  const sceneCache = new Map();
  let base = null, analysis = null, source = null, voices = [], recording = null;
  let chosen = null, sequence = 0, audioIntent = 0, busy = false, frame = 0;
  let loading = true;
  let audioUrl = null, midiUrl = null, latestPulse = new Map(), lastCardBeat = -1;
  let composerInkEnabled = null;
  const hash = new URLSearchParams(location.hash.slice(1));
  let active = !hash.has('p') || hash.get('view') === 'play';
  const status = message => { $('trioStatus').textContent = message; };
  const playable = () => voices.some(voice => !voice.muted);
  const duration = () => recording ? Math.max(0, performance.now() - recording.started) : 0;
  const sceneScore = () => buildLivingScore(base, voices);
  function nextVoiceId() {
    let id;
    do { id = `partner-${++sequence}`; } while (voices.some(voice => voice.id === id));
    return id;
  }

  engine.setVolume(0.7);
  const priorInk = engine.onInk, priorState = engine.onState;
  engine.onInk = event => {
    priorInk?.(event);
    const voice = voices.find(item => event.id.startsWith(item.id + ':'));
    if (voice) latestPulse.set(voice.id, performance.now());
  };
  engine.onState = playing => {
    priorState?.(playing);
    $('trioPlay').textContent = playing ? 'Ⅱ 暂停合奏' : '▶ 继续合奏';
    $('trioPlay').setAttribute('aria-pressed', String(playing));
  };
  const preload = active ? engine.setPreset('ice').catch(() => {}) : Promise.resolve();

  function syncVolume() {
    const muted = Boolean(engine.muted);
    $('trioMute').setAttribute('aria-pressed', String(muted));
    $('trioMute').setAttribute('aria-label', muted ? '取消合奏静音' : '静音合奏');
    $('trioVolume').value = Math.round(engine.volume * 100);
    $('volumeSlider').value = Math.round(engine.volume * 100);
    $('muteBtn').setAttribute('aria-pressed', String(muted));
    $('muteBtn').setAttribute('aria-label', muted ? '取消静音' : '静音');
  }
  $('trioMute').addEventListener('click', () => { engine.setMuted(!engine.muted); syncVolume(); });
  $('trioVolume').addEventListener('input', () => {
    engine.setVolume(Number($('trioVolume').value) / 100);
    if (engine.volume > 0) engine.setMuted(false);
    syncVolume();
  });

  function updateControls() {
    syncVolume();
    $('trioPlay').disabled = !voices.length || loading || busy || Boolean(recording);
    $('trioReset').disabled = !voices.length || busy || Boolean(recording);
    $('trioExport').disabled = !playable() || loading || busy || Boolean(recording);
    $('trioSave').disabled = !voices.length || loading || busy || Boolean(recording);
    $('trioDemo').disabled = !base || loading || busy || Boolean(recording) || voices.length > 0;
    $('trioUpload').disabled = busy || Boolean(recording);
    $('liveModeBtn').disabled = busy; $('composerModeBtn').disabled = busy;
    document.querySelectorAll('[data-trio-painting]').forEach(button => { button.disabled = busy || Boolean(recording); });
    $('trioCount').textContent = `${voices.length} / 3 位伙伴`;
    const hint = $('trioHint');
    hint.textContent = loading ? '正在读这幅画的颜色…' : recording ? '记住你的节奏中… 松手，让它接着唱' : chosen !== null ? `重新画一小段，交给第 ${chosen + 1} 位伙伴` : voices.length >= 3 ? '接管一位伙伴，或用 × 腾出位置' : voices.length ? '再划一小段，给它一个伙伴' : '按住画面，划出第一位伙伴';
    canvas.setAttribute('aria-label', `画中合奏画布。${hint.textContent}。键盘可以用“先看它玩一次”开始，再操作下方伙伴按钮。`);
  }

  function updateCards() {
    const cards = $('trioVoices');
    cards.replaceChildren();
    for (let slot = 0; slot < 3; slot++) {
      const voice = voices[slot];
      const card = document.createElement('article');
      card.className = `trio-voice${voice ? '' : ' empty'}${voice?.muted ? ' muted' : ''}${chosen === slot ? ' chosen' : ''}`;
      card.style.setProperty('--voice-accent', ACCENTS[slot]);
      if (!voice) {
        const numeral = document.createElement('span'); numeral.className = 'voice-number'; numeral.textContent = String(slot + 1).padStart(2, '0');
        const prompt = document.createElement('p'); prompt.textContent = slot === 0 ? '你的第一段手势' : '等一个新伙伴';
        card.append(numeral, prompt); cards.appendChild(card); continue;
      }
      const head = document.createElement('button'); head.className = 'voice-toggle';
      head.type = 'button'; head.setAttribute('aria-pressed', String(!voice.muted));
      head.setAttribute('aria-label', `${voice.muted ? '唤醒' : '静音'}第 ${slot + 1} 位伙伴：${NAMES[slot]}`);
      const number = document.createElement('span'); number.className = 'voice-number'; number.textContent = String(slot + 1).padStart(2, '0');
      const name = document.createElement('span'); name.textContent = NAMES[slot];
      const caption = document.createElement('small'); caption.textContent = voice.muted ? '正在休息 · 点我唤醒' : `${voice.loopBeats === 4 ? '一' : '两'}小节的你 · 点我静音`;
      name.appendChild(caption); head.append(number, name);
      head.addEventListener('click', () => { if (busy || recording) return; voice.muted = !voice.muted; refresh(false); updateCards(); status(voice.muted ? `第 ${slot + 1} 位伙伴安静下来了，听听少了它有什么不同。` : `第 ${slot + 1} 位伙伴又加入了。`); });
      const actions = document.createElement('div'); actions.className = 'voice-actions';
      const take = document.createElement('button'); take.type = 'button'; take.textContent = chosen === slot ? '正在接管…' : '接管重录';
      take.setAttribute('aria-pressed', String(chosen === slot));
      take.addEventListener('click', () => { if (busy || recording) return; chosen = chosen === slot ? null : slot; updateCards(); updateControls(); canvas.focus({ preventScroll: true }); status(chosen === null ? '继续自由合奏。' : `下一笔会替换第 ${slot + 1} 位伙伴；取消或离开画布会保留原来的它。`); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'voice-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除第 ${slot + 1} 位伙伴`);
      remove.addEventListener('click', () => { if (busy || recording) return; voices.splice(slot, 1); chosen = null; refresh(false); updateCards(); updateControls(); canvas.focus({ preventScroll: true }); status('腾出一个位置。再划一段，试试另一种节奏。'); });
      actions.append(take, remove); card.append(head, actions); cards.appendChild(card);
    }
  }

  function refresh(reset = false, releaseHeld = true) {
    if (!base) return;
    const playing = engine.playing;
    const { result, ink } = sceneScore();
    result.liveTrio = true;
    if (reset || !engine.result?.liveTrio) engine.load(result, reset);
    engine.setInks(ink, { releaseHeld });
    if (!voices.length) engine.stop();
    else if (playing && !engine.playing) engine.play(reset ? 0 : null);
    updateControls();
  }

  async function startPlayback(reset = false) {
    const token = ++audioIntent;
    try {
      await engine.ensureStarted(); await preload;
      if (token !== audioIntent || !active || busy || loading || recording || !voices.length) return;
      await engine.setPreset('ice');
      if (token !== audioIntent || !active || busy || loading || recording || !voices.length) return;
      refresh(reset); engine.play(reset ? 0 : null);
    } catch (error) { if (token === audioIntent) status(`声音还没准备好：${error.message}。点“继续合奏”可以重试。`); }
  }

  function setActive(value) {
    if (busy || api.isOfflineBusy()) return;
    cancelRecording(); audioIntent++; engine.stop(); api.stopPlayback();
    active = Boolean(value);
    if (active && composerInkEnabled === null) {
      composerInkEnabled = engine.tracks.ink;
      engine.setTrackEnabled('ink', true);
    } else if (!active && composerInkEnabled !== null) {
      engine.setTrackEnabled('ink', composerInkEnabled);
      composerInkEnabled = null;
    }
    $('liveLab').hidden = !active;
    for (const id of ['lab', 'collection', 'takeaway', 'scoreDetails', 'trialNotes']) $(id).hidden = active;
    $('liveModeBtn').setAttribute('aria-pressed', String(active));
    $('composerModeBtn').setAttribute('aria-pressed', String(!active));
    $('journey').hidden = active;
    $('heroTitle').textContent = active ? '你的手一松，画就接着唱。' : '让颜色，慢慢唱出来。';
    $('heroSubtitle').textContent = active ? '在画里划一小段。它会记住你的节奏，再陪你接着玩。' : '选一幅画，听它的旋律。再添几笔，让这首小曲长成你的样子。';
    $('surpriseBtn').hidden = active;
    if (active) { engine.setPreset('ice').catch(error => status(error.message)); if (base) refresh(true); sizeCanvas(); updateControls(); }
    else api.restoreComposer();
    api.modeChanged();
    api.syncUrl();
  }
  $('liveModeBtn').addEventListener('click', () => setActive(true));
  $('composerModeBtn').addEventListener('click', () => setActive(false));

  function sourceChanged() {
    if (!api.state.result || !api.state.analysis) return;
    const nextSource = api.state.imageSource;
    base = api.state.result; analysis = api.state.analysis;
    loading = false;
    if (nextSource === source) { if (active) refresh(false); updateControls(); return; }
    cancelRecording(); audioIntent++; engine.stop();
    if (source) sceneCache.set(source, voices);
    source = nextSource; voices = sceneCache.get(source) || []; chosen = null; latestPulse.clear();
    // Four built-in canvases plus the latest few uploads, bounded in tab memory.
    if (sceneCache.size > 8) sceneCache.delete(sceneCache.keys().next().value);
    picture.src = source; picture.alt = `${api.state.title}，正在等你唤醒的画`;
    picture.decode().then(sizeCanvas).catch(() => {});
    document.querySelectorAll('[data-trio-painting]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.trioPainting === api.state.painting)));
    $('trioPaintingName').textContent = api.state.title;
    if (active) refresh(true); updateCards(); updateControls();
    status(voices.length ? '刚才的伙伴还在。点“继续合奏”，或者再画一笔。' : '划过亮处，声音会抬高；走进不同颜色，听见不同音色。');
  }
  document.querySelectorAll('[data-trio-painting]').forEach(button => button.addEventListener('click', () => { if (!busy && !recording) api.loadPainting(button.dataset.trioPainting); }));
  $('trioUpload').addEventListener('click', () => { if (!busy && !recording) api.upload(); });

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
  }
  function collect(x, y, force = false) {
    if (!recording || !analysis || !base) return;
    const time = Math.min(MAX_MS - 0.001, duration()), last = recording.samples.at(-1);
    if (!force && last && (time - last.tMs < 100 || Math.hypot(x - last.x, y - last.y) < 0.016)) return;
    const note = sampleLivingNote(analysis, base, x, y);
    const point = { ...note, x, y, tMs: time };
    recording.samples.push(point);
    const current = recording;
    engine.triggerInk(point).catch(error => { if (recording === current) status(`声音暂时未启动：${error.message}`); });
    $('trioLiveColor').style.background = note.color;
    $('trioLiveReadout').textContent = `${note.kind === 'spark' ? '暖色 · 星火' : note.kind === 'water' ? '冷色 · 水纹' : note.kind === 'mist' ? '淡色 · 微风' : '深色 · 低鸣'} · 记住你的停顿与快慢`;
  }
  function begin(event) {
    if (!active || !base || loading || !api.state.result || busy || api.isOfflineBusy() || recording || event.button > 0) return;
    if (voices.length >= 3 && chosen === null) { status('三位伙伴都到齐了。点下面任意一个“接管重录”，再画一段新的。'); return; }
    event.preventDefault();
    audioIntent++;
    const slot = chosen ?? voices.length;
    recording = { started: performance.now(), samples: [], slot, pointerId: event.pointerId };
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    engine.ensureStarted().catch(error => status(`点“继续合奏”重试声音：${error.message}`));
    collect(...canvasPoint(event), true); updateControls();
  }
  function finish() {
    if (!recording) return;
    const gesture = recording, elapsed = Math.min(MAX_MS, duration());
    recording = null;
    engine.cancelInkPreviews?.();
    try { if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId); } catch {}
    const voice = createLivingVoice(gesture.samples, { id: nextVoiceId(), tempo: LIVE_TEMPO, durationMs: elapsed });
    // Start the new partner at release, without rewinding its older friends.
    voice.offsetBeat = engine.playing ? (engine.beat + 0.2) % LIVE_BEATS : 0;
    if (gesture.slot < voices.length) voices[gesture.slot] = voice; else voices.push(voice);
    chosen = null; refresh(false, false); updateCards(); updateControls();
    status(voices.length === 1 ? '它记住了。再画一笔，给它一个伙伴。' : voices.length === 2 ? '两段手势，已经在合奏。再加一个试试？' : '三个刚才的你，在一起演奏。点下方伙伴，让它休息或接管它。');
    if (!engine.playing) startPlayback(false);
  }
  function cancelRecording() {
    if (!recording) return;
    const gesture = recording; recording = null;
    engine.cancelInkPreviews?.();
    try { if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId); } catch {}
    // Rebuild from committed partners only; stop also releases preview tails.
    audioIntent++; refresh(false);
    updateControls(); status('这一笔没有留下。原来的伙伴还在，准备好再划一次。');
  }
  canvas.addEventListener('pointerdown', begin);
  canvas.addEventListener('pointermove', event => { if (!recording || recording.pointerId !== event.pointerId) return; event.preventDefault(); collect(...canvasPoint(event)); });
  canvas.addEventListener('pointerup', event => {
    if (recording?.pointerId !== event.pointerId) return;
    const point = canvasPoint(event), last = recording.samples.at(-1);
    if (!last || Math.hypot(point[0] - last.x, point[1] - last.y) > 0.005) collect(...point, true);
    finish();
  });
  canvas.addEventListener('pointercancel', event => { if (recording && (event.pointerId == null || event.pointerId === recording.pointerId)) cancelRecording(); });
  canvas.addEventListener('lostpointercapture', event => { if (recording && (event.pointerId == null || event.pointerId === recording.pointerId)) cancelRecording(); });
  window.addEventListener('blur', () => { if (recording) cancelRecording(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && active) { cancelRecording(); audioIntent++; engine.stop(); } });

  $('trioPlay').addEventListener('click', () => { if (busy || recording) return; if (engine.playing) { audioIntent++; engine.pause(); } else startPlayback(false); });
  $('trioReset').addEventListener('click', () => { if (busy || recording) return; audioIntent++; engine.stop(); voices = []; chosen = null; refresh(true); updateCards(); updateControls(); status('画又安静下来了，等一个新节奏。'); });
  $('trioSave').addEventListener('click', () => {
    if (!voices.length || loading || busy || recording) return;
    try {
      const ensemble = normalizeLivingEnsemble({ v: 1, tempo: LIVE_TEMPO, voices });
      const saved = api.saveEnsemble(ensemble);
      status(saved.added ? `这场合奏已收藏（${saved.count}/8）。路线、快慢、停顿与静音都记住了，下次从“我的小曲”继续。` : `这场合奏已经收藏了（${saved.count}/8），没有重复占位置。`);
    } catch (error) { status(error.message || '这次没有收藏成功，仍可以导出声音。'); }
  });
  $('trioDemo').addEventListener('click', () => {
    if (!base || loading || voices.length || busy || recording) return;
    const samples = Array.from({ length: 14 }, (_, index) => {
      const t = index / 13, x = 0.18 + t * 0.64, y = 0.52 + Math.sin(t * Math.PI * 2) * 0.2;
      return { ...sampleLivingNote(analysis, base, x, y), x, y, tMs: t * 1800 };
    });
    voices = [createLivingVoice(samples, { id: nextVoiceId(), tempo: LIVE_TEMPO, durationMs: 1900 })];
    refresh(true); updateCards(); updateControls();
    status('这条小路先陪你唱。现在按住画面，画出属于你的第二位伙伴。');
    startPlayback(true);
  });
  document.addEventListener('keydown', event => {
    if (!active || busy || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && recording) { event.preventDefault(); cancelRecording(); return; }
    if (event.code === 'Space' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('button,input,textarea,select,a,summary,[contenteditable="true"]')) {
      event.preventDefault(); $('trioPlay').click();
    }
  });

  function sizeCanvas() {
    const rect = picture.getBoundingClientRect(), wrap = $('trioCanvasWrap').getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
    canvas.style.left = rect.left - wrap.left + 'px'; canvas.style.top = rect.top - wrap.top + 'px';
  }
  window.addEventListener('resize', sizeCanvas);
  function drawPath(points, accent, alpha, width, height) {
    if (!points.length) return;
    context.beginPath(); context.moveTo(points[0].x * width, points[0].y * height);
    for (const point of points.slice(1)) context.lineTo(point.x * width, point.y * height);
    context.strokeStyle = accent; context.globalAlpha = alpha;
    context.lineWidth = 3; context.lineCap = 'round'; context.lineJoin = 'round';
    context.shadowColor = accent; context.shadowBlur = 12; context.stroke(); context.shadowBlur = 0; context.globalAlpha = 1;
    for (const point of points) { context.fillStyle = point.color || accent; context.beginPath(); context.arc(point.x * width, point.y * height, 2.5, 0, Math.PI * 2); context.fill(); }
  }
  function draw() {
    frame = requestAnimationFrame(draw);
    if (!active || !base || !context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), width = canvas.width / dpr, height = canvas.height / dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
    const beat = engine.beat || 0, now = performance.now();
    voices.forEach((voice, index) => {
      const accent = ACCENTS[index];
      drawPath(voice.points, accent, voice.muted ? 0.22 : 0.68, width, height);
      const position = livingVoicePosition(voice, engine.playing ? beat : voice.offsetBeat || 0);
      if (!position) return;
      const x = position.x * width, y = position.y * height;
      const pulse = !reducedMotion() && !voice.muted ? Math.max(0, 1 - (now - (latestPulse.get(voice.id) || 0)) / 450) : 0;
      context.globalAlpha = voice.muted ? 0.45 : 1;
      context.fillStyle = accent; context.shadowColor = accent; context.shadowBlur = 20 + pulse * 18;
      context.beginPath(); context.arc(x, y, 13 + pulse * 3, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
      context.strokeStyle = '#fffaf0'; context.lineWidth = 2; context.stroke();
      context.fillStyle = '#493f35'; context.font = 'bold 12px system-ui'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(index + 1), x, y + 1);
      context.globalAlpha = 1;
    });
    if (recording) {
      drawPath(recording.samples, '#fff8dc', 0.95, width, height);
      const point = recording.samples.at(-1);
      if (point) {
        context.strokeStyle = '#fff9e8'; context.lineWidth = 3; context.beginPath();
        context.arc(point.x * width, point.y * height, 19, -Math.PI / 2, -Math.PI / 2 + Math.min(1, duration() / MAX_MS) * Math.PI * 2); context.stroke();
      }
      $('trioRecordingProgress').style.width = Math.min(100, duration() / MAX_MS * 100) + '%';
      if (duration() >= MAX_MS) finish();
    } else $('trioRecordingProgress').style.width = '0%';
    const beatIndex = Math.floor(beat * 2);
    if (beatIndex !== lastCardBeat) {
      lastCardBeat = beatIndex;
      [...$('trioVoices').children].forEach((card, index) => card.classList.toggle('singing', Boolean(engine.playing && !voices[index]?.muted && now - (latestPulse.get(voices[index]?.id) || 0) < 500)));
    }
  }
  draw();

  function releaseExport() {
    $('trioAudioPreview').pause(); $('trioAudioPreview').removeAttribute('src'); $('trioAudioPreview').load();
    for (const url of [audioUrl, midiUrl]) if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
    audioUrl = null; midiUrl = null;
    $('trioAudioDownload').removeAttribute('href'); $('trioMidiDownload').removeAttribute('href');
  }
  $('trioExport').addEventListener('click', async () => {
    if (!base || !playable() || busy || recording || api.isOfflineBusy()) return;
    busy = true; audioIntent++; engine.stop(); releaseExport(); updateControls();
    const dialog = $('trioExportDialog');
    $('trioExportReady').hidden = true; $('trioExportClose').disabled = true;
    $('trioExportProgress').textContent = '把刚才的你们，装进一段声音…';
    dialog.showModal(); api.setOffline(true);
    try {
      await api.prepareOffline(); await engine.ready; engine.stop();
      const { result, ink } = sceneScore();
      const output = await renderWav(result, ink, 'ice', { seconds: 20, onProgress: progress => { $('trioExportProgress').textContent = progress.message; } });
      audioUrl = URL.createObjectURL(output.blob);
      $('trioAudioPreview').src = audioUrl; $('trioAudioDownload').href = audioUrl;
      $('trioAudioDownload').download = `${api.state.title}-画中合奏-20秒.wav`;
      const midi = buildMidi(voices.filter(voice => !voice.muted).map((voice, index) => [`partner-${index + 1}`, ink.filter(event => event.id.startsWith(voice.id + ':')).map(event => [event.beat, event.dur, event.note, event.vel])]), LIVE_TEMPO);
      midiUrl = URL.createObjectURL(midi); $('trioMidiDownload').href = midiUrl; $('trioMidiDownload').download = `${api.state.title}-画中合奏.mid`;
      $('trioExportProgress').textContent = '20 秒 · 立体声 WAV。只包含正在发声的伙伴，保留这场合奏的节奏与音色。';
      $('trioExportReady').hidden = false;
    } catch (error) { $('trioExportProgress').textContent = `这次没做好：${error.message}。关闭后可以重试。`; }
    finally { api.setOffline(false); busy = false; $('trioExportClose').disabled = false; updateControls(); }
  });
  $('trioExportDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('trioExportClose').addEventListener('click', () => { if (!busy) $('trioExportDialog').close(); });
  $('trioExportDialog').addEventListener('close', () => { releaseExport(); $('trioExport').focus({ preventScroll: true }); });

  setActive(active); updateCards(); updateControls();
  return { get active() { return active; }, setActive, sourceChanged, notice: status,
    restoreEnsemble: saved => {
      const ensemble = normalizeLivingEnsemble(saved);
      setActive(true); voices = ensemble.voices; chosen = null;
      refresh(true); updateCards(); updateControls();
      status('你的伙伴回来了，路线、节奏与静音状态都还在。点“继续合奏”，再陪它们玩一会儿。');
    },
    sourceLoading: () => { cancelRecording(); loading = true; audioIntent++; engine.stop(); updateControls(); status('正在读新画的颜色…'); },
    stop: () => { cancelRecording(); audioIntent++; engine.stop(); } };
}
