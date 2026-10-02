import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeImage, brightestPoint, summon } from '../docs/paint2score.js';
import { buildMidi } from '../docs/midi.js';

// Canvas sampling is mocked; these tests exercise the image-to-score rules and
// binary export without requiring a browser or any third-party dependencies.
function analyze(width, height, pixel = () => [100, 150, 200, 255]) {
  const original = globalThis.document;
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0 };
      canvas.getContext = () => ({
        drawImage() {},
        getImageData() {
          const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
          for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) data.set(pixel(x, y), (y * canvas.width + x) * 4);
          }
          return { data };
        },
      });
      return canvas;
    },
  };
  try { return analyzeImage({ width, height }); }
  finally { globalThis.document = original; }
}

function finiteScore(result) {
  for (const values of Object.values(result.tracks)) {
    for (const event of values) {
      assert.ok(event.slice(0, 4).every(Number.isFinite));
      assert.ok(event[0] >= 0 && event[1] > 0);
      assert.ok(event[2] >= 0 && event[2] <= 127);
    }
  }
  assert.ok(result.barFeats.every(bar => Object.values(bar).every(Number.isFinite)));
  assert.ok(result.geometry.bounds.every(Number.isFinite));
}

test('single-pixel, single-row and single-column images produce finite scores in every scan', () => {
  for (const [width, height] of [[1, 1], [1, 30], [30, 1]]) {
    for (const color of [[255, 255, 255, 255], [0, 0, 0, 255]]) {
      const img = analyze(width, height, () => color);
      assert.ok([...img.edges].every(Number.isFinite));
      for (const scan of ['lr', 'tb', 'ripple']) finiteScore(summon(img, { scan }));
    }
  }
});

test('transparent PNG colors match their visible white-paper composite', () => {
  const transparent = analyze(8, 8, () => [16, 192, 70, 0]);
  const white = analyze(8, 8, () => [255, 255, 255, 255]);
  assert.deepEqual(transparent, white);
  const translucent = analyze(8, 8, () => [255, 0, 0, 128]);
  const flattened = analyze(8, 8, () => [255, 127, 127, 255]);
  assert.deepEqual(translucent, flattened);
});

test('long screenshots and panoramas stay bounded; unloaded images fail clearly', () => {
  for (const dimensions of [[1200, 50000], [1, 50000], [50000, 1], [8000, 8000]]) {
    const img = analyze(...dimensions);
    assert.ok(img.w >= 1 && img.w <= 480);
    assert.ok(img.h >= 1 && img.h <= 960);
    assert.ok(img.H.length <= 460800);
    assert.ok(brightestPoint(img).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  assert.throws(() => analyze(0, 0), /尺寸/);
});

test('ordinary opaque images preserve the existing musical mapping in all three scans', () => {
  const img = analyze(48, 32, (x, y) => [(x * 17 + y * 3) % 256, (x * 5 + y * 23) % 256, (x * 13 + y * 7) % 256, 255]);
  // Recorded from the pre-fix engine, so safety fixes cannot silently rewrite old pieces.
  const expected = {
    lr: '86a3f9bda8f2ff681ca91d1ad0eef7fae9a699589853dd4dbea7820d4f8b0b4d',
    tb: 'a279dc3160d32d91169ccdbc7d3b1c2d1d233942174a0200e992389351c7ae34',
    ripple: '8bd1aaeca45440d8e0276d67292fb043b903e4c5cc1931af72733ad75d437a2a',
  };
  for (const scan of Object.keys(expected)) {
    const result = summon(img, { scan, seed: 42 });
    const hash = createHash('sha256').update(JSON.stringify(result.tracks)).digest('hex');
    assert.equal(hash, expected[scan]);
    assert.deepEqual(result, summon(img, { scan, seed: 42 }));
  }
});

test('malformed shared parameters cannot create invalid keys or unbounded generation', () => {
  const img = analyze(16, 16);
  const result = summon(img, { scan: 'ripple', focus: [-30, 999], bars: Infinity, tempo: NaN, key: 'oops', mode: 'oops', seed: NaN });
  assert.deepEqual(result.focus, [0, 1]);
  assert.equal(result.bars, 16);
  assert.equal(result.tempo, 80);
  assert.notEqual(result.tonic, undefined);
  finiteScore(result);
  finiteScore(summon(img, { scan: 'ripple', focus: [NaN, 0] }));
});

// Independent minimal SMF reader: validates chunk bounds, VLQs, channel data,
// tempo/time-signature metadata, and note lifetimes in our generated files.
async function readMidi(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const ascii = (at, length) => new TextDecoder().decode(bytes.slice(at, at + length));
  assert.equal(ascii(0, 4), 'MThd');
  assert.equal(view.getUint32(4), 6);
  assert.equal(view.getUint16(8), 1);
  assert.equal(view.getUint16(12), 480);
  const tracks = [];
  let offset = 14;
  while (offset < bytes.length) {
    assert.equal(ascii(offset, 4), 'MTrk');
    const end = offset + 8 + view.getUint32(offset + 4);
    assert.ok(end <= bytes.length);
    offset += 8;
    let tick = 0;
    const events = [];
    function readVLQ() {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        assert.ok(offset < end);
        const byte = bytes[offset++];
        value = value * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) return value;
      }
      assert.fail('MIDI VLQ exceeds four bytes');
    }
    while (offset < end) {
      tick += readVLQ();
      const status = bytes[offset++];
      if (status === 0xff) {
        const type = bytes[offset++];
        const length = readVLQ();
        assert.ok(offset + length <= end);
        events.push({ tick, type, data: Array.from(bytes.slice(offset, offset + length)) });
        offset += length;
      } else {
        assert.ok((status & 0xf0) === 0x90 || (status & 0xf0) === 0x80);
        const pitch = bytes[offset++], velocity = bytes[offset++];
        assert.ok(pitch <= 127 && velocity <= 127);
        events.push({ tick, status, pitch, velocity });
      }
    }
    assert.equal(events.at(-1).type, 0x2f);
    tracks.push(events);
  }
  assert.equal(offset, bytes.length);
  assert.equal(tracks.length, view.getUint16(10));
  return tracks;
}

test('MIDI exports explicit 4/4, tempo and ordered note off/on boundaries', async () => {
  const [events] = await readMidi(buildMidi([['旋律', [[0, 1, 60, 80], [1, 1, 60, 90]]]], 80));
  assert.deepEqual(events.find(event => event.type === 0x51).data, [0x0b, 0x71, 0xb0]);
  assert.deepEqual(events.find(event => event.type === 0x58).data, [4, 2, 24, 8]);
  const notes = events.filter(event => event.status);
  assert.deepEqual(notes.map(event => [event.tick, event.status]), [[0, 0x90], [480, 0x80], [480, 0x90], [960, 0x80]]);
});

test('MIDI sanitizes malformed notes without wraparound or hanging zero-length notes', async () => {
  const [events] = await readMidi(buildMidi([['test', [[-2, 0.000001, 200, 300], [1, 0, 60, 80], [NaN, 1, 60, 80], [3, 1, -10, 0]]]], NaN));
  const notes = events.filter(event => event.status);
  assert.deepEqual(notes.map(event => [event.tick, event.pitch, event.velocity]), [[0, 127, 127], [1, 127, 0], [1440, 0, 1], [1920, 0, 0]]);
  assert.throws(() => buildMidi([], 80), RangeError);
  assert.throws(() => buildMidi(Array.from({ length: 16 }, () => ['x', []]), 80), RangeError);
});

test('many painted notes can export without spread-argument overflow or percussion routing', async () => {
  const notes = Array.from({ length: 20000 }, (_, i) => [i / 4, 0.1, 60 + i % 12, 80]);
  const tracks = Array.from({ length: 11 }, (_, i) => [`voice ${i}`, i === 0 ? notes : [[0, 1, 60, 80]]]);
  const parsed = await readMidi(buildMidi(tracks, 90));
  assert.equal(parsed[0].filter(event => event.status).length, 40000);
  assert.ok(parsed.flat().filter(event => event.status).every(event => (event.status & 15) !== 9));
});
