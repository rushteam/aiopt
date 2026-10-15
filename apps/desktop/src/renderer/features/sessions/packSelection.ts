// Message selection for a context pack. Indexes are into the full transcript `entries`
// (tool entries keep their index even while hidden). Pure; no DOM.

/** Toggle `index`; with `range`, set every visible index between the anchor and it instead. */
export function toggleSelection(
  selected: ReadonlySet<number>,
  index: number,
  opts: { range: boolean; anchor: number | null; visible: readonly number[] },
): Set<number> {
  const next = new Set(selected);
  if (opts.range && opts.anchor !== null && opts.anchor !== index) {
    const lo = Math.min(opts.anchor, index);
    const hi = Math.max(opts.anchor, index);
    // The range follows the anchor's state: extending from a picked message picks the range.
    const on = selected.has(opts.anchor);
    for (const i of opts.visible) {
      if (i < lo || i > hi) continue;
      if (on) next.add(i);
      else next.delete(i);
    }
    return next;
  }
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

/** The picked indexes still visible (hidden tool entries are left out of the pack). */
export function packIndexes(selected: ReadonlySet<number>, visible: readonly number[]): number[] {
  return visible.filter((i) => selected.has(i));
}
