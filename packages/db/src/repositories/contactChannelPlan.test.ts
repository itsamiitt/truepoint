// contactChannelPlan.test.ts — unit tests for the pure S-CH2 upsert-decision rules (05 §2.1/§3.3/§6):
// first-value-becomes-primary, existing-primary-never-flipped, per-contact dedup, cap skip, and the
// primary-vacuum promote. Pure module — runs under plain `bun test` (no DB).

import { describe, expect, test } from "bun:test";
import { type ChannelUpsertState, planChannelUpsert } from "./contactChannelPlan.ts";

const base: ChannelUpsertState = {
  liveCount: 0,
  matchExists: false,
  matchIsPrimary: false,
  hasLivePrimary: false,
  cap: 25,
};

describe("planChannelUpsert — 05 §2.1/§3.3/§6 primary designation + dedup + cap", () => {
  test("first live value for a channel becomes the primary (cache fill)", () => {
    expect(planChannelUpsert(base)).toBe("insert_primary");
  });

  test("a live primary is NEVER flipped by an upsert — new value appends as secondary", () => {
    expect(planChannelUpsert({ ...base, liveCount: 1, hasLivePrimary: true })).toBe(
      "insert_secondary",
    );
  });

  test("per-contact dedup: the same value (blind index) is never re-inserted", () => {
    expect(
      planChannelUpsert({
        ...base,
        liveCount: 1,
        matchExists: true,
        matchIsPrimary: true,
        hasLivePrimary: true,
      }),
    ).toBe("keep_existing");
    // Matched secondary while a different row is primary: promotion is an explicit verb, not an upsert
    // side effect — nothing changes.
    expect(
      planChannelUpsert({
        ...base,
        liveCount: 2,
        matchExists: true,
        matchIsPrimary: false,
        hasLivePrimary: true,
      }),
    ).toBe("keep_existing");
  });

  test("primary vacuum (live rows, none primary — drift-grade state): the matched value is promoted", () => {
    expect(
      planChannelUpsert({ ...base, liveCount: 1, matchExists: true, hasLivePrimary: false }),
    ).toBe("promote_existing");
  });

  test("cap: a NEW value at/over the per-contact cap is skipped (counted, never an error)", () => {
    expect(planChannelUpsert({ ...base, liveCount: 25, hasLivePrimary: true })).toBe("capped");
    expect(planChannelUpsert({ ...base, liveCount: 26, hasLivePrimary: true })).toBe("capped");
    // ... but a DEDUP HIT at the cap is still a keep (the value already lives there — no new row).
    expect(
      planChannelUpsert({
        ...base,
        liveCount: 25,
        matchExists: true,
        matchIsPrimary: true,
        hasLivePrimary: true,
      }),
    ).toBe("keep_existing");
  });

  test("cap counts LIVE rows only by contract (caller passes live count) — a sub-cap contact appends", () => {
    expect(planChannelUpsert({ ...base, liveCount: 24, hasLivePrimary: true })).toBe(
      "insert_secondary",
    );
  });
});
