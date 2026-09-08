/* 极简 Standard MIDI File (format 1) 写入器。事件格式：[startBeat, durBeats, note, velocity] */

const TICKS = 480;

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
  out.push(0x00, 0xff, 0x03, ...vlq(str(name).length), ...str(name));
  const usPerBeat = Math.round(60000000 / bpm);
  out.push(0x00, 0xff, 0x51, 0x03, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255);
  const msgs = [];
  for (const [start, dur, note, vel] of events) {
    msgs.push([Math.round(start * TICKS), 1, note, vel]);
    msgs.push([Math.round((start + dur) * TICKS), 0, note, 0]);
  }
  msgs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);   // 同刻先 off 再 on
  let now = 0;
  for (const [t, on, note, vel] of msgs) {
    out.push(...vlq(t - now)); now = t;
    out.push((on ? 0x90 : 0x80) | channel, note & 127, vel & 127);
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  return [...str('MTrk'), ...u32(out.length), ...out];
}

/** tracks: [[name, events], ...] → Blob */
export function buildMidi(tracks, bpm) {
  const body = [];
  tracks.forEach(([name, ev], i) => body.push(...trackBytes(name, ev, bpm, i)));
  const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(TICKS)];
  return new Blob([new Uint8Array([...header, ...body])], { type: 'audio/midi' });
}
