// virtualWindow.ts — the arithmetic behind DataTable's windowed rows, kept pure so it can be tested.
//
// The rendering itself needs a DOM and this package has no DOM test setup, but the part that actually breaks
// silently is the spacer math: get it wrong and the scrollbar lies about the page length, or the first
// rendered row sits at the wrong offset and the table appears to jump while scrolling. Neither throws, and
// neither shows up in a typecheck.

/** One windowed row, as measured by the virtualizer. */
export interface WindowedRow {
  /** Offset of this row from the top of the SCROLL area (the document, for a window virtualizer). */
  start: number;
  /** Offset of this row's bottom edge, same origin as `start`. */
  end: number;
}

/** Height of the spacer rows that stand in for the rows not currently rendered. */
export interface WindowPadding {
  top: number;
  bottom: number;
}

/**
 * Spacer heights for a window of rows.
 *
 * `scrollMargin` is subtracted from the top because a window virtualizer measures from the top of the
 * DOCUMENT, while the spacer sits inside the table: without it the padding would also account for the page
 * chrome above the table and push every row down by that much.
 *
 * Both values are floored at zero. During a resize or a re-measure the totals can briefly disagree with the
 * measured rows, and a negative height is not something CSS can render — it would be dropped or clamped by
 * the browser rather than reported.
 */
export function windowPadding(
  rows: readonly WindowedRow[],
  totalSize: number,
  scrollMargin: number,
): WindowPadding {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return { top: 0, bottom: 0 };
  return {
    top: Math.max(0, first.start - scrollMargin),
    bottom: Math.max(0, totalSize - last.end),
  };
}
