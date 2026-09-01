// headcount.ts — PURE derivation over the company's monthly headcount series.
//
// GROWTH IS NOT STORED, BY DESIGN. `master_company_headcount` keeps monthly totals and nothing else: the
// windows (1m/3m/6m/1y/2y) are recomputed from the series at read time because a stored rollup is a second
// copy that drifts (the 0114 "no-rollup" posture). So this file is where those numbers come from, and it is
// the only place they are computed for the panel.
//
// The series arrives OLDEST-FIRST from the server. That direction is load-bearing twice over: the sparkline
// draws left-to-right, and a reversed series would render a growing company as a shrinking one with nothing
// thrown. `apps/web` derives the same numbers from a newest-first series in its own hook; the extension
// cannot import web code, so the arithmetic is restated here — and pinned by tests on both sides.

export interface HeadcountPoint {
  month: string;
  employeeCount: number;
}

/** How a window's change should read. Tone is paired with a sign glyph and a label — never colour alone. */
export type GrowthStrength = "strong" | "mild" | "flat";

export interface HeadcountWindow {
  /** Window length in months: 1, 3, 6, 12, 24. */
  months: number;
  /** The baseline count, or null when the series does not reach back that far. */
  from: number | null;
  to: number;
  /** Percent change, or null when there is no baseline (not zero — "unknown" is not "unchanged"). */
  pct: number | null;
  strength: GrowthStrength;
}

export const WINDOW_MONTHS = [1, 3, 6, 12, 24] as const;

/** ≥25% reads as real movement, ≥5% as mild, below that as flat — in either direction. */
export function strengthOf(pct: number | null): GrowthStrength {
  if (pct === null) return "flat";
  const abs = Math.abs(pct);
  if (abs >= 25) return "strong";
  if (abs >= 5) return "mild";
  return "flat";
}

/**
 * The 1m/3m/6m/1y/2y windows over an oldest-first series.
 *
 * A window whose baseline is missing returns `pct: null` rather than 0. The distinction matters: a two-year
 * window needs 25 points and a first fetch usually carries ~25, so "we cannot say" is a routine answer and
 * must not be rendered as "no change".
 */
export function headcountWindows(seriesOldestFirst: readonly HeadcountPoint[]): HeadcountWindow[] {
  const last = seriesOldestFirst.at(-1);
  if (!last) return [];
  return WINDOW_MONTHS.map((months) => {
    const baseline = seriesOldestFirst.at(-1 - months);
    const from = baseline?.employeeCount ?? null;
    // Guard the zero baseline explicitly: a company that went 0 → 40 has no meaningful percentage, and the
    // division would produce Infinity, which formats as "Infinity%".
    const pct = from !== null && from > 0 ? ((last.employeeCount - from) / from) * 100 : null;
    return { months, from, to: last.employeeCount, pct, strength: strengthOf(pct) };
  });
}

export interface SparkBar {
  month: string;
  count: number;
  /** Height as a percentage of the tallest bar, floored so a tiny value is still visible. */
  heightPct: number;
}

/** The last `max` points as drawable bars. Heights are relative to the tallest bar in the WINDOW shown. */
export function sparkline(seriesOldestFirst: readonly HeadcountPoint[], max = 25): SparkBar[] {
  const slice = seriesOldestFirst.slice(-max);
  const peak = slice.reduce((m, p) => Math.max(m, p.employeeCount), 0);
  if (peak <= 0) return [];
  return slice.map((p) => ({
    month: p.month,
    count: p.employeeCount,
    heightPct: Math.max(3, Math.round((p.employeeCount / peak) * 100)),
  }));
}

/** How many months at the END of the series were consecutive month-over-month increases. */
export function consecutiveGrowthMonths(seriesOldestFirst: readonly HeadcountPoint[]): number {
  let run = 0;
  for (let i = seriesOldestFirst.length - 1; i > 0; i--) {
    const cur = seriesOldestFirst[i]?.employeeCount;
    const prev = seriesOldestFirst[i - 1]?.employeeCount;
    if (cur === undefined || prev === undefined || cur <= prev) break;
    run += 1;
  }
  return run;
}

export type HeadcountRead =
  | { key: "insufficient" }
  | { key: "flatAfterGrowth"; months: number }
  | { key: "growing"; pct: number }
  | { key: "declining"; pct: number }
  | { key: "steady" };

/**
 * The single sentence under the change rows — the one thing a rep reads if they read nothing else.
 *
 * "Flat after a long run of growth" is called out first because it is the read a headline number hides: a
 * company at +194% over a year that stopped moving last month is a different conversation from one still
 * climbing, and the twelve-month figure alone cannot tell you which.
 */
export function headcountRead(seriesOldestFirst: readonly HeadcountPoint[]): HeadcountRead {
  if (seriesOldestFirst.length < 2) return { key: "insufficient" };
  const windows = headcountWindows(seriesOldestFirst);
  const oneMonth = windows.find((w) => w.months === 1);
  const oneYear = windows.find((w) => w.months === 12);

  if (oneMonth?.pct === 0) {
    // The run is measured BEFORE the flat month, which is why we count from the second-to-last point.
    const run = consecutiveGrowthMonths(seriesOldestFirst.slice(0, -1));
    if (run >= 6) return { key: "flatAfterGrowth", months: run };
  }
  if (oneYear?.pct !== null && oneYear?.pct !== undefined) {
    if (oneYear.pct >= 5) return { key: "growing", pct: Math.round(oneYear.pct) };
    if (oneYear.pct <= -5) return { key: "declining", pct: Math.round(oneYear.pct) };
    return { key: "steady" };
  }
  return { key: "insufficient" };
}
