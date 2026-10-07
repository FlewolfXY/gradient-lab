/** Pick one musical passage for both sides of an edit, independent of tempo. */
const TRACKS = ['melody', 'chords', 'bass'];
const PREVIEW_BEATS = 16;

// Match creative-edits' selection rule without changing the humanized onsets.
const selectionBeat = beat => Math.abs(beat - Math.round(beat)) < 0.04 ? Math.round(beat) : beat;
const notes = result => TRACKS.flatMap(track => result.tracks[track] || []);
const noteKey = event => JSON.stringify(event.slice(0, 4));

function changedNotes(before, after) {
  const changed = [];
  for (const track of TRACKS) {
    const unmatched = new Map();
    for (const event of before.tracks[track] || []) {
      const key = noteKey(event);
      if (!unmatched.has(key)) unmatched.set(key, []);
      unmatched.get(key).push(event);
    }
    for (const event of after.tracks[track] || []) {
      const matches = unmatched.get(noteKey(event));
      if (matches?.length) matches.pop();
      else changed.push(event);
    }
    for (const events of unmatched.values()) changed.push(...events);
  }
  return changed;
}

export function planEditPreview(before, after, plan, ink = []) {
  const end = before.bars * 4;
  const scopeStart = plan.scope === 'secondHalf' ? end / 2 : plan.scope === 'ending' ? Math.max(0, end - PREVIEW_BEATS) : 0;
  const scopeEnd = plan.scope === 'firstHalf' ? end / 2 : end;
  const withinScope = event => selectionBeat(event[0]) >= scopeStart && selectionBeat(event[0]) < scopeEnd;
  const changes = changedNotes(before, after).filter(withinScope);
  const audible = [...notes(before), ...notes(after), ...ink.map(mark => [mark.beat, mark.dur, mark.note, mark.vel])]
    .filter(event => event[3] > 0 && withinScope(event));
  const endingStart = Math.max(scopeStart, end - PREVIEW_BEATS);
  // A fade needs its full trajectory, including the unchanged first bar. If
  // fading was a no-op and another edit changed an earlier passage, hear that.
  const hearEnding = plan.operations.some(op => op.type === 'fadeEnding') &&
    changes.some(event => selectionBeat(event[0]) >= endingStart);
  const candidates = changes.length ? changes : audible;
  const firstChange = candidates.length ? Math.min(...candidates.map(event => selectionBeat(event[0]))) : scopeStart;
  const firstBeat = hearEnding ? endingStart : Math.max(scopeStart, Math.floor(firstChange / 4) * 4);
  const endBeat = Math.min(scopeEnd, firstBeat + PREVIEW_BEATS);
  // Include early humanized attacks at this bar's boundary on BOTH versions.
  const startBeat = Math.max(0, Math.min(firstBeat, ...audible
    .filter(event => selectionBeat(event[0]) >= firstBeat && event[0] < firstBeat)
    .map(event => event[0])));
  return {
    startBeat, endBeat,
    firstBar: Math.floor(firstBeat / 4) + 1,
    lastBar: Math.ceil(endBeat / 4),
    beforeSeconds: (endBeat - startBeat) * 60 / before.tempo,
    afterSeconds: (endBeat - startBeat) * 60 / after.tempo,
  };
}
