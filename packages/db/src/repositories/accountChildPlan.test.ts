// accountChildPlan.test.ts — unit tests for S-A2's pure domain-upsert decider (planAccountDomainWrite,
// 06 §1). No DB: the workspace-collision probe + cache projection are the repo's half (accountChildRepository).
// Proven: first live domain ⇒ primary; an existing primary is NEVER flipped; a dedup hit fills a primary
// vacuum (promote) but is otherwise a no-op; a new domain under a live primary appends as a secondary.

import { describe, expect, test } from "bun:test";
import { type AccountDomainUpsertState, planAccountDomainWrite } from "./accountChildPlan.ts";

const state = (o: Partial<AccountDomainUpsertState> = {}): AccountDomainUpsertState => ({
  matchExists: false,
  matchIsPrimary: false,
  hasLivePrimary: false,
  ...o,
});

describe("planAccountDomainWrite — new domain (no dedup hit)", () => {
  test("first live domain ⇒ insert_primary (accounts.domain cache-fill)", () => {
    expect(planAccountDomainWrite(state())).toBe("insert_primary");
  });

  test("account already has a live primary ⇒ insert_secondary (primary never flipped)", () => {
    expect(planAccountDomainWrite(state({ hasLivePrimary: true }))).toBe("insert_secondary");
  });
});

describe("planAccountDomainWrite — dedup hit (domain already live on this account)", () => {
  test("matched into a PRIMARY VACUUM (no live primary) ⇒ promote_existing (+ cache projection, repo half)", () => {
    expect(planAccountDomainWrite(state({ matchExists: true, hasLivePrimary: false }))).toBe(
      "promote_existing",
    );
  });

  test("matched non-primary under a live primary ⇒ keep_existing (no flip, no churn)", () => {
    expect(
      planAccountDomainWrite(state({ matchExists: true, matchIsPrimary: false, hasLivePrimary: true })),
    ).toBe("keep_existing");
  });

  test("matched the primary itself ⇒ keep_existing (idempotent re-import is a no-op)", () => {
    expect(
      planAccountDomainWrite(state({ matchExists: true, matchIsPrimary: true, hasLivePrimary: true })),
    ).toBe("keep_existing");
  });
});
