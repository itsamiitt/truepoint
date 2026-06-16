// format.test.ts — focused unit test for the cockpit's shared date formatters (home/components/format.ts).
// These are the only pure, exported helpers the Home wave introduced, so we pin their contract: a valid ISO
// string formats to a stable absolute date; unparseable input falls back to an em dash (never throws / never
// "Invalid Date"); and formatRelative collapses recent offsets to a relative phrase but past a week falls
// back to the absolute date. Time-sensitive cases are anchored off Date.now() so they stay deterministic.

import { describe, expect, it } from "bun:test";
import { formatDate, formatRelative } from "./format.ts";

describe("formatDate", () => {
  it("formats a valid ISO timestamp to a non-empty absolute date", () => {
    const out = formatDate("2026-06-14T10:00:00.000Z");
    expect(out).not.toBe("—");
    expect(out).toMatch(/2026/);
  });

  it("returns an em dash for unparseable input instead of 'Invalid Date'", () => {
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatDate("")).toBe("—");
  });
});

describe("formatRelative", () => {
  it("returns an em dash for unparseable input", () => {
    expect(formatRelative("not-a-date")).toBe("—");
  });

  it("renders a recent past timestamp as a relative phrase, not an absolute date", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const out = formatRelative(twoHoursAgo);
    expect(out).not.toBe("—");
    // Within the week window it uses Intl.RelativeTimeFormat, so it won't contain a 4-digit year.
    expect(out).not.toMatch(/\d{4}/);
  });

  it("falls back to the absolute date once the offset exceeds a week", () => {
    const longAgoIso = "2000-01-15T00:00:00.000Z";
    expect(formatRelative(longAgoIso)).toBe(formatDate(longAgoIso));
    expect(formatRelative(longAgoIso)).toMatch(/2000/);
  });
});
