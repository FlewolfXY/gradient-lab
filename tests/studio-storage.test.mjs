import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInk, encodeInk, decodeInk, loadWorks, saveWork, removeWork } from '../docs/studio-storage.js';

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
  for (let i = 0; i < 8; i++) saveWork(work(String(i)), store);
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
