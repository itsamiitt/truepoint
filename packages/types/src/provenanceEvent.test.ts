// provenanceEvent.test.ts — the app-edge half of the provenance_event guard rails. The database half lives in
// migration 0089's CHECK constraints and packages/db/test/provenanceEvent.itest.ts; this file covers the rules
// a CHECK cannot express, and covers them without needing Postgres.

import { describe, expect, test } from "bun:test";
import {
  provenanceAcceptanceState,
  provenanceAction,
  provenanceEntityType,
  provenanceEventDraftSchema,
  provenanceSourceType,
} from "./provenanceEvent.ts";

const MASTER_PERSON = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";

/** A valid Layer-0 assertion; spread and override per case. */
const layer0 = {
  entityType: "person" as const,
  entityId: MASTER_PERSON,
  field: "jobTitle",
  action: "assert" as const,
  sourceType: "provider" as const,
  lawfulBasis: "legitimate_interest" as const,
};

describe("provenanceEventDraft", () => {
  test("a minimal Layer-0 assertion parses and picks up its defaults", () => {
    const parsed = provenanceEventDraftSchema.parse(layer0);
    expect(parsed.acceptanceState).toBe("accepted");
    expect(parsed.payload).toEqual({});
  });

  // ── The layer/scope correspondence (C-02) ─────────────────────────────────────────────────────────────────
  test("an overlay event without scopeRef is rejected", () => {
    // A contact/account assertion belongs to exactly one workspace. Losing that means an overlay event cannot
    // be scoped for erasure or suppression later.
    const r = provenanceEventDraftSchema.safeParse({
      ...layer0,
      entityType: "contact",
      entityId: CONTACT,
    });
    expect(r.success).toBe(false);
  });

  test("a Layer-0 event carrying scopeRef is rejected", () => {
    // The direction that actually leaks: Layer 0 is the shared universe, so a workspace id attached to a
    // Layer-0 assertion is a tenant hint sitting in cross-tenant data.
    const r = provenanceEventDraftSchema.safeParse({ ...layer0, scopeRef: WORKSPACE });
    expect(r.success).toBe(false);
  });

  test("an overlay event with scopeRef is accepted", () => {
    const r = provenanceEventDraftSchema.safeParse({
      ...layer0,
      entityType: "contact",
      entityId: CONTACT,
      scopeRef: WORKSPACE,
    });
    expect(r.success).toBe(true);
  });

  // ── The payload rule (09-compliance rule 3) ───────────────────────────────────────────────────────────────
  test("email/phone events cannot carry a value in the payload", () => {
    // The failure this prevents is not a crash: it is provenance_event quietly becoming a second, unencrypted,
    // never-revealed copy of exactly the PII the reveal paywall and the DSAR fan-out exist to control.
    for (const entityType of ["email", "phone"] as const) {
      const r = provenanceEventDraftSchema.safeParse({
        ...layer0,
        entityType,
        payload: { v: "jane@example.com" },
      });
      expect(r.success).toBe(false);
    }
  });

  test("email/phone events are fine when they only reference the channel row", () => {
    const r = provenanceEventDraftSchema.safeParse({
      ...layer0,
      entityType: "email",
      action: "verify",
      method: "smtp_verify",
      payload: { status: "valid" }, // a grade, not the address
    });
    expect(r.success).toBe(true);
  });

  test("a non-channel field may carry its value", () => {
    const r = provenanceEventDraftSchema.safeParse({ ...layer0, payload: { v: "VP Sales" } });
    expect(r.success).toBe(true);
  });

  // ── Ranges and vocabularies ───────────────────────────────────────────────────────────────────────────────
  test("confidence outside [0,1] is rejected", () => {
    expect(provenanceEventDraftSchema.safeParse({ ...layer0, confidence: 1.5 }).success).toBe(
      false,
    );
    expect(provenanceEventDraftSchema.safeParse({ ...layer0, confidence: -0.1 }).success).toBe(
      false,
    );
    expect(provenanceEventDraftSchema.safeParse({ ...layer0, confidence: 0.75 }).success).toBe(
      true,
    );
  });

  test("a lawful basis outside the shared vocabulary is rejected", () => {
    // Reused from compliance.ts rather than redeclared, so this also pins that the two have not drifted apart.
    expect(provenanceEventDraftSchema.safeParse({ ...layer0, lawfulBasis: "vibes" }).success).toBe(
      false,
    );
  });

  test("unknown vocabulary members are rejected on every closed enum", () => {
    expect(provenanceEntityType.safeParse("organisation").success).toBe(false);
    expect(provenanceAction.safeParse("upsert").success).toBe(false);
    expect(provenanceSourceType.safeParse("scrape").success).toBe(false);
    expect(provenanceAcceptanceState.safeParse("maybe").success).toBe(false);
  });

  test("tombstone and merge use the whole-entity field marker", () => {
    // Erasure is an event, never a delete (09-compliance): a deleted row cannot evidence that the erasure was
    // honoured. It applies to the entity rather than one field, hence "*".
    const r = provenanceEventDraftSchema.safeParse({ ...layer0, field: "*", action: "tombstone" });
    expect(r.success).toBe(true);
  });
});
