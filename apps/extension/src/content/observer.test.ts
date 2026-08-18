import { describe, expect, test } from "bun:test";
import { NavigationKeyTracker } from "./observer.ts";

const u = (s: string) => new URL(s, "https://www.linkedin.com");

describe("NavigationKeyTracker", () => {
  test("first tick is a change; same key within throttle is null; after throttle is settle", () => {
    const t = new NavigationKeyTracker(1500);
    expect(t.tick(u("/sales/search/people?query=a"), 0)).toBe("change");
    expect(t.tick(u("/sales/search/people?query=a"), 500)).toBeNull();
    expect(t.tick(u("/sales/search/people?query=a"), 1500)).toBe("settle");
    expect(t.tick(u("/sales/search/people?query=a"), 2000)).toBeNull();
  });

  test("a query-string change (filter / page) IS a change even with the same pathname", () => {
    const t = new NavigationKeyTracker(1500);
    expect(t.tick(u("/sales/search/people?query=a"), 0)).toBe("change");
    expect(t.tick(u("/sales/search/people?query=b"), 100)).toBe("change");
    expect(t.tick(u("/sales/search/people?query=b&page=2"), 200)).toBe("change");
  });

  test("a change resets the settle throttle window", () => {
    const t = new NavigationKeyTracker(1500);
    expect(t.tick(u("/in/a"), 0)).toBe("change");
    expect(t.tick(u("/in/b"), 1000)).toBe("change");
    expect(t.tick(u("/in/b"), 2000)).toBeNull(); // only 1000ms since the change
    expect(t.tick(u("/in/b"), 2500)).toBe("settle");
  });
});
