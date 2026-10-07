import { cleanInk } from './studio-storage.js?v=20261006-1';

/** Bounded, tab-local stroke history; clearing is one reversible action. */
export function createInkHistory(limit = 32) {
  const snapshots = [];
  return {
    remember(ink) {
      snapshots.push(cleanInk(ink));
      if (snapshots.length > limit) snapshots.shift();
    },
    canUndo(ink) { return snapshots.length > 0 || ink.length > 0; },
    undo(ink) {
      if (snapshots.length) return cleanInk(snapshots.pop());
      // Imported and reopened works remain erasable one stroke at a time.
      const last = ink.at(-1)?.stroke;
      return cleanInk(ink.filter(mark => mark.stroke !== last));
    },
    reset() { snapshots.length = 0; },
  };
}
