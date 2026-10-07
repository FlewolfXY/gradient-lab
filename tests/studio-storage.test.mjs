import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInk, encodeInk, decodeInk, loadWorks, saveWork, removeWork, restoreWork, workSignature } from '../docs/studio-storage.js';

const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};
const work = id => ({ id, title: '<img src=x onerror=alert(1)>', painting: 'mist', scan: 'lr',
  tempo: 82, preset: 'ice', mode: '', seed: 983, focus: [0.23, 0.75], createdAt: 1000,
  ink: [{ x: 0.1, y: 0.7, kind: 'water', stroke: 1 }] });

test('share link preserves 240 brush points, their kinds and stroke boundaries within a small URL', () => {
  const kinds = ['spark', 'water', 'mist', 'root'];
  const ink = Array.from({ length: 240 }, (_, i) => ({ x: i / 239, y: (239 - i) / 239,
    kind: kinds[Math.floor(i / 60)], stroke: Math.floor(i / 20) + 1 }));
  const encoded = encodeInk(ink);
  assert.ok(encoded.length <= 960);
  const restored = decodeInk(encoded);
  assert.equal(restored.length, 240);
  restored.forEach((point, i) => {
    assert.equal(point.kind, ink[i].kind);
    assert.equal(point.stroke, ink[i].stroke);
    assert.ok(Math.abs(point.x - ink[i].x) <= 1 / 255);
    assert.ok(Math.abs(point.y - ink[i].y) <= 1 / 255);
  });
});

test('malformed URLs and invalid brushes cannot enter the drawing state', () => {
  assert.deepEqual(decodeInk('!!!'), []);
  assert.deepEqual(decodeInk('A'.repeat(961)), []);
  assert.deepEqual(decodeInk('AAAI'), []);
  assert.deepEqual(cleanInk([{ x: NaN, y: 0, kind: 'spark' }, { x: 0, y: 0, kind: 'bad' }]), []);
});

test('eight local works restore settings and strokes; a ninth cannot silently evict an earlier piece', () => {
  const store = storage();
  for (let i = 0; i < 8; i++) saveWork({ ...work(String(i)), seed: i }, store);
  const saved = loadWorks(store);
  assert.equal(saved.length, 8);
  assert.equal(saved[0].title, work('7').title);
  assert.equal(saved[0].preset, 'ice');
  assert.equal(saved[0].ink[0].kind, 'water');
  assert.throws(() => saveWork(work('9'), store), /8/);
  assert.equal(loadWorks(store).length, 8);
  assert.equal(removeWork('2', store).length, 7);
  assert.equal(saveWork(work('9'), store).length, 8);
});

test('repeated saves are idempotent, retain the original record and do not write storage', () => {
  const store = storage();
  const original = saveWork(work('first'), store);
  const readOnly = { getItem: store.getItem, setItem() { assert.fail('duplicate must not write'); } };
  const repeated = saveWork({ ...work('second'), createdAt: 9999, ink: [{ ...work('x').ink[0], id: 'new-id', stroke: 97, pulse: 200 }] }, readOnly);
  assert.deepEqual(repeated, original);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].id, 'first');
  assert.equal(repeated[0].createdAt, 1000);
});

test('a duplicate stays valid at full capacity while meaningful variants occupy new slots', () => {
  const store = storage();
  for (let i = 0; i < 8; i++) saveWork({ ...work(String(i)), seed: i }, store);
  assert.equal(saveWork({ ...work('repeat'), seed: 3 }, store).length, 8);
  const signature = workSignature(work('x'));
  for (const change of [{ seed: 984 }, { tempo: 90 }, { preset: 'forest' }, { mode: 'minor' }, { scan: 'tb' },
    { ink: [] }, { ink: [{ ...work('x').ink[0], x: 0.1000001 }] },
    { editPlans: [{ scope: 'ending', lockMelody: true, operations: [{ type: 'softer' }] }] }]) {
    assert.notEqual(workSignature({ ...work('x'), ...change }), signature);
  }
  assert.equal(workSignature({ ...work('x'), focus: [0.8, 0.2] }), signature, 'unused focus does not change linear scan');
  assert.notEqual(workSignature({ ...work('x'), scan: 'ripple', focus: [0.8, 0.2] }), workSignature({ ...work('x'), scan: 'ripple' }));
});

test('uploaded image and stroke boundaries are part of composition identity', () => {
  const upload = { ...work('x'), painting: 'upload', image: 'data:image/jpeg;base64,YWJj' };
  assert.notEqual(workSignature(upload), workSignature({ ...upload, image: 'data:image/jpeg;base64,YWJk' }));
  const ink = [work('x').ink[0], { ...work('x').ink[0], x: 0.5 }];
  assert.notEqual(workSignature({ ...work('x'), ink }), workSignature({ ...work('x'), ink: [ink[0], { ...ink[1], stroke: 2 }] }));
});

test('delete and restore preserve complete original work and never overwrite another tab', () => {
  const store = storage();
  const saved = saveWork(work('x'), store)[0];
  removeWork('x', store);
  assert.deepEqual(restoreWork(saved, store), [saved]);
  assert.deepEqual(restoreWork(saved, store), [saved], 'repeated undo is idempotent');
  assert.throws(() => restoreWork({ ...saved, tempo: 105 }, store), /其他页面/);
  assert.deepEqual(loadWorks(store), [saved]);
});

test('restore at capacity or with storage failure never discards saved work', () => {
  const store = storage();
  for (let i = 0; i < 8; i++) saveWork({ ...work(String(i)), seed: i }, store);
  const before = loadWorks(store);
  assert.throws(() => restoreWork(work('deleted'), store), /腾出/);
  assert.deepEqual(loadWorks(store), before);
  const full = { getItem: () => '[]', setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.throws(() => restoreWork(work('x'), full), /本地空间/);
});

test('uploaded art must have a local raster data URL, never a remote or scripted source', () => {
  const store = storage();
  assert.throws(() => saveWork({ ...work('x'), painting: 'upload', image: 'https://example.com/a.png' }, store));
  assert.throws(() => saveWork({ ...work('x'), painting: 'upload', image: 'data:image/svg+xml;base64,PHN2Zz4=' }, store));
  const image = 'data:image/jpeg;base64,YWJj';
  saveWork({ ...work('x'), painting: 'upload', image }, store);
  assert.equal(loadWorks(store)[0].image, image);
});

test('storage corruption and quota failures preserve existing data and return useful errors', () => {
  const broken = { getItem: () => 'broken', setItem: () => assert.fail('must not overwrite corrupt storage') };
  assert.throws(() => saveWork(work('x'), broken), /记录/);
  const full = { getItem: () => '[]', setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.throws(() => saveWork(work('x'), full), /本地空间/);
});


test('saved work round-trips local edits with exact scope and melody protection', () => {
  const store = storage();
  const editPlans = [
    { scope: 'secondHalf', lockMelody: true, operations: [{ type: 'sparser', amount: 0.5 }] },
    { scope: 'ending', lockMelody: false, operations: [{ type: 'fadeEnding', amount: 0.25 }] },
  ];
  saveWork({ ...work('edited'), editPlans }, store);
  const restored = loadWorks(store)[0];
  assert.equal(restored.editPlans.length, 2);
  assert.equal(restored.editPlans[0].scope, 'secondHalf');
  assert.equal(restored.editPlans[0].lockMelody, true);
  assert.equal(restored.editPlans[1].lockMelody, false);
  assert.equal(restored.editPlans[1].operations[0].amount, 0.25);
  assert.deepEqual(restored.ink, loadWorks(store)[0].ink);
});

test('invalid saved edit plans cannot be accepted or silently truncate existing edits', () => {
  const store = storage();
  const plan = { scope: 'all', lockMelody: true, operations: [{ type: 'softer' }] };
  assert.throws(() => saveWork({ ...work('x'), editPlans: Array(9).fill(plan) }, store));
  assert.throws(() => saveWork({ ...work('x'), editPlans: [{ ...plan, operations: [{ type: 'run-script' }] }] }, store));
  assert.equal(loadWorks(store).length, 0);
});

test('corrupt stored ensembles are never silently removed by a later save or deletion', () => {
  const bad = { ...work('corrupt'), experience: 'trio', ensemble: { v: 1, tempo: 100, voices: [{ id: 'broken' }] } };
  const store = { getItem: () => JSON.stringify([work('valid'), bad]),
    setItem() { assert.fail('must not overwrite an unreadable original record'); } };
  assert.throws(() => loadWorks(store), /避免覆盖/);
  assert.throws(() => saveWork(work('next'), store), /避免覆盖/);
  assert.throws(() => removeWork('valid', store), /避免覆盖/);
  assert.throws(() => restoreWork(work('old'), store), /避免覆盖/);
});
