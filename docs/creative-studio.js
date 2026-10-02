import { applyEditPlan, normalizeEditPlan, normalizeEditPlans, parseLocalIntent } from './creative-edits.js?v=20261003-1';
import { renderWav } from './audio-export.js?v=20261003-1';
import { MODEL_ENDPOINT } from './model-config.js?v=20261003-1';

const $ = id => document.getElementById(id);
const GLOBAL_OPS = new Set(['slower', 'faster', 'airy']);

/** UI orchestration: proposals never mutate the composition until accepted. */
export function installCreativeStudio(api) {
  const { state, engine, snapshot, restore, render, prepareOffline, setOffline, stopPlayback } = api;
  const started = performance.now(), events = [];
  let revision = 0, request = null, pending = null, previewTimer = null, previewVersion = 0;
  let busy = false, audioUrl = null, undo = [];
  const editDialog = $('editDialog'), audioDialog = $('audioDialog');
  const feedback = message => { $('editFeedback').textContent = message; };
  function record(action, metadata = {}) {
    events.push({ action, atMs: Math.round(performance.now() - started), ...metadata });
    if (events.length > 500) events.shift();
    $('trialSummary').textContent = `这次已留下 ${events.length} 个操作小脚印；只在当前标签页，关闭后即清空。`;
  }
  function changed({ clearUndo = true } = {}) {
    revision++;
    if (request) {
      request.controller.abort(); request = null;
      $('editIntentForm').querySelector('button').disabled = false;
      feedback('刚才的修改请求已取消；请按现在的画面重新描述。');
    }
    if (clearUndo) undo = [];
    update();
  }
  function update() {
    $('exportAudioBtn').disabled = !state.result || busy;
    document.querySelectorAll('[data-edit]').forEach(button => { button.disabled = !state.result || busy; });
    $('undoEditBtn').hidden = !undo.length && !state.editPlans.length;
    $('editHistory').textContent = state.editPlans.length ? `这首小曲保留了 ${state.editPlans.length} 步局部修改；收藏与分享会一起带走。` : '';
  }
  function stopPreview() {
    previewVersion++; clearTimeout(previewTimer); stopPlayback();
    $('listenBefore').classList.remove('active'); $('listenAfter').classList.remove('active');
  }
  async function restoreCurrentAudio() {
    stopPreview();
    engine.load(state.result); engine.setInks(state.ink);
    if (engine.presetName !== state.preset) await engine.setPreset(state.preset);
  }
  function scopeBeat(plan, bars) {
    if (plan.operations.every(op => op.type === 'fadeEnding') || plan.scope === 'ending') return Math.max(0, bars * 4 - 16);
    return plan.scope === 'secondHalf' ? bars * 2 : 0;
  }
  function propose(rawPlan, source, metadata = {}) {
    if (!state.result || busy) return;
    api.settleRender();
    const plan = normalizeEditPlan(rawPlan);
    if ($('lockMelody').checked && !plan.lockMelody) throw new Error('旋律仍处于锁定状态。请先手动取消锁定，再要求修改旋律。');
    const localOps = plan.operations.filter(op => !GLOBAL_OPS.has(op.type));
    if (localOps.length && state.editPlans.length >= 8) throw new Error('这首小曲已保留 8 步修改，请先撤回一步，或另选一幅画开始。');
    const applied = applyEditPlan(state.result, plan);
    const sameNotes = JSON.stringify(applied.result.tracks) === JSON.stringify(state.result.tracks);
    if (sameNotes && applied.result.tempo === state.result.tempo && (!applied.preset || applied.preset === state.preset)) {
      feedback('当前声音已经是这个状态，这次没有需要改变的音符或参数。');
      record('edit_no_change', { source }); return;
    }
    pending = { plan, applied, before: snapshot(), beforeResult: state.result,
      beforePreset: state.preset, source, metadata, revision };
    stopPlayback();
    $('editChanges').replaceChildren(...applied.changes.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
    $('editProtection').textContent = `${plan.lockMelody ? '旋律音符完全保留。' : '这次允许修改旋律。'}手绘笔迹始终保留。${source === 'deepseek' ? 'DeepSeek 提议，已通过本机规则校验。' : '快捷按钮使用本机规则。'}`;
    $('compareStatus').textContent = '从修改处试听 8 秒。你的原版还在。';
    record('edit_proposed', { source, scope: plan.scope, lockMelody: plan.lockMelody, operations: plan.operations.map(op => op.type), ...metadata });
    editDialog.showModal();
  }
  async function preview(which) {
    if (!pending || busy) return;
    stopPreview();
    const token = previewVersion, proposal = pending;
    const result = which === 'before' ? proposal.beforeResult : proposal.applied.result;
    const preset = which === 'before' ? proposal.beforePreset : proposal.applied.preset || proposal.beforePreset;
    $('compareStatus').textContent = '正在准备对比声音…';
    try {
      await engine.ensureStarted();
      if (token !== previewVersion || pending !== proposal) return;
      if (engine.presetName !== preset) await engine.setPreset(preset); else await engine.ready;
      if (token !== previewVersion || pending !== proposal) return;
      engine.load(result); engine.setInks(state.ink);
      engine.play(scopeBeat(proposal.plan, result.bars));
      $(which === 'before' ? 'listenBefore' : 'listenAfter').classList.add('active');
      $('compareStatus').textContent = `${which === 'before' ? 'A · 原版' : 'B · 修改版'}正在播放，8 秒后自动停下。`;
      record('edit_preview', { variant: which });
      previewTimer = setTimeout(() => { stopPreview(); $('compareStatus').textContent = '试听结束，可以再对比一次，或决定保留哪一版。'; }, 8000);
    } catch (error) { if (token === previewVersion) $('compareStatus').textContent = `试听未能启动：${error.message}`; }
  }
  $('listenBefore').addEventListener('click', () => preview('before'));
  $('listenAfter').addEventListener('click', () => preview('after'));
  $('editPreviewStop').addEventListener('click', () => { stopPreview(); $('compareStatus').textContent = '已停止试听。'; });
  $('discardEdit').addEventListener('click', () => editDialog.close());
  editDialog.addEventListener('close', () => {
    if (pending) { record('edit_discarded', { source: pending.source }); pending = null; feedback('已回到原版，刚才的修改没有留下。'); }
    restoreCurrentAudio().catch(error => feedback(`原版已保留，音色暂未加载：${error.message}`));
  });
  $('acceptEdit').addEventListener('click', () => {
    if (!pending || pending.revision !== revision) { editDialog.close(); return; }
    const proposal = pending;
    stopPreview();
    undo.push(proposal.before); if (undo.length > 8) undo.shift();
    const operations = proposal.plan.operations.filter(op => !GLOBAL_OPS.has(op.type));
    state.seed = proposal.before.seed;
    state.tempo = proposal.applied.result.tempo;
    state.preset = proposal.applied.preset || state.preset;
    if (operations.length) state.editPlans = normalizeEditPlans([...state.editPlans, { ...proposal.plan, operations }]);
    pending = null; revision++;
    restore({ ...snapshot(), tempo: state.tempo, preset: state.preset, editPlans: state.editPlans });
    render();
    record('edit_accepted', { source: proposal.source, ...proposal.metadata });
    feedback('留下这版了。可以继续修改，也可以撤回上一步。');
    editDialog.close(); update();
  });
  $('undoEditBtn').addEventListener('click', () => {
    if ((!undo.length && !state.editPlans.length) || busy) return;
    const previous = undo.pop() || { ...snapshot(), editPlans: state.editPlans.slice(0, -1) };
    stopPlayback(); restore(previous); revision++; render();
    if (engine.presetName !== state.preset) engine.setPreset(state.preset).catch(error => feedback(error.message));
    record('edit_undone'); feedback('已恢复上一次修改前的版本。'); update();
  });
  document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
    if (!state.result || busy) return;
    if (request) changed({ clearUndo: false });
    const type = button.dataset.edit;
    const scope = GLOBAL_OPS.has(type) ? 'all' : type === 'fadeEnding' ? 'ending' : $('editScope').value;
    try { propose({ scope, lockMelody: $('lockMelody').checked, operations: [{ type }] }, 'local-rules'); }
    catch (error) { feedback(error.message); record('edit_rejected', { source: 'local-rules' }); }
  }));
  $('editScope').addEventListener('change', () => changed({ clearUndo: false }));
  $('lockMelody').addEventListener('change', () => changed({ clearUndo: false }));
  $('editIntent').addEventListener('input', () => { if (request) changed({ clearUndo: false }); });
  $('editIntentForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.result || busy) return;
    if (request) changed({ clearUndo: false });
    api.settleRender();
    const text = $('editIntent').value.trim();
    if (!text) { feedback('先写下你想改变的一点点声音。'); return; }
    const options = { scope: $('editScope').value, lockMelody: $('lockMelody').checked };
    if (!MODEL_ENDPOINT) {
      const response = parseLocalIntent(text, options);
      if (response.status !== 'ready') { feedback(response.message); record('edit_clarification', { source: 'local-rules' }); return; }
      try { propose(response.plan, 'local-rules'); } catch (error) { feedback(error.message); }
      return;
    }
    const controller = new AbortController(), requestRevision = revision, begin = performance.now();
    const thisRequest = { controller }; request = thisRequest;
    const submit = $('editIntentForm').querySelector('button'); submit.disabled = true;
    feedback('DeepSeek 正在理解修改意图，音乐暂时不会改变…');
    record('model_requested', { source: 'deepseek' });
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(MODEL_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ text, ...options, tempo: state.tempo, bars: state.result.bars }) });
      let data; try { data = await response.json(); } catch { throw new Error('服务没有返回有效的修改方案，请重试。'); }
      if (request !== thisRequest || revision !== requestRevision) return;
      const metadata = { latencyMs: Math.round(performance.now() - begin), model: typeof data.model === 'string' ? data.model.slice(0, 80) : 'deepseek', source: 'deepseek' };
      if (!response.ok) throw new Error(data.message || '模型服务暂时不可用，请稍后再试。');
      if (data.source !== 'deepseek') throw new Error('模型来源校验未通过，这次没有修改音乐。');
      if (data.status !== 'ready') { feedback(data.message || data.summary || '这次需要更具体的说明，请试着拆成一个修改动作。'); record('edit_clarification', metadata); return; }
      propose(data.plan, 'deepseek', metadata);
    } catch (error) {
      if (request !== thisRequest || revision !== requestRevision) return;
      feedback(error.name === 'AbortError' ? '模型等待超时，这次没有修改音乐。请再试一次，或使用快捷按钮。' : `${error.message} 这次没有修改音乐。`);
      record('model_failed', { source: 'deepseek', reason: error.name === 'AbortError' ? 'timeout' : 'request-or-validation', latencyMs: Math.round(performance.now() - begin) });
    } finally { clearTimeout(timeout); if (request === thisRequest) { request = null; submit.disabled = false; } }
  });

  function releaseAudio() {
    $('audioPreview').pause(); $('audioPreview').removeAttribute('src'); $('audioPreview').load();
    if (audioUrl) { const old = audioUrl; setTimeout(() => URL.revokeObjectURL(old), 30000); audioUrl = null; }
    $('audioDownload').removeAttribute('href');
  }
  $('exportAudioBtn').addEventListener('click', async () => {
    if (!state.result || busy) return;
    api.settleRender();
    changed({ clearUndo: false }); busy = true; update(); releaseAudio();
    const seconds = $('exportLength').value === 'full' ? null : Number($('exportLength').value);
    const previousFocus = document.activeElement;
    $('audioMaking').hidden = false; $('audioReady').hidden = true; $('audioClose').disabled = true;
    $('audioProgress').textContent = '正在准备声音…'; $('useFeedbackMessage').textContent = '';
    document.querySelectorAll('[data-use]').forEach(button => { button.removeAttribute('aria-pressed'); });
    audioDialog.showModal();
    setOffline(true);
    record('audio_export_started', { seconds: seconds ?? 'full', preset: state.preset });
    try {
      await prepareOffline();
      const result = await renderWav(state.result, state.ink, state.preset, { seconds, onProgress: progress => { $('audioProgress').textContent = progress.message; } });
      audioUrl = URL.createObjectURL(result.blob);
      $('audioPreview').src = audioUrl; $('audioDownload').href = audioUrl;
      const stem = (state.title || '我的小曲').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
      $('audioDownload').download = `${stem}-${seconds ? seconds + '秒' : '完整'}-Gradient-Lab.wav`;
      $('audioDescription').textContent = `${Math.round(result.duration)} 秒 · 立体声 WAV · ${(result.blob.size / 1024 / 1024).toFixed(1)} MB。先听一遍，再带走。`;
      $('audioNotice').textContent = result.warnings.join(' ') || '这是当前完整乐谱与笔迹的声音，试听静音与声部开关不会写入文件。';
      $('audioMaking').hidden = true; $('audioReady').hidden = false;
      record('audio_export_ready', { seconds: result.duration, preset: state.preset, sampleFallback: result.sampleFallback });
    } catch (error) {
      $('audioProgress').textContent = `这次声音没有做好：${error.message} 关闭后可以重试。`;
      record('audio_export_failed');
    } finally {
      setOffline(false); busy = false; $('audioClose').disabled = false; update();
      audioDialog.addEventListener('close', () => previousFocus?.focus(), { once: true });
    }
  });
  audioDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('audioClose').addEventListener('click', () => { if (!busy) audioDialog.close(); });
  audioDialog.addEventListener('close', releaseAudio);
  $('audioDownload').addEventListener('click', () => { if (audioUrl) record('audio_download_clicked'); });
  $('audioPreview').addEventListener('play', () => record('audio_file_previewed'));
  document.querySelectorAll('[data-use]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-use]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    record('intended_use_selected', { use: button.dataset.use });
    $('useFeedbackMessage').textContent = '记下了，只留在这次体验的小脚印里。';
  }));
  $('exportTrialBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ schema: 'gradient-lab-session-v1', privacy: 'Local tab only. No images, filenames, raw prompts or identifiers. Actions indicate interactions, not verified usage outcomes.', durationMs: Math.round(performance.now() - started), events }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'gradient-lab-session.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  record('studio_opened'); update();
  return { changed, update, record, get offlineBusy() { return busy; }, get comparing() { return editDialog.open; } };
}
