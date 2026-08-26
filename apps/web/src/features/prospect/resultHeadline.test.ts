// resultHeadline.test.ts — the header speaks in saved / not-saved, never in "the database" unless a
// database-only filter made the database the whole answer, and renders a capped count as a floor.
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

  test("the database half is one capped page — more than it shows renders as a floor", () => {
    expect(
      resultHeadline({
        scope: "all",
        loading: false,
        saved: 12,
        savedIsFloor: false,
        available: 50,
        availableIsFloor: true,
      }),
    ).toBe("12 saved · 50+ more available");
    expect(
      resultHeadline({
        scope: "exclude",
        loading: false,
        saved: 0,
        savedIsFloor: false,
        available: 50,
        availableIsFloor: true,
      }),
    ).toBe("50+ people not yet saved");
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

  test("a database-only filter: the database is the whole answer, saved matches counted beside it", () => {
    expect(
      resultHeadline({
        scope: "all",
        loading: false,
        saved: 3,
        savedIsFloor: false,
        available: 47,
        availableIsFloor: true,
        workspaceSkipped: true,
      }),
    ).toBe("47+ found in the TruePoint database · 3 already saved");
    expect(
      resultHeadline({
        scope: "all",
        loading: false,
        saved: 0,
        savedIsFloor: false,
        available: 9,
        workspaceSkipped: true,
      }),
    ).toBe("9 found in the TruePoint database");
  });

  test("loading wins", () => {
    expect(
      resultHeadline({ scope: "all", loading: true, saved: 5, savedIsFloor: false, available: 5 }),
    ).toBe("Loading…");
  });

  test("never says 'database' unless a database-only filter forced it", () => {
    for (const scope of ["all", "mine", "exclude"] as const) {
      expect(
        resultHeadline({ scope, loading: false, saved: 3, savedIsFloor: false, available: 2 }),
      ).not.toContain("database");
    }
  });
});
