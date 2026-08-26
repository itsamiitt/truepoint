// resultHeadline.test.ts — the header speaks in saved / not-saved, never in "the database", and renders a
// capped count as a floor.
import { describe, expect, test } from "bun:test";
import { resultHeadline } from "./resultHeadline";

describe("resultHeadline", () => {
  test("All: saved, then how many more are available", () => {
    expect(
      resultHeadline({
        scope: "all",
        loading: false,
        saved: 1240,
        savedIsFloor: false,
        available: 176,
      }),
    ).toBe("1,240 saved · 176 more available");
    expect(
      resultHeadline({
        scope: "all",
        loading: false,
        saved: 12,
        savedIsFloor: false,
        available: 0,
      }),
    ).toBe("12 saved");
  });

  test("Saved: only the saved count; a capped total is a floor", () => {
    expect(
      resultHeadline({
        scope: "mine",
        loading: false,
        saved: 10000,
        savedIsFloor: true,
        available: 0,
      }),
    ).toBe("10,000+ saved");
  });

  test("Not saved: only the people not yet saved, with the right plural", () => {
    expect(
      resultHeadline({
        scope: "exclude",
        loading: false,
        saved: 0,
        savedIsFloor: false,
        available: 1,
      }),
    ).toBe("1 person not yet saved");
    expect(
      resultHeadline({
        scope: "exclude",
        loading: false,
        saved: 0,
        savedIsFloor: false,
        available: 40,
      }),
    ).toBe("40 people not yet saved");
  });

  test("loading wins", () => {
    expect(
      resultHeadline({ scope: "all", loading: true, saved: 5, savedIsFloor: false, available: 5 }),
    ).toBe("Loading…");
  });

  test("never says 'database'", () => {
    for (const scope of ["all", "mine", "exclude"] as const) {
      expect(
        resultHeadline({ scope, loading: false, saved: 3, savedIsFloor: false, available: 2 }),
      ).not.toContain("database");
    }
  });
});
