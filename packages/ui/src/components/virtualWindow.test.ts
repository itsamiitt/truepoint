import { describe, expect, test } from "bun:test";
import { windowPadding } from "./virtualWindow.ts";

describe("windowPadding", () => {
  test("no rows means no spacers — an empty or below-threshold table renders unchanged", () => {
    expect(windowPadding([], 0, 0)).toEqual({ top: 0, bottom: 0 });
    // A non-zero total with nothing windowed must still not emit padding: that combination happens on the
    // render before the first measure, and a stray spacer there is a visible jump.
    expect(windowPadding([], 4400, 120)).toEqual({ top: 0, bottom: 0 });
  });

  test("the top spacer excludes the scroll margin", () => {
    // 100 rows x 44px, page chrome 120px tall, window starts at row 10 (start = 120 + 440).
    const rows = [{ start: 560, end: 604 }];
    // Without subtracting the margin this would be 560 and every row would sit 120px too low.
    expect(windowPadding(rows, 4520, 120).top).toBe(440);
  });

  test("the bottom spacer covers everything after the last windowed row", () => {
    const rows = [
      { start: 440, end: 484 },
      { start: 484, end: 528 },
    ];
    expect(windowPadding(rows, 4400, 0).bottom).toBe(4400 - 528);
  });

  test("the two spacers plus the windowed rows account for the whole scroll height", () => {
    const scrollMargin = 96;
    const rows = [
      { start: 96 + 220, end: 96 + 264 },
      { start: 96 + 264, end: 96 + 308 },
      { start: 96 + 308, end: 96 + 352 },
    ];
    const totalSize = 96 + 4400;
    const { top, bottom } = windowPadding(rows, totalSize, scrollMargin);
    const windowed = (rows[2]?.end ?? 0) - (rows[0]?.start ?? 0);
    // This identity is the whole point: if it does not hold, the scrollbar misreports the table's length.
    expect(top + windowed + bottom).toBe(totalSize - scrollMargin);
  });

  test("a mid-resize disagreement floors at zero rather than emitting a negative height", () => {
    // Measured rows can briefly exceed the cached total while a re-measure is in flight.
    const rows = [{ start: 10, end: 5000 }];
    expect(windowPadding(rows, 4400, 400)).toEqual({ top: 0, bottom: 0 });
  });
});
