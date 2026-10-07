import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, plain } from './app-fixture.mjs';

const musicalInk = ink => plain(ink.map(({ x, y, kind, stroke, beat, note, dur, vel }) => ({ x, y, kind, stroke, beat, note, dur, vel })));
const savedWork = (id = 'saved-original') => ({
  id, title: '带笔迹与修改的蓝雾', createdAt: 1760000000123,
  painting: 'upload', image: 'data:image/jpeg;base64,YWJj', scan: 'ripple',
  tempo: 76, preset: 'forest', mode: 'minor', seed: 1099, focus: [0.23, 0.7],
  ink: [{ x: 0.1, y: 0.7, kind: 'water', stroke: 1 }, { x: 0.3, y: 0.4, kind: 'mist', stroke: 2 }],
  editPlans: [{ scope: 'secondHalf', lockMelody: true, operations: [{ type: 'softer', amount: 0.7 }] }],
});

test('actual app initializes empty controls and repeated save clicks deduplicate with visible feedback', async () => {
  const f = await appFixture();
  assert.equal(f.get('saveBtn').disabled, false);
  assert.equal(f.get('inkUndo').disabled, true);
  assert.equal(f.get('inkClear').disabled, true);
  assert.equal(f.get('undoDeleteBtn').hidden, true);
  assert.equal(f.cards().length, 0);

  f.get('saveBtn').click();
  const original = f.saved();
  assert.equal(original.length, 1);
  assert.equal(f.cards().length, 1);
  assert.match(f.get('saveFeedback').textContent, /已收藏.*1\/8/);
  const writes = f.storage.writes;
  f.get('saveBtn').click(); f.get('saveBtn').click();
  assert.deepEqual(f.saved(), original, 'duplicate clicks preserve original ID, date and complete contents');
  assert.equal(f.storage.writes, writes);
  assert.equal(f.cards().length, 1);
  assert.match(f.get('saveFeedback').textContent, /这版已经收藏.*没有重复/);
  assert.deepEqual(f.actions.filter(event => event.action.startsWith('work_')).map(event => event.action),
    ['work_saved', 'work_already_saved', 'work_already_saved']);

  f.document.querySelector('[data-preset="ice"]').click();
  assert.equal(f.get('saveFeedback').textContent, '');
  f.get('saveBtn').click();
  assert.equal(f.saved().length, 2, 'a real preset control change creates a meaningful version');
  assert.equal(f.saved()[0].preset, 'ice');
  assert.deepEqual(f.saved()[1], original[0]);
});

test('actual clear and undo restore mapped brush audio, then new strokes undo independently', async () => {
  const f = await appFixture();
  await f.stroke('water', [[0.12, 0.6], [0.25, 0.5]]);
  await f.stroke('root', [[0.55, 0.3], [0.7, 0.4]]);
  const original = musicalInk(f.state.ink);
  assert.equal(original.length, 4);
  assert.equal(new Set(original.map(mark => mark.stroke)).size, 2);
  assert.ok(original.every(mark => Number.isFinite(mark.beat) && Number.isFinite(mark.note)));
  assert.deepEqual(musicalInk(f.engine.inkEvents), original);
  const hash = f.location.hash;

  f.get('inkClear').click(); await f.settle();
  assert.equal(f.state.ink.length, 0);
  assert.equal(f.engine.inkEvents.length, 0);
  assert.equal(f.get('inkClear').disabled, true);
  assert.equal(f.get('inkUndo').disabled, false, 'clear is undoable even with an empty canvas');
  assert.match(f.get('status').textContent, /笔迹已清空/);
  assert.equal(new URLSearchParams(f.location.hash.slice(1)).has('i'), false);

  f.get('inkUndo').click(); await f.settle();
  assert.deepEqual(musicalInk(f.state.ink), original);
  assert.deepEqual(musicalInk(f.engine.inkEvents), original);
  assert.equal(f.location.hash, hash);
  assert.equal(f.get('inkClear').disabled, false);
  assert.match(f.get('status').textContent, /笔迹和声音都回来了/);
  await f.stroke('mist', [[0.83, 0.8], [0.91, 0.7]]);
  assert.equal(f.state.ink.length, 6);
  assert.ok(f.state.ink.at(-1).stroke > original.at(-1).stroke);
  f.get('inkUndo').click(); await f.settle();
  assert.deepEqual(musicalInk(f.state.ink), original, 'new stroke undo must not reapply an old clear');
  f.get('inkUndo').click(); await f.settle();
  assert.deepEqual(musicalInk(f.state.ink), original.filter(mark => mark.stroke === original[0].stroke));
  f.get('inkUndo').click(); await f.settle();
  assert.equal(f.state.ink.length, 0);
  assert.equal(f.get('inkUndo').disabled, true);
});

test('gallery selection discards old clear history and the new painting starts its own stroke history', async () => {
  const f = await appFixture();
  await f.stroke('spark', [[0.2, 0.3], [0.4, 0.5]]);
  f.get('inkClear').click(); await f.settle();
  assert.equal(f.get('inkUndo').disabled, false);
  f.document.querySelector('.thumb[data-id="garden"]').click(); await f.settle();
  assert.equal(f.state.painting, 'garden');
  assert.equal(f.state.ink.length, 0);
  assert.equal(f.get('inkUndo').disabled, true);
  assert.equal(f.get('inkClear').disabled, true);
  f.get('inkUndo').click(); await f.settle();
  assert.equal(f.state.ink.length, 0, 'old painting must not return through disabled undo');
  await f.stroke('mist', [[0.6, 0.7]]);
  f.get('inkUndo').click(); await f.settle();
  assert.equal(f.state.ink.length, 0);
  assert.equal(f.get('inkUndo').disabled, true, 'no old snapshots survive after undoing the new painting stroke');
});

test('saved-card delete and undo preserve the exact original work and move keyboard focus usefully', async () => {
  const f = await appFixture({ works: [savedWork()] });
  const original = f.saved()[0];
  f.cards()[0].querySelector('.saved-delete').click();
  assert.equal(f.saved().length, 0);
  assert.equal(f.cards().length, 0);
  assert.equal(f.get('undoDeleteBtn').hidden, false);
  assert.equal(f.document.activeElement, f.get('undoDeleteBtn'));
  assert.match(f.get('collectionFeedback').textContent, /已移除.*最近 8 次删除.*刷新或关闭/);

  f.get('undoDeleteBtn').click();
  assert.deepEqual(f.saved(), [original]);
  assert.equal(f.cards().length, 1);
  assert.equal(f.get('undoDeleteBtn').hidden, true);
  const open = f.cards()[0].querySelector('.saved-open');
  assert.equal(f.document.activeElement, open);
  assert.match(f.get('collectionFeedback').textContent, /原来的参数、笔迹和修改都在/);
  open.click(); await f.settle();
  for (const field of ['painting', 'title', 'scan', 'tempo', 'preset', 'mode', 'seed']) assert.equal(f.state[field], original[field]);
  assert.deepEqual(plain(f.state.focus), original.focus);
  assert.deepEqual(plain(f.state.editPlans), original.editPlans);
  assert.equal(f.state.imageSource, original.image);
  assert.equal(f.state.ink.length, original.ink.length);
  assert.equal(f.get('inkUndo').disabled, false, 'reopened strokes remain erasable');
  f.get('saveBtn').click();
  assert.deepEqual(f.saved(), [original], 'restoring and saving a work is still idempotent');
});

test('failed delete and failed restore keep records and offer a retry through the same controls', async () => {
  const f = await appFixture({ works: [savedWork()] });
  const original = f.saved();
  f.storage.failWrites = true;
  f.cards()[0].querySelector('.saved-delete').click();
  assert.deepEqual(f.saved(), original);
  assert.equal(f.get('undoDeleteBtn').hidden, true);
  assert.match(f.get('collectionFeedback').textContent, /没能删除/);
  f.storage.failWrites = false;
  f.cards()[0].querySelector('.saved-delete').click();
  f.storage.failWrites = true;
  f.get('undoDeleteBtn').click();
  assert.equal(f.cards().length, 0);
  assert.equal(f.get('undoDeleteBtn').hidden, false, 'failed restore keeps the undo action available');
  assert.match(f.get('collectionFeedback').textContent, /本地空间/);
  f.storage.failWrites = false;
  f.get('undoDeleteBtn').click();
  assert.deepEqual(f.saved(), original);
  assert.equal(f.get('undoDeleteBtn').hidden, true);
});


test('full collection recovery lets an older deleted work be chosen after a slot is freed', async () => {
  const works = Array.from({ length: 8 }, (_, i) => ({ ...savedWork(`original-${i}`), seed: 1099 + i }));
  const f = await appFixture({ works });
  const originals = f.saved(), removed = originals[0], other = originals[1];
  const remove = id => {
    const card = f.cards().find(item => item.dataset.workId === id);
    assert.ok(card, `Saved card ${id} must exist before deletion`);
    card.querySelector('.saved-delete').click();
  };
  remove(removed.id);
  assert.equal(f.saved().length, 7);
  f.get('saveBtn').click();
  assert.equal(f.saved().length, 8);
  const newlySaved = f.saved().find(work => !originals.some(original => original.id === work.id));
  assert.ok(newlySaved);
  f.get('undoDeleteBtn').click();
  assert.match(f.get('collectionFeedback').textContent, /腾出一个位置/);
  assert.equal(f.saved().length, 8);
  assert.equal(f.get('undoDeleteBtn').hidden, false);
  assert.equal(f.get('deletedWorkSelect').value, removed.id);

  remove(other.id);
  assert.equal(f.saved().length, 7);
  assert.equal(f.get('deletedWorkLabel').hidden, false);
  assert.deepEqual(f.get('deletedWorkSelect').children.map(option => option.value), [other.id, removed.id]);
  f.get('deletedWorkSelect').value = removed.id;
  f.get('deletedWorkSelect').dispatchEvent({ type: 'change' });
  f.get('undoDeleteBtn').click();
  assert.equal(f.saved().length, 8);
  assert.deepEqual(f.saved().find(work => work.id === removed.id), removed);
  assert.deepEqual(f.saved().find(work => work.id === newlySaved.id), newlySaved);
  assert.equal(f.saved().some(work => work.id === other.id), false);
  assert.equal(f.get('deletedWorkSelect').value, other.id);
  assert.equal(f.get('undoDeleteBtn').hidden, false, 'the other deleted work is still recoverable');
  assert.equal(f.get('deletedWorkLabel').hidden, true);
  assert.equal(f.document.activeElement, f.cards().find(card => card.dataset.workId === removed.id).querySelector('.saved-open'));
});
