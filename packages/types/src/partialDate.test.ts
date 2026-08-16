import { describe, expect, test } from "bun:test";
import { parsePartialDate } from "./partialDate.ts";

describe("parsePartialDate", () => {
  test("bare year normalizes to Jan 1 at 'year' precision", () => {
    expect(parsePartialDate("2018")).toEqual({ isoDate: "2018-01-01", precision: "year" });
  });

  test("year-month normalizes to the 1st at 'month' precision", () => {
    expect(parsePartialDate("2026-05")).toEqual({ isoDate: "2026-05-01", precision: "month" });
  });

  test("full date passes through at 'day' precision", () => {
    expect(parsePartialDate("2022-01-15")).toEqual({ isoDate: "2022-01-15", precision: "day" });
  });

  test("null, undefined, and empty map to null (caller stores the '-infinity' sentinel)", () => {
    expect(parsePartialDate(null)).toBeNull();
    expect(parsePartialDate(undefined)).toBeNull();
    expect(parsePartialDate("")).toBeNull();
    expect(parsePartialDate("   ")).toBeNull();
  });

  test("garbage and out-of-range inputs map to null, never throw", () => {
    expect(parsePartialDate("May 2026")).toBeNull();
    expect(parsePartialDate("2026-13")).toBeNull();
    expect(parsePartialDate("2026-00")).toBeNull();
    expect(parsePartialDate("0999")).toBeNull();
    expect(parsePartialDate("2101")).toBeNull();
    expect(parsePartialDate("2026-05-99")).toBeNull();
    expect(parsePartialDate("20260501")).toBeNull();
  });

  test("whitespace is tolerated around a valid value", () => {
    expect(parsePartialDate(" 2015 ")).toEqual({ isoDate: "2015-01-01", precision: "year" });
  });
});
