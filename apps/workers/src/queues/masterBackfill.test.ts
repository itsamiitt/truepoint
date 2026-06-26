// masterBackfill.test.ts — unit-tests the self-heal gate (the retry branch the audit flagged as uncovered).
// Pure: throwIfErrored only inspects the result tally, so no DB/Redis/mock.module needed.

import { describe, expect, test } from "bun:test";
import { throwIfErrored } from "./masterBackfill.ts";

describe("throwIfErrored (master-backfill self-heal gate)", () => {
  test("THROWS when errored > 0 so BullMQ retries the job from a fresh scan", () => {
    expect(() => throwIfErrored({ scanned: 10, resolved: 7, errored: 2 })).toThrow(/errored/);
  });

  test("does NOT throw when errored is 0 — a fully-resolved pass succeeds", () => {
    expect(() => throwIfErrored({ scanned: 10, resolved: 10, errored: 0 })).not.toThrow();
  });

  test("does NOT throw on a keyless-only leftover (scanned but resolved 0, errored 0) — never loops", () => {
    expect(() => throwIfErrored({ scanned: 3, resolved: 0, errored: 0 })).not.toThrow();
    expect(() => throwIfErrored({ scanned: 0, resolved: 0, errored: 0 })).not.toThrow();
  });
});
