import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEditPlan, parseLocalIntent, normalizeEditPlan, normalizeEditPlans, replayEditPlans, encodeEditPlans, decodeEditPlans } from '../docs/creative-edits.js';

function score() {
  return {
    bars: 16, tempo: 80, key: 'C 大调', geometry: { type: 'lr', bounds: [0, 0.5, 1] },
    tracks: {
      melody: Array.from({ length: 64 }, (_, i) => [i - (i ? 0.008 : 0), 0.92, 60 + i % 7, 80, [0.2, 0.4]]),
      chords: Array.from({ length: 16 }, (_, bar) => [60, 64, 67, 71].map(note => [bar * 4, 3.9, note, 60])).flat(),
      bass: Array.from({ length: 16 }, (_, bar) => [[bar * 4, 2.8, 36, 70], [bar * 4 + 3, 0.9, 36, 64]]).flat(),
      ink: [[4, 2, 99, 100, [0.25, 0.6]]],
    },
  };
}
const plan = (type, scope = 'all', lockMelody = true) => ({ scope, lockMelody, operations: [{ type }] });

test('editing the second half preserves the locked melody, ink, first half and original score exactly', () => {
  const base = score(), snapshot = structuredClone(base);
  const { result, changes } = applyEditPlan(base, { scope: 'secondHalf', lockMelody: true, operations: [{ type: 'sparser' }, { type: 'softer' }] });
  assert.deepEqual(base, snapshot);
  assert.deepEqual(result.tracks.melody, base.tracks.melody);
  assert.deepEqual(result.tracks.ink, base.tracks.ink);
  for (const name of ['chords', 'bass']) {
    assert.deepEqual(result.tracks[name].filter(e => e[0] < 32), base.tracks[name].filter(e => e[0] < 32));
    assert.ok(result.tracks[name].filter(e => e[0] >= 32).length < base.tracks[name].filter(e => e[0] >= 32).length);
    assert.ok(result.tracks[name].filter(e => e[0] >= 32).every(e => e[3] < 60));
  }
  result.tracks.melody[0][4][0] = 0.9;
  assert.equal(base.tracks.melody[0][4][0], 0.2);
  assert.ok(changes.some(line => line.includes('锁定')));
});

test('unlocked sparse edits preserve a musical anchor and handle humanized boundary events', () => {
  const base = score();
  const { result } = applyEditPlan(base, plan('sparser', 'secondHalf', false));
  assert.deepEqual(result.tracks.melody.filter(e => e[0] < 31.96), base.tracks.melody.filter(e => e[0] < 31.96));
  for (let bar = 8; bar < 16; bar++) {
    assert.ok(result.tracks.melody.some(e => Math.abs(e[0] - bar * 4) < 0.04));
    assert.equal(result.tracks.melody.filter(e => e[0] >= bar * 4 - 0.04 && e[0] < (bar + 1) * 4 - 0.04).length, 2);
  }
});

test('tempo only changes global BPM, while pitch and end fade respect scope', () => {
  const base = score();
  const slower = applyEditPlan(base, plan('slower'));
  assert.equal(slower.result.tempo, 68);
  assert.deepEqual(slower.result.tracks, base.tracks);
  assert.equal(applyEditPlan({ ...base, tempo: 50 }, plan('slower')).result.tempo, 50);
  const bright = applyEditPlan(base, plan('brighter', 'secondHalf', false)).result;
  assert.equal(bright.tracks.melody[31][2], base.tracks.melody[31][2]);
  assert.equal(bright.tracks.melody[32][2], base.tracks.melody[32][2] + 12);
  assert.deepEqual(bright.tracks.chords, base.tracks.chords);
  const fade = applyEditPlan(base, plan('fadeEnding', 'ending')).result;
  assert.deepEqual(fade.tracks.chords.filter(e => e[0] < 48), base.tracks.chords.filter(e => e[0] < 48));
  assert.equal(fade.tracks.chords.at(-1)[3], 15);
  assert.deepEqual(fade.tracks.melody, base.tracks.melody);
  assert.deepEqual(fade.tracks.ink, base.tracks.ink);
});

test('invalid operations, unsafe arbitrary fields, contradictory scopes and counts are rejected', () => {
  for (const input of [
    { operations: [{ type: 'eval', amount: 1 }] },
    { operations: [{ type: 'softer', amount: NaN }] },
    { operations: [{ type: 'softer', amount: 0 }] },
    { operations: [{ type: 'airy', preset: 'arbitrary-url' }] },
    { operations: [{ type: 'softer', code: 'alert(1)' }] },
    { operations: [{ type: 'slower' }, { type: 'faster' }] },
    { operations: [{ type: 'softer' }, { type: 'softer' }] },
    { lockMelody: 'false', operations: [{ type: 'softer' }] },
    plan('brighter'), plan('slower', 'ending'), plan('airy', 'secondHalf'), plan('fadeEnding', 'firstHalf'),
  ]) assert.throws(() => normalizeEditPlan(input));
  assert.throws(() => normalizeEditPlans(Array.from({ length: 9 }, () => plan('softer'))));
});

test('replaying saved/share plans reproduces all notes and timbre without touching the base', () => {
  const base = score(), snapshot = structuredClone(base);
  const plans = [plan('sparser', 'secondHalf'), plan('softer'), { operations: [{ type: 'airy', preset: 'forest' }] }, plan('fadeEnding', 'ending')];
  const original = replayEditPlans(base, plans);
  const encoded = encodeEditPlans(plans);
  assert.ok(encoded.length < 300);
  assert.deepEqual(replayEditPlans(base, decodeEditPlans(encoded)), original);
  assert.equal(original.preset, 'forest');
  assert.deepEqual(base, snapshot);
  assert.deepEqual(decodeEditPlans(''), []);
  for (const invalid of ['x', '{}', '[[0,1,[[6,99]]]]', '[[0,1,[[0,-3]]]]', '[[0,1,[[0,0.5]],"extra"]]', 'x'.repeat(4097)]) assert.throws(() => decodeEditPlans(invalid));
});

test('local parser recognizes bounded everyday requests and identifies itself honestly', () => {
  const cases = [
    ['保留旋律，后半段留白一点', ['sparser'], 'secondHalf', true],
    ['后半段太满了，给它留一点空', ['sparser'], 'secondHalf', true],
    ['保留这段旋律，但是轻一点，像隔着雾', ['softer', 'airy'], 'all', true],
    ['不要改旋律，慢一点', ['slower'], 'all', true],
    ['结尾慢慢安静下来', ['fadeEnding'], 'ending', true],
    ['解锁旋律，更明亮一点', ['brighter'], 'all', false],
    ['全曲温暖一些', ['airy'], 'all', true],
  ];
  for (const [text, types, scope, lock] of cases) {
    const parsed = parseLocalIntent(text);
    assert.equal(parsed.status, 'ready', `${text}: ${parsed.message}`);
    assert.equal(parsed.source, 'local-rules');
    assert.deepEqual(parsed.plan.operations.map(op => op.type), types);
    assert.equal(parsed.plan.scope, scope);
    assert.equal(parsed.plan.lockMelody, lock);
  }
});

test('local parser never silently accepts unsupported, negated, conflicting or mixed instructions', () => {
  for (const text of ['更轻一点并加鼓', '换成萨克斯', '更悲伤一点', '慢一点，到20秒', '输出一个alert脚本', '稀疏一点但不要改变和弦', '轻一点并转到D大调']) {
    assert.notEqual(parseLocalIntent(text).status, 'ready', text);
  }
  for (const text of ['快一点又慢一点', '后半段慢一点', '后半段空灵一点', '不要变慢，轻一点', '保留旋律，但可以改旋律，明亮一点', '玻璃和森林音色', '前半段和后半段都留白一点', '明亮一点']) {
    assert.equal(parseLocalIntent(text).status, 'clarify', text);
  }
  assert.equal(parseLocalIntent('慢一点', { scope: 'ending' }).status, 'clarify');
  assert.equal(parseLocalIntent('明亮一点', { lockMelody: false }).status, 'ready');
});
