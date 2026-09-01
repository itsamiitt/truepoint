// headcount.test.ts — the growth arithmetic the server deliberately does NOT store (the 0114 no-rollup
// posture), so this file is the only guard on numbers the panel puts in front of a seller.
//
// The two properties worth more than the happy path:
//   • a window with no baseline is `null`, NOT zero — "we cannot say" and "no change" are different answers,
//     and a 2-year window needs 25 points that a first fetch often does not have;
//   • the series is OLDEST-FIRST. Reversed, a growing company renders as a shrinking one and nothing throws.

import { describe, expect, it } from "bun:test";
import {
  type HeadcountPoint,
  consecutiveGrowthMonths,
  headcountRead,
  headcountWindows,
  sparkline,
  strengthOf,
} from "./headcount.ts";

/** Oldest-first, like the server sends. `counts[0]` is the oldest month. */
function series(counts: number[]): HeadcountPoint[] {
  return counts.map((employeeCount, i) => ({
    month: `${2024 + Math.floor((7 + i) / 12)}-${String(((7 + i) % 12) + 1).padStart(2, "0")}-01`,
    employeeCount,
  }));
}

/** The shape the design was cut against: 24 → 209 over 25 months, the last month flat. */
const RILLET = series([
  24, 29, 32, 31, 31, 32, 34, 38, 40, 44, 52, 59, 71, 81, 96, 103, 113, 131, 140, 158, 180, 193,
  201, 209, 209,
]);

describe("headcountWindows", () => {
  it("1. computes every window against the correct baseline", () => {
    const w = headcountWindows(RILLET);
    const at = (m: number) => w.find((x) => x.months === m);

    expect(at(1)).toMatchObject({ from: 209, to: 209, pct: 0 });
    expect(at(3)?.from).toBe(193);
    expect(at(6)?.from).toBe(140);
    expect(at(12)?.from).toBe(71);
    expect(at(24)?.from).toBe(24);
    // The headline the design shows: 71 → 209 is +194%.
    expect(Math.round(at(12)?.pct ?? 0)).toBe(194);
    expect(Math.round(at(24)?.pct ?? 0)).toBe(771);
  });

  it("2. a window the series cannot reach is null, not zero", () => {
    // Thirteen points: the year window has a baseline, the two-year window does not.
    const short = series([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    const w = headcountWindows(short);
    expect(w.find((x) => x.months === 12)?.pct).not.toBeNull();
    expect(w.find((x) => x.months === 24)?.pct).toBeNull();
    expect(w.find((x) => x.months === 24)?.from).toBeNull();
  });

  it("3. a zero baseline yields null rather than Infinity", () => {
    // 0 → 40 has no meaningful percentage; the naive division renders as "Infinity%".
    const fromZero = series([0, 10, 20, 40]);
    expect(headcountWindows(fromZero).find((x) => x.months === 3)?.pct).toBeNull();
  });

  it("4. an empty series produces no windows at all", () => {
    expect(headcountWindows([])).toEqual([]);
  });

  it("5. strength bands are symmetric in both directions", () => {
    expect(strengthOf(30)).toBe("strong");
    expect(strengthOf(-30)).toBe("strong");
    expect(strengthOf(10)).toBe("mild");
    expect(strengthOf(-10)).toBe("mild");
    expect(strengthOf(2)).toBe("flat");
    expect(strengthOf(null)).toBe("flat");
  });
});

describe("sparkline", () => {
  it("6. draws the last N points, scaled to the tallest bar in the window", () => {
    const bars = sparkline(RILLET, 25);
    expect(bars).toHaveLength(25);
    expect(bars.at(-1)?.heightPct).toBe(100);
    // Oldest-first order is preserved: the chart reads left-to-right in time.
    expect(bars[0]?.count).toBe(24);
    // A small early value stays visible rather than collapsing to a zero-height bar.
    expect(bars[0]?.heightPct).toBeGreaterThanOrEqual(3);
  });

  it("7. an all-zero or empty series draws nothing instead of dividing by zero", () => {
    expect(sparkline(series([0, 0, 0]))).toEqual([]);
    expect(sparkline([])).toEqual([]);
  });
});

describe("headcountRead — the one sentence a rep actually reads", () => {
  it("8. calls out a flat month after a long run of growth", () => {
    // The read a headline number hides: +194% over a year that stopped last month is a different
    // conversation from one still climbing.
    //
    // 19, not 23: the run is counted back from the last GROWING month and stops at the flat 31 → 31 pair
    // early in the series. A run that silently jumped such a pause would overstate the streak, which is the
    // one number in this sentence a reader would take literally.
    expect(headcountRead(RILLET)).toEqual({ key: "flatAfterGrowth", months: 19 });
    expect(consecutiveGrowthMonths(RILLET.slice(0, -1))).toBe(19);
  });

  it("9. otherwise reports the twelve-month direction, or says it cannot", () => {
    const growing = series([100, 105, 110, 116, 122, 128, 134, 141, 148, 155, 163, 171, 180]);
    expect(headcountRead(growing)).toEqual({ key: "growing", pct: 80 });

    const shrinking = series([200, 195, 190, 185, 180, 175, 170, 165, 160, 155, 150, 145, 140]);
    expect(headcountRead(shrinking)).toEqual({ key: "declining", pct: -30 });

    const steady = series([100, 100, 101, 100, 99, 100, 101, 100, 100, 101, 100, 100, 101]);
    expect(headcountRead(steady)).toEqual({ key: "steady" });

    expect(headcountRead(series([5]))).toEqual({ key: "insufficient" });
    expect(headcountRead([])).toEqual({ key: "insufficient" });
  });
});
