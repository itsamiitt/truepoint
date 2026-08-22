// format.test.ts — the display rules that encode facts about the DATA, not preferences about looks.
// Fabricated fixtures only (RFC 2606 domains, invented names): the real vendor samples are third-party PII.

import { describe, expect, it } from "bun:test";
import {
  ageDays,
  contactSummary,
  dateRange,
  datePoint,
  initials,
  maskEmail,
  monogram,
  monthLabel,
  signedPct,
  tenure,
} from "./format.ts";

const NOW = new Date("2026-08-22T00:00:00.000Z");

describe("initials / monogram", () => {
  it("takes first + last, and degrades without throwing", () => {
    expect(initials("Jane Visible")).toBe("JV");
    expect(initials("Jane Q. Visible")).toBe("JV");
    expect(initials("Cher")).toBe("C");
    expect(initials(null)).toBe("?");
    expect(initials("   ")).toBe("?");
    expect(monogram("Acme Inc")).toBe("A");
    expect(monogram(null)).toBe("?");
  });
});

describe("datePoint / dateRange — precision is not decoration", () => {
  it("renders a year-precision date as a YEAR, never an invented month", () => {
    // The source said "2018". "Jan 2018" would be a month we were never told.
    expect(datePoint("2018-01-01", "year")).toBe("2018");
    expect(datePoint("2018-01-01", "month")).toBe("Jan 2018");
    expect(datePoint(null, "month")).toBeNull();
  });

  it("renders the four range shapes", () => {
    expect(
      dateRange({
        startedOn: "2024-06-01",
        endedOn: null,
        startPrecision: "month",
        endPrecision: null,
        isCurrent: true,
      }),
    ).toBe("Jun 2024 – Present");
    expect(
      dateRange({
        startedOn: "2019-01-01",
        endedOn: "2021-01-01",
        startPrecision: "year",
        endPrecision: "year",
      }),
    ).toBe("2019 – 2021");
    // A start we do not know is not a start at year zero — the '-infinity' sentinel arrives as null.
    expect(
      dateRange({
        startedOn: null,
        endedOn: "2010-01-01",
        startPrecision: null,
        endPrecision: "year",
      }),
    ).toBe("2010");
    expect(
      dateRange({ startedOn: null, endedOn: null, startPrecision: null, endPrecision: null }),
    ).toBeNull();
  });
});

describe("tenure — refuses to guess", () => {
  it("computes whole years and months from a month-precision start", () => {
    expect(tenure("2024-06-01", "month", NOW)).toBe("2y 2m");
    expect(tenure("2026-08-01", "month", NOW)).toBe("<1m");
    expect(tenure("2025-08-01", "month", NOW)).toBe("1y");
    expect(tenure("2026-05-01", "month", NOW)).toBe("3m");
  });

  it("returns null rather than a number it cannot support", () => {
    // "2018" spans twelve months of possible answers, and a tenure is a number reps repeat out loud.
    expect(tenure("2018-01-01", "year", NOW)).toBeNull();
    expect(tenure(null, "month", NOW)).toBeNull();
    expect(tenure("not-a-date", "month", NOW)).toBeNull();
    // A start in the future is data corruption, not negative tenure.
    expect(tenure("2027-01-01", "month", NOW)).toBeNull();
  });
});

describe("ageDays / monthLabel / maskEmail / contactSummary / signedPct", () => {
  it("floors day age and never goes negative", () => {
    expect(ageDays("2026-08-20T00:00:00.000Z", NOW)).toBe(2);
    expect(ageDays("2026-08-22T00:00:00.000Z", NOW)).toBe(0);
    expect(ageDays("2027-01-01T00:00:00.000Z", NOW)).toBe(0);
    expect(ageDays(null, NOW)).toBeNull();
    expect(ageDays("nonsense", NOW)).toBeNull();
  });

  it("labels a series month and masks an email to its domain", () => {
    expect(monthLabel("2026-08-01")).toBe("Aug 2026");
    expect(maskEmail("acme.example")).toBe("••••••••@acme.example");
    // No domain means we hold no email at all — the caller renders the empty case, not a stub mask.
    expect(maskEmail(null)).toBeNull();
  });

  it("states what we hold before anything is spent", () => {
    expect(contactSummary(true, false)).toBe("1 email · no phone");
    expect(contactSummary(false, true)).toBe("no email · 1 phone");
  });

  it("signs percentages explicitly (never colour alone)", () => {
    expect(signedPct(194.4)).toBe("+194%");
    expect(signedPct(-12.2)).toBe("-12%");
    expect(signedPct(0)).toBe("0%");
    expect(signedPct(null)).toBeNull();
    expect(signedPct(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
