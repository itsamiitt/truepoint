// originCooldowns.test.ts — the in-process cooldown store, on an injected clock.

import { describe, expect, test } from "bun:test";
import { makeOriginCooldownStore } from "./originCooldowns.ts";

describe("originCooldownStore", () => {
  test("set → cooling with the remaining horizon; expiry ends it; clear ends it early", () => {
    let now = 1_000_000;
    const store = makeOriginCooldownStore(() => now);

    expect(store.cooling("o1").cooling).toBe(false);

    store.set("o1", 30_000);
    expect(store.cooling("o1")).toEqual({ cooling: true, remainingMs: 30_000, throttled: false });

    now += 10_000;
    expect(store.cooling("o1")).toEqual({ cooling: true, remainingMs: 20_000, throttled: false });

    now += 20_000;
    expect(store.cooling("o1").cooling).toBe(false);

    store.set("o2", 30_000);
    store.clear("o2");
    expect(store.cooling("o2").cooling).toBe(false);
  });

  test("the throttled bit survives across reads — later walks still know WHY the origin cools", () => {
    const store = makeOriginCooldownStore(() => 0);
    store.set("busy", 10_000, true);
    store.set("broken", 10_000);
    expect(store.cooling("busy").throttled).toBe(true);
    expect(store.cooling("broken").throttled).toBe(false);
  });

  test("keys are independent; zero/negative horizons are ignored; reset drops everything", () => {
    let now = 0;
    const store = makeOriginCooldownStore(() => now);
    store.set("a", 5_000);
    store.set("b", 0);
    expect(store.cooling("a").cooling).toBe(true);
    expect(store.cooling("b").cooling).toBe(false);
    store.reset();
    expect(store.cooling("a").cooling).toBe(false);
    now += 1; // keep the linter honest about the mutable clock
  });
});
