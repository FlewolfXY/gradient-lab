import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEditPlan } from '../docs/creative-edits.js';
import { planEditPreview } from '../docs/creative-preview.js';

const score = (tempo = 80, bars = 16) => ({ tempo, bars, tracks: {
  melody: [[0, 1, 72, 90]],
  chords: Array.from({ length: bars }, (_, bar) => [bar * 4, 3.8, 48, 80]),
  bass: [],
} });
function compare(before, scope, operations, ink = []) {
  const plan = { scope, lockMelody: true, operations };
  const { result: after } = applyEditPlan(before, plan);
  return planEditPreview(before, after, plan, ink);
}

test('each edit scope compares the same bounded musical region', () => {
  const expected = { all: [0, 16, 1, 4], firstHalf: [0, 16, 1, 4], secondHalf: [32, 48, 9, 12], ending: [48, 64, 13, 16] };
  for (const [scope, bounds] of Object.entries(expected)) {
    const passage = compare(score(), scope, [{ type: 'softer' }]);
    assert.deepEqual([passage.startBeat, passage.endBeat, passage.firstBar, passage.lastBar], bounds);
    assert.equal(passage.beforeSeconds, 12);
    assert.equal(passage.afterSeconds, 12);
  }
});

test('fade previews include all four ending bars even though the first is unchanged', () => {
  for (const tempo of [50, 80, 120]) {
    for (const scope of ['all', 'secondHalf', 'ending']) {
      const passage = compare(score(tempo), scope, [{ type: 'fadeEnding' }]);
      assert.equal(passage.startBeat, 48);
      assert.equal(passage.endBeat, 64);
      assert.equal(passage.beforeSeconds, 16 * 60 / tempo);
      assert.equal(passage.afterSeconds, passage.beforeSeconds);
      assert.ok(passage.afterSeconds >= 8);
    }
  }
});

test('tempo changes adjust preview duration rather than comparing different bars', () => {
  for (const type of ['slower', 'faster']) {
    const before = score();
    const plan = { scope: 'all', lockMelody: true, operations: [{ type }, { type: 'fadeEnding' }] };
    const { result: after } = applyEditPlan(before, plan);
    const passage = planEditPreview(before, after, plan);
    assert.equal(passage.startBeat, 48);
    assert.equal(passage.endBeat, 64);
    assert.equal(passage.beforeSeconds * before.tempo / 60, 16);
    assert.equal(passage.afterSeconds * after.tempo / 60, 16);
    assert.notEqual(passage.beforeSeconds, passage.afterSeconds);
  }
});

test('sparse and no-op bars are skipped, and previews never cross their scope', () => {
  const before = score();
  before.tracks.chords = [[0, 4, 48, 80], [20, 4, 48, 80], [20, 4, 52, 80], [60, 4, 48, 80], [60, 4, 52, 80]];
  for (const scope of ['all', 'firstHalf']) {
    const passage = compare(before, scope, [{ type: 'sparser' }]);
    assert.equal(passage.startBeat, 20);
    assert.equal(passage.endBeat, scope === 'all' ? 36 : 32);
  }
  for (const scope of ['secondHalf', 'ending']) {
    const passage = compare(before, scope, [{ type: 'sparser' }]);
    assert.equal(passage.startBeat, 60);
    assert.equal(passage.endBeat, 64);
    assert.equal(passage.beforeSeconds, 3);
  }
});

test('a no-op fade does not hide another real edit behind a silent ending', () => {
  const before = score();
  before.tracks.chords = [[20, 4, 48, 80], [20, 4, 52, 80]];
  const passage = compare(before, 'all', [{ type: 'sparser' }, { type: 'fadeEnding' }]);
  assert.equal(passage.startBeat, 20);
  assert.equal(passage.endBeat, 36);
});

test('both previews include early humanized attacks at the selected bar boundary', () => {
  const before = score();
  before.tracks.chords = [[31.995, 4, 48, 80], [36, 4, 50, 80]];
  const passage = compare(before, 'secondHalf', [{ type: 'softer' }]);
  assert.equal(passage.startBeat, 31.995);
  assert.equal(passage.firstBar, 9);
  assert.equal(passage.endBeat, 48);
  assert.equal(passage.beforeSeconds, passage.afterSeconds);
});

test('global sound-only previews skip silence and can find hand-drawn notes', () => {
  const before = score();
  before.tracks = { melody: [], chords: [], bass: [] };
  const passage = compare(before, 'all', [{ type: 'airy' }], [{ beat: 20, dur: 1, note: 72, vel: 90 }]);
  assert.equal(passage.startBeat, 20);
  assert.equal(passage.endBeat, 36);
  const silent = compare(before, 'all', [{ type: 'airy' }]);
  assert.equal(silent.startBeat, 0);
  assert.equal(silent.endBeat, 16);
});

test('short scores stop at their ending without wrapping or negative starts', () => {
  const passage = compare(score(50, 2), 'ending', [{ type: 'fadeEnding' }]);
  assert.equal(passage.startBeat, 0);
  assert.equal(passage.endBeat, 8);
  assert.equal(passage.beforeSeconds, 9.6);
});

test('change detection counts duplicate notes and never mutates either score', () => {
  const before = score();
  before.tracks.chords = [[0, 4, 48, 80], [16, 4, 48, 80], [16, 4, 48, 80]];
  const original = structuredClone(before);
  const passage = compare(before, 'all', [{ type: 'sparser' }]);
  assert.equal(passage.startBeat, 16);
  assert.deepEqual(before, original);
});
