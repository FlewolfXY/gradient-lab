// Local-only sketchbook. Keep the payload bounded, validate imported data,
// and never silently discard an old piece when browser storage is full.
const KEY = 'gradient-lab:sketchbook:v1';
const MAX_WORKS = 8;
const MAX_CHARS = 2400000;
const kinds = ['spark', 'water', 'mist', 'root'];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function cleanInk(ink) {
  if (!Array.isArray(ink)) return [];
  return ink.slice(0, 240).filter(m => m && kinds.includes(m.kind) &&
    Number.isFinite(m.x) && Number.isFinite(m.y)).map((m, i) => ({
    id: `restored-${i}`, x: clamp(m.x, 0, 1), y: clamp(m.y, 0, 1),
    kind: m.kind, stroke: Number.isFinite(m.stroke) ? m.stroke : i + 1,
    dur: m.kind === 'mist' ? 2.2 : m.kind === 'root' ? 1.35 : 0.55,
    vel: m.kind === 'mist' ? 72 : m.kind === 'root' ? 92 : 98,
  }));
}

// Three bytes per point: x, y, and brush/new-stroke flag. 240 points fit in
// 960 URL-safe characters, keeping links practical even with a full drawing.
export function encodeInk(ink) {
  let previous;
  const bytes = [];
  cleanInk(ink).forEach(m => {
    bytes.push(Math.round(m.x * 255), Math.round(m.y * 255),
      kinds.indexOf(m.kind) | (previous !== m.stroke ? 4 : 0));
    previous = m.stroke;
  });
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeInk(value) {
  if (!value || value.length > 960 || !/^[A-Za-z0-9_-]+$/.test(value)) return [];
  try {
    const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    if (raw.length % 3) return [];
    const ink = [];
    let stroke = 0;
    for (let i = 0; i < raw.length; i += 3) {
      const meta = raw.charCodeAt(i + 2);
      if (meta > 7) return [];
      if (meta & 4 || i === 0) stroke++;
      ink.push({ x: raw.charCodeAt(i) / 255, y: raw.charCodeAt(i + 1) / 255,
        kind: kinds[meta & 3], stroke });
    }
    return cleanInk(ink);
  } catch { return []; }
}

function cleanWork(work) {
  if (!work || typeof work.id !== 'string' || typeof work.title !== 'string') return null;
  if (!['mist', 'prism', 'garden', 'live', 'upload'].includes(work.painting)) return null;
  const imageOK = typeof work.image === 'string' && work.image.length < 700000 &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(work.image);
  if (work.painting === 'upload' && !imageOK) return null;
  return {
    id: work.id.slice(0, 80), title: work.title.slice(0, 120),
    createdAt: Number.isFinite(work.createdAt) ? work.createdAt : Date.now(),
    painting: work.painting, image: imageOK ? work.image : null,
    scan: ['lr', 'tb', 'ripple'].includes(work.scan) ? work.scan : 'ripple',
    tempo: clamp(Number(work.tempo) || 80, 50, 120),
    preset: ['piano', 'ice', 'forest', 'machine'].includes(work.preset) ? work.preset : 'piano',
    mode: ['major', 'minor'].includes(work.mode) ? work.mode : '',
    seed: Number.isFinite(work.seed) ? Math.trunc(work.seed) : null,
    focus: Array.isArray(work.focus) && work.focus.length === 2 && work.focus.every(Number.isFinite)
      ? work.focus.map(n => clamp(n, 0, 1)) : null,
    ink: cleanInk(work.ink),
  };
}

export function loadWorks(storage = localStorage) {
  const raw = storage.getItem(KEY);
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('本机作品记录暂时无法读取，请先保留现有数据。'); }
  if (!Array.isArray(data)) throw new Error('本机作品记录格式不正确。');
  return data.map(cleanWork).filter(Boolean).slice(0, MAX_WORKS);
}

export function saveWork(work, storage = localStorage) {
  const valid = cleanWork(work);
  if (!valid) throw new Error('这份作品还没有准备好，请等图片读完再试。');
  const works = loadWorks(storage);
  if (works.length >= MAX_WORKS) throw new Error('小抽屉已经放满 8 份作品，请先删掉一份再收藏。');
  const next = [valid, ...works];
  const payload = JSON.stringify(next);
  if (payload.length > MAX_CHARS) throw new Error('本机空间快满了，请先导出并删除一份旧作品。');
  try { storage.setItem(KEY, payload); }
  catch { throw new Error('浏览器没有足够的本地空间，或未允许保存。你仍可以下载 MIDI 和明信片。'); }
  return next;
}

export function removeWork(id, storage = localStorage) {
  const next = loadWorks(storage).filter(work => work.id !== id);
  storage.setItem(KEY, JSON.stringify(next));
  return next;
}
