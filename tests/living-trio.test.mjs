import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appFixture, plain } from './app-fixture.mjs';
import * as livingScore from '../docs/living-score.js';
import { buildMidi } from '../docs/midi.js';

const source = readFileSync(new URL('../docs/living-trio.js', import.meta.url), 'utf8');
const { LIVE_TEMPO, LIVE_BEATS, sampleLivingNote, createLivingVoice, buildLivingScore } = livingScore;

function loadController(sandbox, dependencies) {
  sandbox.livingDependencies = dependencies;
  const executable = source.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?$/gm, (_line, names, path) => {
    const name = path.split('?')[0];
    assert.ok(dependencies[name], `Provide an explicit test dependency for ${name}`);
    for (const imported of names.split(',').map(value => value.trim())) assert.ok(imported in dependencies[name], `Missing test import ${imported}`);
    return `const {${names}} = livingDependencies[${JSON.stringify(name)}];`;
  }).replace(/^export /gm, '');
  return new vm.Script(`(() => {\n${executable}\nreturn installLivingTrio;\n})()`, { filename: 'living-trio.js' }).runInContext(sandbox);
}

// Execute the real controller, real color/gesture/loop rules, and real MIDI
// encoder in the existing isolated Node DOM simulation. Only Web Audio/WAV
// rendering is doubled. This does not claim browser, visual or listening QA.
async function fixture({ hash = '', renderWav, ready = true } = {}) {
  const f = await appFixture();
  f.location.hash = hash;
  const composer = plain(f.state.result), exports = [], midis = [], calls = { restore: 0, stop: 0, prepare: 0, mode: 0, sync: 0, offline: [] };
  let offline = false;
  const dependencies = {
    './living-score.js': livingScore,
    './midi.js': { buildMidi(tracks, tempo) { midis.push({ tracks: plain(tracks), tempo }); return buildMidi(tracks, tempo); } },
    './audio-export.js': { async renderWav(result, ink, preset, options) {
      exports.push({ result: plain(result), ink: plain(ink), preset, seconds: options.seconds });
      if (renderWav) return renderWav(result, ink, preset, options);
      options.onProgress({ message: 'Rendering test audio' });
      return { blob: new Blob(['fake-wav'], { type: 'audio/wav' }) };
    } },
  };
  const install = loadController(f.sandbox, dependencies);
  const api = {
    state: f.state, engine: f.engine, isOfflineBusy: () => offline,
    stopPlayback() { calls.stop++; f.engine.stop(); },
    restoreComposer() { calls.restore++; f.engine.load(f.state.result); f.engine.setInks(f.state.ink); f.engine.setPreset(f.state.preset); },
    modeChanged() { calls.mode++; }, syncUrl() { calls.sync++; },
    loadPainting(id) { calls.painting = id; }, upload() { calls.upload = true; },
    setOffline(value) { offline = value; calls.offline.push(value); },
    async prepareOffline() { calls.prepare++; f.engine.stop(); },
  };
  const controller = install(api);
  if (ready) controller.sourceChanged(); await f.settle(0);
  const pointer = (type, x = 0.2, y = 0.5, id = 7) => f.get('trioCanvas').dispatchEvent({ type, pointerId: id, button: 0, clientX: x * 320, clientY: y * 240 });
  return { ...f, controller, composer, exports, midis, calls, pointer,
    voices: () => f.get('trioVoices').children.filter(card => !card.classList.contains('empty')),
    async demo() { f.get('trioDemo').click(); await f.settle(0); },
    async gesture(points = [[0, 0.15, 0.6], [180, 0.35, 0.4], [840, 0.75, 0.3]], releaseMs = 1000) {
      let last = 0;
      for (const [at, x, y] of points) { f.advance(at - last); pointer(last === 0 && at === 0 ? 'pointerdown' : 'pointermove', x, y); last = at; }
      f.advance(releaseMs - last); pointer('pointerup', points.at(-1)[1], points.at(-1)[2]); await f.settle(0);
    },
  };
}

async function integratedFixture({ works = [], hash = '#view=play', controls = false } = {}) {
  let controller;
  const dependencies = { './living-score.js': livingScore, './midi.js': { buildMidi },
    './audio-export.js': { renderWav: () => assert.fail('This integration scenario does not export audio') } };
  const f = await appFixture({ works, hash, livingInstaller(api, sandbox) {
    controller = loadController(sandbox, dependencies)(api); return controller;
  } });
  if (controls) {
    const controlsSource = readFileSync(new URL('../docs/studio-controls.js', import.meta.url), 'utf8');
    new vm.Script(`(() => {\n${controlsSource.replace(/^import ['"][^'"]+['"];?$/gm, '')}\n})()`, { filename: 'studio-controls.js' }).runInContext(f.sandbox);
  }
  const pointer = (type, x, y) => f.get('trioCanvas').dispatchEvent({ type, pointerId: 7, button: 0, clientX: x * 320, clientY: y * 240 });
  return { ...f, controller, pointer,
    voices: () => f.get('trioVoices').children.filter(card => !card.classList.contains('empty')),
    async gesture(points, releaseMs) {
      let last = 0;
      for (const [at, x, y] of points) { f.advance(at - last); pointer(at === 0 ? 'pointerdown' : 'pointermove', x, y); last = at; }
      f.advance(releaseMs - last); pointer('pointerup', points.at(-1)[1], points.at(-1)[2]); await f.settle(0);
    },
  };
}

function expectedVoice(f, id, points, durationMs) {
  const samples = points.map(([tMs, x, y]) => ({ ...sampleLivingNote(f.state.analysis, f.state.result, x, y), x, y, tMs }));
  return createLivingVoice(samples, { id, tempo: LIVE_TEMPO, durationMs });
}
function assertLiveScore(f, voices) {
  const expected = buildLivingScore(f.state.result, voices);
  assert.deepEqual(plain(f.engine.result), { ...plain(expected.result), liveTrio: true });
  assert.deepEqual(f.engine.inkEvents, plain(expected.ink));
}

test('live demo button schedules the exact colored gesture and its repeat, with no composer backing', async () => {
  const f = await fixture();
  assert.equal(f.controller.active, true);
  assert.equal(f.get('liveLab').hidden, false);
  assert.equal(f.get('lab').hidden, true);
  assert.equal(f.get('trioDemo').disabled, false);
  assert.equal(f.get('trioPlay').disabled, true);
  await f.demo();
  const points = Array.from({ length: 14 }, (_, i) => { const t = i / 13; return [t * 1800, 0.18 + t * 0.64, 0.52 + Math.sin(t * Math.PI * 2) * 0.2]; });
  const voice = expectedVoice(f, 'partner-1', points, 1900);
  assertLiveScore(f, [voice]);
  assert.equal(f.engine.inkEvents.length, 28);
  assert.equal(f.engine.result.tempo, 100);
  assert.equal(f.engine.result.bars, 2);
  assert.deepEqual(plain(f.engine.result.tracks), { melody: [], chords: [], bass: [] });
  assert.equal(f.engine.playing, true);
  assert.equal(f.engine.presetName, 'ice');
  assert.equal(f.voices().length, 1);
  assert.equal(f.get('trioCount').textContent, '1 / 3 位伙伴');
  assert.equal(f.get('trioDemo').disabled, true);
  assert.equal(f.get('trioExport').disabled, false);
  assert.equal(f.get('trioPlay').getAttribute('aria-pressed'), 'true');
  f.get('trioDemo').click();
  assertLiveScore(f, [voice]);
  assert.deepEqual(plain(f.state.result), f.composer, 'live scheduling cannot rewrite the composition');
});

test('pointer gesture previews immediately and becomes the same timed, image-derived looping notes at release', async () => {
  const f = await fixture(), points = [[0, 0.15, 0.6], [180, 0.35, 0.4], [840, 0.75, 0.3]];
  f.pointer('pointerdown', points[0][1], points[0][2]);
  assert.equal(f.engine.triggers.length, 1);
  assert.equal(f.voices().length, 0, 'recording has not committed a partner yet');
  assert.equal(f.get('trioDemo').disabled, true);
  assert.match(f.get('trioHint').textContent, /记住你的节奏/);
  f.advance(180); f.pointer('pointermove', 0.35, 0.4);
  f.advance(660); f.pointer('pointermove', 0.75, 0.3);
  assert.equal(f.engine.triggers.length, 3);
  assert.deepEqual(f.engine.triggers.map(point => point.tMs), [0, 180, 840]);
  assert.deepEqual(f.engine.triggers.map(({ kind, note, color }) => ({ kind, note, color })), points.map(([, x, y]) => {
    const { kind, note, color } = sampleLivingNote(f.state.analysis, f.state.result, x, y); return { kind, note, color };
  }));
  f.advance(160); f.pointer('pointerup', 0.75, 0.3); await f.settle(0);
  assertLiveScore(f, [expectedVoice(f, 'partner-1', points, 1000)]);
  f.engine.inkEvents.forEach((note, i) => assert.ok(Math.abs(note.beat - [0, 0.3, 1.4, 4, 4.3, 5.4][i]) < 1e-10));
  assert.equal(f.get('trioCanvas').hasPointerCapture(7), false);
  assert.equal(f.engine.playing, true);
  assert.equal(f.voices().length, 1);
  assert.match(f.get('trioHint').textContent, /再划一小段/);
});

test('three partners is a hard limit; mute, wake, take over, remove and reset are real controls', async () => {
  const f = await fixture();
  await f.gesture(); await f.gesture(); await f.gesture();
  assert.equal(f.voices().length, 3);
  const original = plain(f.engine.inkEvents), previews = f.engine.triggers.length;
  await f.gesture();
  assert.deepEqual(f.engine.inkEvents, original);
  assert.equal(f.engine.triggers.length, previews);
  assert.match(f.get('trioStatus').textContent, /三位伙伴都到齐/);

  f.voices()[1].querySelector('.voice-toggle').click();
  assert.equal(f.voices()[1].classList.contains('muted'), true);
  assert.equal(f.voices()[1].querySelector('.voice-toggle').getAttribute('aria-pressed'), 'false');
  assert.ok(f.engine.inkEvents.every(event => event.voiceId !== 'partner-2'));
  assert.deepEqual(f.engine.inkEvents, original.filter(event => event.voiceId !== 'partner-2'));
  await f.gesture();
  assert.equal(f.voices().length, 3, 'a muted partner still owns its slot');
  f.voices()[1].querySelector('.voice-toggle').click();
  assert.deepEqual(f.engine.inkEvents, original);

  f.voices()[1].querySelector('.voice-actions').children[0].click();
  assert.equal(f.voices()[1].classList.contains('chosen'), true);
  assert.equal(f.document.activeElement, f.get('trioCanvas'));
  await f.gesture([[0, 0.1, 0.15], [600, 0.9, 0.8]], 900);
  assert.equal(f.voices().length, 3);
  assert.ok(f.engine.inkEvents.some(event => event.voiceId === 'partner-4'));
  assert.ok(f.engine.inkEvents.every(event => event.voiceId !== 'partner-2'));
  assert.deepEqual(f.engine.inkEvents.filter(event => ['partner-1', 'partner-3'].includes(event.voiceId)), original.filter(event => ['partner-1', 'partner-3'].includes(event.voiceId)));
  f.voices()[0].querySelector('.voice-remove').click();
  assert.equal(f.voices().length, 2);
  assert.ok(f.engine.inkEvents.every(event => event.voiceId !== 'partner-1'));
  assert.equal(f.document.activeElement, f.get('trioCanvas'));
  f.get('trioReset').click();
  assert.equal(f.voices().length, 0);
  assert.equal(f.engine.inkEvents.length, 0);
  assert.equal(f.engine.playing, false);
  assert.equal(f.get('trioExport').disabled, true);
  assert.equal(f.get('trioDemo').disabled, false);
});

test('canceling a takeover preserves the exact previous partner and removes uncommitted preview notes', async () => {
  const f = await fixture(); await f.gesture();
  const original = plain(f.engine.inkEvents);
  f.voices()[0].querySelector('.voice-actions').children[0].click();
  f.pointer('pointerdown', 0.1, 0.1); f.advance(300); f.pointer('pointermove', 0.9, 0.9);
  assert.equal(f.engine.triggers.length, 5);
  f.pointer('pointercancel'); await f.settle(0);
  assert.equal(f.voices().length, 1);
  assert.deepEqual(f.engine.inkEvents, original);
  assert.equal(f.get('trioCanvas').hasPointerCapture(7), false);
  assert.match(f.get('trioStatus').textContent, /这一笔没有留下.*原来的伙伴还在/);
  assert.equal(f.get('trioExport').disabled, false);
});

test('leaving live mode stops playback, restores the composer and cancels any uncommitted gesture', async () => {
  const f = await fixture(); await f.demo();
  f.pointer('pointerdown', 0.2, 0.3); f.advance(300); f.pointer('pointermove', 0.7, 0.6);
  f.get('composerModeBtn').click(); await f.settle(0);
  assert.equal(f.controller.active, false);
  assert.equal(f.get('liveLab').hidden, true);
  assert.equal(f.get('lab').hidden, false);
  assert.equal(f.calls.restore, 1);
  assert.equal(f.engine.playing, false);
  assert.deepEqual(plain(f.engine.result), f.composer);
  assert.equal(f.engine.presetName, f.state.preset);
  assert.equal(f.get('trioCanvas').hasPointerCapture(7), false);
  f.pointer('pointerup'); await f.settle(0);
  assert.equal(f.voices().length, 1, 'leaving discarded the second unfinished partner');
  f.get('liveModeBtn').click(); await f.settle(0);
  assert.equal(f.controller.active, true);
  assert.equal(f.voices().length, 1);
  assert.equal(f.engine.playing, false, 'returning to live mode does not autoplay');
});

test('leaving while ensureStarted is pending prevents stale autoplay and preserves composer preset', async () => {
  const f = await fixture();
  let resume;
  f.engine.ensureStarted = () => new Promise(resolve => { resume = resolve; });
  f.get('trioDemo').click();
  assert.equal(typeof resume, 'function');
  f.get('composerModeBtn').click(); await f.settle(0);
  const plays = f.engine.plays.length;
  resume(); await f.settle(0);
  assert.equal(f.engine.plays.length, plays);
  assert.equal(f.engine.playing, false);
  assert.deepEqual(plain(f.engine.result), f.composer);
  assert.equal(f.engine.presetName, f.state.preset, 'stale live startup cannot replace the restored composer sound');
});

test('leaving while ice preset is pending prevents stale autoplay after out-of-order preset completion', async () => {
  const f = await fixture(), requests = [];
  let version = 0;
  // Like Engine.setPreset, later requests supersede earlier pending loads.
  f.engine.setPreset = name => {
    const token = ++version;
    return new Promise(resolve => requests.push({ name, finish() { if (token === version) f.engine.presetName = name; resolve(); } }));
  };
  f.get('trioDemo').click(); await f.settle(0);
  assert.deepEqual(requests.map(request => request.name), ['ice']);
  f.get('composerModeBtn').click();
  assert.deepEqual(requests.map(request => request.name), ['ice', f.state.preset]);
  requests[1].finish(); await f.settle(0);
  requests[0].finish(); await f.settle(0);
  assert.equal(f.engine.playing, false);
  assert.equal(f.engine.plays.length, 0);
  assert.equal(f.engine.presetName, f.state.preset);
  assert.deepEqual(plain(f.engine.result), f.composer);
});

test('export passes exactly the audible live mix to WAV and MIDI and restores usable controls', async () => {
  const f = await fixture(); await f.gesture(); await f.gesture([[0, 0.9, 0.8], [300, 0.5, 0.3]], 1000);
  f.voices()[0].querySelector('.voice-toggle').click();
  const audible = plain(f.engine.inkEvents);
  const { liveTrio: _liveMarker, ...result } = plain(f.engine.result);
  f.get('trioExport').click();
  assert.equal(f.get('trioExportDialog').open, true);
  assert.equal(f.get('trioExportClose').disabled, true);
  assert.equal(f.get('liveModeBtn').disabled, true);
  assert.equal(f.engine.playing, false);
  await f.settle(0);
  assert.equal(f.exports.length, 1);
  assert.deepEqual(f.exports[0], { result, ink: audible, preset: 'ice', seconds: 20 });
  assert.ok(f.exports[0].ink.every(event => event.voiceId === 'partner-2'));
  assert.deepEqual(f.midis, [{ tracks: [['partner-1', audible.map(event => [event.beat, event.dur, event.note, event.vel])]], tempo: LIVE_TEMPO }]);
  assert.deepEqual(f.calls.offline, [true, false]);
  assert.equal(f.calls.prepare, 1);
  assert.equal(f.get('trioExportReady').hidden, false);
  assert.equal(f.get('trioExportClose').disabled, false);
  assert.equal(f.get('liveModeBtn').disabled, false);
  assert.match(f.get('trioAudioDownload').download, /-画中合奏-20秒\.wav$/);
  assert.match(f.get('trioMidiDownload').download, /-画中合奏\.mid$/);
  assert.match(f.get('trioAudioDownload').href, /^blob:/);
  f.get('trioExportClose').click();
  assert.equal(f.get('trioExportDialog').open, false);
  assert.equal(f.document.activeElement, f.get('trioExport'));
  assert.equal(f.get('trioAudioPreview').paused, true);
});

test('failed live export leaves all committed partners intact and the export button retryable', async () => {
  let attempts = 0;
  const f = await fixture({ renderWav: async () => { if (!attempts++) throw new Error('offline render failed'); return { blob: new Blob(['retry']) }; } });
  await f.gesture(); const original = plain(f.engine.inkEvents);
  f.get('trioExport').click(); await f.settle(0);
  assert.match(f.get('trioExportProgress').textContent, /offline render failed.*可以重试/);
  assert.deepEqual(f.engine.inkEvents, original);
  assert.equal(f.get('trioExportClose').disabled, false);
  assert.equal(f.get('trioExport').disabled, false);
  assert.equal(f.get('trioExportReady').hidden, true);
  f.get('trioExportClose').click(); f.get('trioExport').click(); await f.settle(0);
  assert.equal(f.get('trioExportReady').hidden, false);
  assert.equal(f.exports.length, 2);
  assert.deepEqual(f.exports[1].ink, original);
});

test('older partners keep playing at the same phase through a new gesture, its release and cancellation', async () => {
  const f = await fixture(); await f.gesture();
  const original = plain(f.engine.inkEvents), loadCount = f.engine.loads.length, playCount = f.engine.plays.length;
  f.engine.beat = 2.4;
  f.pointer('pointerdown', 0.1, 0.2);
  assert.equal(f.engine.playing, true);
  assert.equal(f.engine.beat, 2.4);
  assert.deepEqual(f.engine.inkEvents, original);
  f.advance(600); f.engine.beat = 3.4; f.pointer('pointermove', 0.8, 0.7);
  f.advance(60); f.engine.beat = 3.5; f.pointer('pointerup', 0.8, 0.7); await f.settle(0);
  assert.equal(f.engine.playing, true);
  assert.equal(f.engine.beat, 3.5);
  assert.equal(f.engine.loads.length, loadCount);
  assert.equal(f.engine.plays.length, playCount, 'adding a partner must not restart transport');
  assert.equal(f.engine.inkUpdates.at(-1).options.releaseHeld, false);
  assert.deepEqual(f.engine.inkEvents.filter(event => event.voiceId === 'partner-1'), original);
  const nextVoice = expectedVoice(f, 'partner-2', [[0, 0.1, 0.2], [600, 0.8, 0.7]], 660);
  nextVoice.offsetBeat = 3.7;
  assert.deepEqual(f.engine.inkEvents.filter(event => event.voiceId === 'partner-2'), plain(buildLivingScore(f.state.result, [nextVoice]).ink));

  const committed = plain(f.engine.inkEvents);
  f.engine.beat = 4.6; f.pointer('pointerdown', 0.3, 0.3);
  f.advance(120); f.pointer('pointermove', 0.6, 0.6); f.engine.beat = 4.8;
  f.pointer('pointercancel'); await f.settle(0);
  assert.equal(f.engine.playing, true);
  assert.equal(f.engine.beat, 4.8);
  assert.deepEqual(f.engine.inkEvents, committed);
  assert.equal(f.engine.inkUpdates.at(-1).options.releaseHeld, true, 'cancellation releases uncommitted preview tails');
  assert.equal(f.engine.loads.length, loadCount);
  assert.equal(f.engine.plays.length, playCount);
});

test('a fast swipe retains its release endpoint even when pointermove is throttled', async () => {
  const f = await fixture();
  f.pointer('pointerdown', 0.1, 0.2);
  f.advance(40); f.pointer('pointermove', 0.7, 0.6);
  assert.equal(f.engine.triggers.length, 1);
  f.advance(20); f.pointer('pointerup', 0.9, 0.8); await f.settle(0);
  assert.equal(f.engine.triggers.length, 2);
  assertLiveScore(f, [expectedVoice(f, 'partner-1', [[0, 0.1, 0.2], [60, 0.9, 0.8]], 60)]);
});

test('another touch cannot move, release, or cancel the active captured gesture', async () => {
  const f = await fixture();
  f.pointer('pointerdown', 0.1, 0.2, 7);
  f.advance(150);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) f.pointer(type, 0.95, 0.9, 8);
  assert.equal(f.engine.triggers.length, 1);
  assert.equal(f.voices().length, 0);
  assert.equal(f.get('trioCanvas').hasPointerCapture(7), true);
  assert.match(f.get('trioHint').textContent, /记住你的节奏/);
  f.pointer('pointerup', 0.6, 0.7, 7); await f.settle(0);
  assertLiveScore(f, [expectedVoice(f, 'partner-1', [[0, 0.1, 0.2], [150, 0.6, 0.7]], 150)]);
});

test('loading disables live actions until ready and changing paintings remembers each committed ensemble', async () => {
  const f = await fixture({ ready: false });
  for (const id of ['trioPlay', 'trioDemo', 'trioExport']) assert.equal(f.get(id).disabled, true);
  f.pointer('pointerdown'); f.pointer('pointerup');
  assert.equal(f.engine.triggers.length, 0);
  assert.equal(f.voices().length, 0);
  f.controller.sourceChanged(); await f.settle(0);
  assert.equal(f.get('trioDemo').disabled, false);
  await f.demo();
  const original = plain(f.engine.inkEvents), source = f.state.imageSource;
  f.controller.sourceLoading();
  assert.equal(f.engine.playing, false);
  for (const id of ['trioPlay', 'trioDemo', 'trioExport']) assert.equal(f.get(id).disabled, true);
  const plays = f.engine.plays.length, previews = f.engine.triggers.length;
  f.get('trioPlay').click(); f.get('trioDemo').click(); f.get('trioExport').click();
  f.pointer('pointerdown'); f.pointer('pointerup'); await f.settle(0);
  assert.equal(f.engine.plays.length, plays);
  assert.equal(f.engine.triggers.length, previews);
  assert.equal(f.exports.length, 0);
  f.state.imageSource = 'paintings/garden.jpg'; f.controller.sourceChanged(); await f.settle(0);
  assert.equal(f.voices().length, 0);
  assert.equal(f.get('trioDemo').disabled, false);
  assert.equal(f.get('trioExport').disabled, true);
  f.state.imageSource = source; f.controller.sourceChanged(); await f.settle(0);
  assert.equal(f.voices().length, 1);
  assert.deepEqual(f.engine.inkEvents, original);
  assert.equal(f.engine.playing, false);
  assert.equal(f.get('trioPlay').disabled, false);
});

test('automatic gesture limit commits once at 4.8 seconds and a later release cannot create another partner', async () => {
  const f = await fixture();
  f.pointer('pointerdown', 0.2, 0.3);
  f.advance(3000); f.pointer('pointermove', 0.8, 0.7);
  f.advance(1800); f.frame(); await f.settle(0);
  assertLiveScore(f, [expectedVoice(f, 'partner-1', [[0, 0.2, 0.3], [3000, 0.8, 0.7]], 4800)]);
  assert.equal(f.voices().length, 1);
  assert.equal(f.get('trioCanvas').hasPointerCapture(7), false);
  assert.equal(f.engine.playing, true);
  f.pointer('pointerup', 0.8, 0.7); await f.settle(0);
  assert.equal(f.voices().length, 1);
});

test('actual app delayed composer render cannot replace a live ensemble after mode switch', async () => {
  const f = await integratedFixture({ hash: '#p=prism' }), controller = f.controller;
  assert.equal(controller.active, false);
  f.get('tempoSlider').value = '117'; f.get('tempoSlider').dispatchEvent({ type: 'input' });
  f.get('liveModeBtn').click();
  f.get('trioDemo').click(); await f.settle(0);
  assert.equal(controller.active, true);
  assert.equal(f.engine.playing, true);
  const original = plain(f.engine.inkEvents);
  f.engine.beat = 2.75;
  await f.settle(250);
  assert.equal(f.state.result.tempo, 117, 'the pending composer render really ran');
  assert.equal(f.engine.result.tempo, LIVE_TEMPO);
  assert.equal(f.engine.result.bars, LIVE_BEATS / 4);
  assert.equal(f.engine.result.liveTrio, true);
  assert.deepEqual(plain(f.engine.result.tracks), { melody: [], chords: [], bass: [] });
  assert.deepEqual(f.engine.inkEvents, original);
  assert.equal(f.engine.playing, true);
  assert.equal(f.engine.beat, 2.75);
  assert.equal(f.get('trioCount').textContent, '1 / 3 位伙伴');
});

const savedFirstGesture = [[0, 0.1, 0.3], [187.25, 0.4, 0.6], [912.5, 0.8, 0.2]];
const savedSecondGesture = [[0, 0.85, 0.2], [333.375, 0.6, 0.4], [2077.5, 0.1, 0.8], [3125.25, 0.8, 0.7]];
async function savedDuet() {
  const f = await integratedFixture();
  await f.gesture(savedFirstGesture, 1076.5);
  f.engine.beat = 2.375;
  await f.gesture(savedSecondGesture, 3500.25);
  f.voices()[0].querySelector('.voice-toggle').click();
  f.get('trioSave').click();
  assert.equal(f.saved().length, 1, f.get('trioStatus').textContent);
  return f;
}

test('actual app saves two timed partners and restores exact loop, offset, mute and mode after a fresh initialization', async () => {
  const f = await savedDuet(), saved = f.saved()[0];
  const first = expectedVoice(f, 'partner-1', savedFirstGesture, 1076.5);
  first.muted = true;
  const second = expectedVoice(f, 'partner-2', savedSecondGesture, 3500.25);
  second.offsetBeat = 2.575;
  assert.equal(saved.experience, 'trio');
  assert.deepEqual(saved.ensemble, plain(livingScore.normalizeLivingEnsemble({ v: 1, tempo: LIVE_TEMPO, voices: [first, second] })));
  assert.equal(saved.ensemble.voices[0].loopBeats, 4);
  assert.equal(saved.ensemble.voices[1].loopBeats, 8);
  assert.deepEqual(saved.ensemble.voices.map(voice => voice.durationMs), [1076.5, 3500.25]);
  assert.deepEqual(saved.ensemble.voices[1].points.map(point => point.tMs), [0, 333.375, 2077.5, 3125.25]);
  assert.equal(saved.ensemble.voices[1].offsetBeat, 2.575);
  assert.match(f.get('trioStatus').textContent, /合奏已收藏.*1\/8/);
  assert.match(f.cards()[0].textContent, /画中合奏.*2 位伙伴.*100 BPM/);
  const audible = plain(f.engine.inkEvents);

  const reopened = await integratedFixture({ works: f.saved(), hash: '#p=garden' });
  assert.equal(reopened.controller.active, false);
  reopened.cards()[0].querySelector('.saved-open').click(); await reopened.settle();
  assert.equal(reopened.controller.active, true);
  assert.equal(reopened.get('liveLab').hidden, false);
  assert.equal(reopened.get('lab').hidden, true);
  assert.equal(reopened.state.painting, saved.painting);
  assert.equal(reopened.voices().length, 2);
  assert.equal(reopened.voices()[0].classList.contains('muted'), true);
  assert.equal(reopened.voices()[1].classList.contains('muted'), false);
  assert.deepEqual(reopened.engine.inkEvents, audible);
  assert.equal(reopened.engine.result.tempo, LIVE_TEMPO);
  assert.equal(reopened.engine.result.liveTrio, true);
  assert.equal(reopened.engine.playing, false);
  assert.equal(reopened.engine.plays.length, 0, 'opening a saved ensemble must not autoplay');
  assert.match(reopened.get('trioStatus').textContent, /伙伴回来了.*节奏与静音状态/);
  reopened.get('trioSave').click();
  assert.deepEqual(reopened.saved(), [saved], 'saving restored partners preserves the complete original record');
});

test('saving the same ensemble twice is idempotent while changing a partner mute state creates a distinct version', async () => {
  const f = await savedDuet(), original = f.saved(), writes = f.storage.writes;
  f.get('trioSave').click(); f.get('trioSave').click();
  assert.deepEqual(f.saved(), original);
  assert.equal(f.storage.writes, writes);
  assert.equal(f.cards().length, 1);
  assert.match(f.get('trioStatus').textContent, /合奏已经收藏.*没有重复占位置/);
  f.voices()[0].querySelector('.voice-toggle').click();
  f.get('trioSave').click();
  assert.equal(f.saved().length, 2);
  assert.equal(f.saved()[0].ensemble.voices[0].muted, false);
  assert.deepEqual(f.saved()[1], original[0]);
});

test('a new gesture after restoring partners gets a fresh ID and keeps both saved partners exactly', async () => {
  const firstPage = await savedDuet(), saved = firstPage.saved()[0];
  const f = await integratedFixture({ works: [saved], hash: '#p=prism' });
  f.cards()[0].querySelector('.saved-open').click(); await f.settle();
  await f.gesture([[0, 0.2, 0.8], [222.5, 0.7, 0.1]], 450.5);
  f.get('trioSave').click();
  assert.equal(f.saved().length, 2, f.get('trioStatus').textContent);
  const extended = f.saved()[0].ensemble;
  assert.equal(extended.voices.length, 3);
  assert.deepEqual(extended.voices.slice(0, 2), saved.ensemble.voices);
  assert.equal(new Set(extended.voices.map(voice => voice.id)).size, 3);
  assert.equal(extended.voices[2].id, 'partner-3');
  assert.equal(new Set(extended.voices.flatMap(voice => voice.events.map(event => event.id))).size,
    extended.voices.reduce((sum, voice) => sum + voice.events.length, 0));
});

test('live mute and volume recover hidden composer silence and synchronize both sets of widgets', async () => {
  const f = await integratedFixture({ hash: '#p=prism', controls: true });
  f.get('muteBtn').click();
  f.get('volumeSlider').value = '0'; f.get('volumeSlider').dispatchEvent({ type: 'input' });
  assert.equal(f.engine.muted, true);
  assert.equal(f.engine.volume, 0);
  f.get('liveModeBtn').click(); await f.settle(0);
  assert.equal(f.get('trioMute').getAttribute('aria-pressed'), 'true');
  assert.equal(Number(f.get('trioVolume').value), 0);
  f.get('trioMute').click();
  assert.equal(f.engine.muted, false);
  assert.equal(f.get('trioMute').getAttribute('aria-pressed'), 'false');
  assert.equal(f.get('muteBtn').getAttribute('aria-pressed'), 'false');
  f.get('trioMute').click();
  assert.equal(f.engine.muted, true);
  f.get('trioVolume').value = '34'; f.get('trioVolume').dispatchEvent({ type: 'input' });
  assert.equal(f.engine.volume, 0.34);
  assert.equal(f.engine.muted, false, 'raising the live slider must unmute hidden composer mute');
  for (const id of ['trioVolume', 'volumeSlider']) assert.equal(Number(f.get(id).value), 34);
  for (const id of ['trioMute', 'muteBtn']) assert.equal(f.get(id).getAttribute('aria-pressed'), 'false');
  f.get('composerModeBtn').click(); await f.settle(0);
  f.get('muteBtn').click();
  assert.equal(f.engine.muted, true, 'composer toggle reads current shared mute state after live changes');
});

test('failed live save keeps the playing ensemble and earlier saved record intact without success feedback', async () => {
  const f = await savedDuet(), originalSaved = f.saved();
  f.voices()[0].querySelector('.voice-toggle').click();
  const audible = plain(f.engine.inkEvents);
  f.engine.beat = 3.125; f.storage.failWrites = true;
  f.get('trioSave').click();
  assert.deepEqual(f.saved(), originalSaved);
  assert.deepEqual(f.engine.inkEvents, audible);
  assert.equal(f.engine.beat, 3.125);
  assert.equal(f.engine.playing, true);
  assert.equal(f.voices().length, 2);
  assert.equal(f.get('trioSave').disabled, false);
  assert.match(f.get('trioStatus').textContent, /本地空间|未允许保存/);
  assert.doesNotMatch(f.get('trioStatus').textContent, /已收藏|已经收藏/);
  f.storage.failWrites = false; f.get('trioSave').click();
  assert.equal(f.saved().length, 2);
  assert.match(f.get('trioStatus').textContent, /合奏已收藏/);
});
