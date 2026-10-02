/* 极简 Standard MIDI File (format 1) 写入器。事件格式：[startBeat, durBeats, note, velocity] */

const TICKS = 480;
const MAX_TICK = 0x0fffffff;
// MIDI 第 10 通道约定为打击乐；所有导出的声部都是有音高的乐器。
const CHANNELS = Array.from({ length: 16 }, (_, i) => i).filter(i => i !== 9);

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return bytes;
}
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n) { return [(n >> 8) & 255, n & 255]; }
function str(s) { return Array.from(new TextEncoder().encode(s)); }

function trackBytes(name, events, bpm, channel) {
  const out = [];
  const title = str(String(name));
  out.push(0x00, 0xff, 0x03, ...vlq(title.length));
  for (const byte of title) out.push(byte);
  const usPerBeat = Math.round(60000000 / bpm);
  out.push(0x00, 0xff, 0x51, 0x03, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255);
  out.push(0x00, 0xff, 0x58, 0x04, 4, 2, 24, 8); // 4/4，和界面的小节一致
  const msgs = [];
  for (const event of events) {
    if (!Array.isArray(event) || event.length < 4) continue;
    const [start, dur, note, vel] = event;
    if (![start, dur, note, vel].every(Number.isFinite) || dur <= 0) continue;
    const on = Math.max(0, Math.round(start * TICKS));
    // 极短的手绘音符至少保留一个 tick，避免同刻 off/on 留下悬挂音。
    const off = Math.max(on + 1, Math.round((Math.max(0, start) + dur) * TICKS));
    if (off > MAX_TICK) continue;
    const pitch = Math.max(0, Math.min(127, Math.round(note)));
    const velocity = Math.max(1, Math.min(127, Math.round(vel)));
    msgs.push([on, 1, pitch, velocity]);
    msgs.push([off, 0, pitch, 0]);
  }
  msgs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);   // 同刻先 off 再 on
  let now = 0;
  for (const [t, on, note, vel] of msgs) {
    out.push(...vlq(t - now)); now = t;
    out.push((on ? 0x90 : 0x80) | channel, note & 127, vel & 127);
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  return new Uint8Array([...str('MTrk'), ...u32(out.length), ...out]);
}

/** tracks: [[name, events], ...] → Blob */
export function buildMidi(tracks, bpm) {
  if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > CHANNELS.length) {
    throw new RangeError('MIDI 导出需要 1–15 个声部');
  }
  const tempo = Number.isFinite(bpm) && bpm > 0 ? Math.max(20, Math.min(300, bpm)) : 80;
  const body = tracks.map(([name, ev], i) => trackBytes(name, ev, tempo, CHANNELS[i]));
  const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(TICKS)];
  // 按轨道交给 Blob，避免大量笔迹导出时 spread 超过 JS 参数长度限制。
  return new Blob([new Uint8Array(header), ...body], { type: 'audio/midi' });
}
