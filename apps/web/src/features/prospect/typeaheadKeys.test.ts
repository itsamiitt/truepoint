// typeaheadKeys.test.ts — ↑ ↓ wrap, Home/End, Enter selects only a highlighted option, Escape closes only an
// open list, everything else is left to the input (the a11y metric: the picker is fully keyboard-operable).
import { describe, expect, test } from "bun:test";
import { optionId, typeaheadKey } from "./typeaheadKeys";

const closed = { open: false, activeIndex: -1 };

describe("typeaheadKey", () => {
  test("ArrowDown opens and walks down, wrapping at the end", () => {
    let s = typeaheadKey(closed, "ArrowDown", 3);
    expect(s).toMatchObject({ open: true, activeIndex: 0, select: false, handled: true });
    s = typeaheadKey(s, "ArrowDown", 3);
    s = typeaheadKey(s, "ArrowDown", 3);
    expect(s.activeIndex).toBe(2);
    expect(typeaheadKey(s, "ArrowDown", 3).activeIndex).toBe(0);
  });

  test("ArrowUp from nothing highlighted lands on the last option, then walks up", () => {
    let s = typeaheadKey(closed, "ArrowUp", 3);
    expect(s.activeIndex).toBe(2);
    s = typeaheadKey(s, "ArrowUp", 3);
    expect(s.activeIndex).toBe(1);
  });

  test("Home and End jump", () => {
    const s = { open: true, activeIndex: 1 };
    expect(typeaheadKey(s, "Home", 4).activeIndex).toBe(0);
    expect(typeaheadKey(s, "End", 4).activeIndex).toBe(3);
  });

  test("an empty list never highlights anything", () => {
    expect(typeaheadKey(closed, "ArrowDown", 0).activeIndex).toBe(-1);
    expect(typeaheadKey(closed, "ArrowUp", 0).activeIndex).toBe(-1);
    expect(typeaheadKey(closed, "Home", 0).activeIndex).toBe(-1);
  });

  test("Enter selects only a highlighted option — otherwise the input keeps the key", () => {
    expect(typeaheadKey({ open: true, activeIndex: 1 }, "Enter", 3)).toEqual({
      open: false,
      activeIndex: -1,
      select: true,
      handled: true,
    });
    expect(typeaheadKey({ open: true, activeIndex: -1 }, "Enter", 3).handled).toBe(false);
    expect(typeaheadKey(closed, "Enter", 3).select).toBe(false);
  });

  test("Escape closes an open list and is otherwise not ours (the drawer above gets it)", () => {
    expect(typeaheadKey({ open: true, activeIndex: 2 }, "Escape", 3)).toEqual({
      open: false,
      activeIndex: -1,
      select: false,
      handled: true,
    });
    expect(typeaheadKey(closed, "Escape", 3).handled).toBe(false);
  });

  test("typing keys are never swallowed", () => {
    const s = { open: true, activeIndex: 1 };
    expect(typeaheadKey(s, "a", 3)).toEqual({ ...s, select: false, handled: false });
  });

  test("option ids are stable per list + index", () => {
    expect(optionId("ta-title", 2)).toBe("ta-title-opt-2");
  });
});
