import test from 'node:test';
import assert from 'node:assert/strict';
import { installCreativeStudio } from '../docs/creative-studio.js';
import { replayEditPlans } from '../docs/creative-edits.js';

class Element extends EventTarget {
  constructor(id = '') { super(); this.id = id; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.classList = { add() {}, remove() {} }; this.children = []; }
  click() { this.dispatchEvent(new Event('click')); }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return this.submit; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}
function fixture() {
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const chips = ['sparser', 'softer', 'slower', 'airy'].map(type => { const e = new Element(); e.dataset.edit = type; return e; });
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: get, createElement: () => new Element(), querySelectorAll: selector => selector === '[data-edit]' ? chips : [] };
  get('editIntentForm').submit = new Element(); get('lockMelody').checked = true; get('editScope').value = 'secondHalf';
  const base = { tempo: 80, bars: 8, tracks: { melody: [[0, 1, 60, 90], [17, 1, 65, 100]], chords: [[0, 4, 48, 80], [0, 4, 52, 80], [17, 4, 50, 80], [17, 4, 53, 80]], bass: [[0, 2, 36, 80], [17, 2, 38, 80]] } };
  const state = { result: structuredClone(base), tempo: 80, preset: 'piano', seed: 918, editPlans: [], ink: [{ kind: 'spark', note: 70, beat: 4, dur: 1, vel: 90 }] };
  const engine = { ready: Promise.resolve(), presetName: 'piano', stop() {}, load(result) { this.result = result; }, setInks() {}, async setPreset(preset) { this.presetName = preset; } };
  const snapshot = () => structuredClone({ tempo: state.tempo, preset: state.preset, seed: state.seed, editPlans: state.editPlans });
  const api = { state, engine, snapshot, settleRender() {}, restore(value) { Object.assign(state, structuredClone(value)); }, render() { state.result = replayEditPlans({ ...structuredClone(base), tempo: state.tempo }, state.editPlans).result; }, stopPlayback() {}, setOffline() {}, async prepareOffline() {} };
  const controller = installCreativeStudio(api);
  return { get, chips, state, controller, base, cleanup() { globalThis.document = previousDocument; } };
}

test('proposal/discard leaves music exact; accepting changes scoped accompaniment and undo restores exact notes', async () => {
  const f = fixture();
  try {
    const original = structuredClone(f.state), chip = f.chips[0];
    chip.click();
    assert.equal(f.get('editDialog').open, true);
    assert.deepEqual(f.state, original);
    f.get('discardEdit').click();
    assert.deepEqual(f.state, original);
    chip.click(); f.get('acceptEdit').click();
    assert.equal(f.state.editPlans.length, 1);
    assert.deepEqual(f.state.result.tracks.melody, original.result.tracks.melody);
    assert.deepEqual(f.state.ink, original.ink);
    assert.deepEqual(f.state.result.tracks.chords.filter(e => e[0] < 16), original.result.tracks.chords.filter(e => e[0] < 16));
    assert.ok(f.state.result.tracks.chords.length < original.result.tracks.chords.length);
    f.get('undoEditBtn').click();
    assert.deepEqual(f.state.result.tracks, original.result.tracks);
    assert.equal(f.state.seed, original.seed);
  } finally { f.cleanup(); }
});

test('global edits become intuitive settings, not repeat-applied plans, and remain undoable', () => {
  const f = fixture();
  try {
    f.chips.find(c => c.dataset.edit === 'slower').click(); f.get('acceptEdit').click();
    assert.equal(f.state.tempo, 68); assert.equal(f.state.editPlans.length, 0);
    f.chips.find(c => c.dataset.edit === 'airy').click(); f.get('acceptEdit').click();
    assert.equal(f.state.preset, 'ice'); assert.equal(f.state.editPlans.length, 0);
    f.get('undoEditBtn').click(); assert.equal(f.state.preset, 'piano'); assert.equal(f.state.tempo, 68);
    f.get('undoEditBtn').click(); assert.equal(f.state.tempo, 80);
  } finally { f.cleanup(); }
});

test('imported/saved plans remain reversible even without session undo snapshots', () => {
  const f = fixture();
  try {
    f.chips[0].click(); f.get('acceptEdit').click();
    f.controller.changed(); // parameter change or restored work clears in-session snapshots
    assert.equal(f.get('undoEditBtn').hidden, false);
    f.get('undoEditBtn').click();
    assert.equal(f.state.editPlans.length, 0);
    assert.deepEqual(f.state.result.tracks, f.base.tracks);
  } finally { f.cleanup(); }
});

test('stale model response is ignored after newer settings, and checked melody lock rejects attempted unlock', async () => {
  const f = fixture(), previousFetch = globalThis.fetch;
  try {
    let respond;
    globalThis.fetch = () => new Promise(resolve => { respond = resolve; });
    f.get('editIntent').value = '后半段轻一点';
    f.get('editIntentForm').dispatchEvent(new Event('submit', { cancelable: true }));
    f.controller.changed();
    respond({ ok: true, json: async () => ({ source: 'deepseek', status: 'ready', plan: { scope: 'secondHalf', lockMelody: true, operations: [{ type: 'softer' }] } }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.notEqual(f.get('editDialog').open, true);
    assert.equal(f.state.editPlans.length, 0);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ source: 'deepseek', status: 'ready', plan: { scope: 'secondHalf', lockMelody: false, operations: [{ type: 'brighter' }] } }) });
    f.get('editIntentForm').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(f.get('editFeedback').textContent, /锁定/);
    assert.notEqual(f.get('editDialog').open, true);
    assert.deepEqual(f.state.result.tracks.melody, f.base.tracks.melody);
  } finally { globalThis.fetch = previousFetch; f.cleanup(); }
});
