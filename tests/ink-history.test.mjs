import test from 'node:test';
import assert from 'node:assert/strict';
import { createInkHistory } from '../docs/ink-history.js';
import { cleanInk } from '../docs/studio-storage.js';

const mark = (stroke, x = 0.2) => ({ x, y: 0.7, kind: 'water', stroke });

test('clear is a single reversible action, followed by normal stroke undo', () => {
  const history = createInkHistory();
  const first = [mark(1)], second = [...first, mark(2, 0.4)];
  history.remember([]); history.remember(first); history.remember(second);
  assert.equal(history.canUndo([]), true);
  const restored = history.undo([]);
  assert.deepEqual(restored, cleanInk(second));
  assert.deepEqual(history.undo(restored), cleanInk(first));
  assert.deepEqual(history.undo(first), []);
  assert.equal(history.canUndo([]), false);
});

test('drawing after clearing can be undone before restoring cleared ink', () => {
  const history = createInkHistory(), original = [mark(12)];
  history.remember(original); history.remember([]);
  assert.deepEqual(history.undo([mark(13)]), []);
  assert.deepEqual(history.undo([]), cleanInk(original));
});

test('history snapshots do not alias current ink and changing artwork resets history', () => {
  const history = createInkHistory(), original = [mark(1)];
  history.remember(original); original[0].x = 0.9;
  assert.equal(history.undo([])[0].x, 0.2);
  history.remember([mark(2)]); history.reset();
  assert.equal(history.canUndo([]), false);
  assert.deepEqual(history.undo([]), []);
});

test('restored works remain undoable by stroke and history is bounded', () => {
  const history = createInkHistory(2);
  const original = [mark(1), mark(2), mark(2, 0.5)];
  assert.equal(history.canUndo(original), true);
  assert.deepEqual(history.undo(original), cleanInk([mark(1)]));
  history.remember([mark(1)]); history.remember([mark(2)]); history.remember([mark(3)]);
  assert.deepEqual(history.undo([]), cleanInk([mark(3)]));
  assert.deepEqual(history.undo([]), cleanInk([mark(2)]));
  assert.equal(history.canUndo([]), false);
});
