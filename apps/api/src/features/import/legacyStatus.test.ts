// legacyStatus.test.ts — the S-I9 legacy-mapping unit (import-and-data-model-redesign 08 §2.4, 15 seq 40):
// the FULL 12-state v2 vocabulary folds onto the shipped legacy enum per the §2.4 table — including the
// COPY-ONLY path (`staged → active`), so a copy job polled through the legacy endpoint during the
// compatibility window never surfaces an unknown status. Total: every v2 state is asserted, plus the
// unknown-input fold.

import { describe, expect, test } from "bun:test";
import { toLegacyStatusV2 } from "./legacyStatus.ts";

describe("toLegacyStatusV2 — the 08 §2.4 table, total over the 12-state vocabulary", () => {
  const TABLE: Record<string, string> = {
    // never visible to legacy pollers, folded defensively
    draft: "queued",
    uploading: "queued",
    // §2.4: queued/deferred → queued
    queued: "queued",
    deferred: "queued",
    // §2.4: validating/staged/running/paused → active — `staged` is the COPY-ONLY state (S-I9 half)
    validating: "active",
    staged: "active",
    running: "active",
    paused: "active",
    // §2.4: completed/partial → completed (summary carries the reject counts)
    completed: "completed",
    partial: "completed",
    // §2.4: failed → failed; cancelled → failed (failedReason "cancelled" is the caller's)
    failed: "failed",
    cancelled: "failed",
  };

  test("maps every v2 state per the table (copy states included)", () => {
    for (const [v2, legacy] of Object.entries(TABLE)) {
      expect(toLegacyStatusV2(v2)).toBe(legacy as ReturnType<typeof toLegacyStatusV2>);
    }
    expect(Object.keys(TABLE)).toHaveLength(12);
  });

  test("anything outside the vocabulary folds to 'unknown'", () => {
    expect(toLegacyStatusV2("exploded")).toBe("unknown");
    expect(toLegacyStatusV2("")).toBe("unknown");
  });
});
