// dates.ts — PURE, precision-aware date display for employment history. No React, no I/O.
//
// Ported from the extension's panel (apps/extension/src/ui/panel/intel/format.ts) when the web app grew a
// grouped employment view: three surfaces were formatting the same stints, two of them with ad-hoc
// year-slicing helpers that lost information these rules exist to protect.
//
// WHY lib/ AND NOT packages/core: core is server-side domain logic ("shared by apps/api and apps/workers")
// and pulls @leadwolf/db + @leadwolf/config, which validates the server environment at import — it is not
// importable from a browser bundle, and apps/web deliberately does not depend on it. The extension keeps its
// own copy for the same reason. If a third consumer appears, the shared home is a new browser-safe package,
// not core.
//
// Two facts about the DATA are easy to get wrong and invisible in the UI once you have:
//
//   • PARTIAL DATES. The source asserts "2018" or "2026-05"; `start_precision`/`end_precision` record which.
//     Rendering a year-precision date as a month ("Jan 2018") invents information the record does not carry,
//     and computing a tenure from it invents a number. Both are refused here rather than approximated.
//
//   • THE MISSING START. `master_employment.started_on` defaults to the '-infinity' sentinel meaning "start
//     unknown"; the read repositories map it back to null, and a null start must stay unknown — never a
//     duration measured from year zero.

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Parse an ISO-ish date (`YYYY-MM-DD`) without timezone drift — these are calendar dates, not instants. */
function parts(iso: string | null | undefined): { y: number; m: number } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return Number.isFinite(year) && Number.isFinite(month) ? { y: year, m: month } : null;
}

/** Months since epoch — the comparable scalar behind every span calculation here. */
function absMonths(iso: string | null | undefined): number | null {
  const p = parts(iso);
  return p ? p.y * 12 + (p.m - 1) : null;
}

/**
 * One end of a date range, at the precision the SOURCE asserted.
 * `year` precision renders "2018" — never "Jan 2018", which would be a month we were never told.
 */
export function datePoint(iso: string | null | undefined, precision: string | null): string | null {
  const p = parts(iso);
  if (!p) return null;
  if (precision === "year") return String(p.y);
  return `${MONTHS[p.m - 1] ?? ""} ${p.y}`.trim();
}

/** The shape any date range needs; both employment contracts satisfy it after normalization. */
export interface DateSpan {
  startedOn: string | null;
  endedOn: string | null;
  startPrecision: string | null;
  endPrecision: string | null;
  isCurrent?: boolean;
}

/**
 * "Jun 2024 – Present" · "2019 – 2021" · null when the source gave neither end.
 * A missing start with a known end still renders the end; a stint with neither says nothing rather than "? – ?".
 */
export function dateRange(span: DateSpan): string | null {
  const start = datePoint(span.startedOn, span.startPrecision);
  const end = datePoint(span.endedOn, span.endPrecision);
  if (!start && !end) return null;
  if (!start) return end;
  if (span.isCurrent && !end) return `${start} – Present`;
  return end ? `${start} – ${end}` : start;
}

/**
 * Duration between two dates in "2y 2m" form. A null `endedOn` measures to `now` only when the role is
 * CURRENT; a closed role with no end date has no knowable duration.
 *
 * Returns null — never a guess — when the start is unknown, or when EITHER end was asserted only to the
 * year: "2018" could be eleven months of difference either way, and a tenure is exactly the kind of number a
 * rep repeats out loud.
 */
export function duration(span: DateSpan, now: Date = new Date()): string | null {
  // Either end asserted only to the year makes the result a guess with up to eleven months of slack in it.
  // Guarding the START alone was not enough: a month-precision start against a year-precision end
  // understates by up to eleven months while looking exact.
  if (span.startPrecision === "year" || (span.endedOn && span.endPrecision === "year")) return null;
  const from = absMonths(span.startedOn);
  if (from === null) return null;
  // Only a CURRENT role runs to now. `ended_on IS NULL` with `is_current = false` is a legal and common
  // state — a past role whose end the source never gave — and measuring that to today reported a decade-long
  // tenure at a job the person had already left.
  const to =
    absMonths(span.endedOn) ?? (span.isCurrent ? now.getFullYear() * 12 + now.getMonth() : null);
  if (to === null) return null;
  const months = to - from;
  if (months < 0) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0 && m === 0) return "<1m";
  return [y > 0 ? `${y}y` : null, m > 0 ? `${m}m` : null].filter(Boolean).join(" ");
}

/** Comparable sort key for a stint's start: months since epoch, or null when the start is unknown. */
export function startKey(iso: string | null | undefined): number | null {
  return absMonths(iso);
}

/** True when two spans overlap or one contains the other. Open ends count as "still running". */
export function spansOverlap(a: DateSpan, b: DateSpan): boolean {
  const aStart = absMonths(a.startedOn);
  const bStart = absMonths(b.startedOn);
  const aEnd = absMonths(a.endedOn) ?? Number.POSITIVE_INFINITY;
  const bEnd = absMonths(b.endedOn) ?? Number.POSITIVE_INFINITY;
  // An unknown start cannot be proven disjoint from anything, so treat it as open on the left.
  const aFrom = aStart ?? Number.NEGATIVE_INFINITY;
  const bFrom = bStart ?? Number.NEGATIVE_INFINITY;
  return aFrom <= bEnd && bFrom <= aEnd;
}
