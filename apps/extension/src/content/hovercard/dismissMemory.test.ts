// dismissMemory.test.ts — the ✕ is a statement about a subject, not a moment.
import { describe, expect, it } from "bun:test";
import { DismissMemory } from "./dismissMemory.ts";

describe("DismissMemory", () => {
  it("a dismissed subject stays dismissed; other subjects are unaffected", () => {
    const m = new DismissMemory();
    m.dismiss("jane-doe");
    expect(m.isDismissed("jane-doe")).toBe(true);
    expect(m.isDismissed("john-roe")).toBe(false);
  });

  it("revive clears exactly the one subject", () => {
    const m = new DismissMemory();
    m.dismiss("jane-doe");
    m.dismiss("company:acme");
    m.revive("jane-doe");
    expect(m.isDismissed("jane-doe")).toBe(false);
    expect(m.isDismissed("company:acme")).toBe(true);
  });
});
