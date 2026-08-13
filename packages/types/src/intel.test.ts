// intel.test.ts — the enrichment DTO contracts (waterfall v2 / 0111): the providerOrder override is
// validated against the KNOWN provider set (never free text — it reaches the waterfall's ordering), the
// 202 ack shape round-trips, and KNOWN_ENRICH_PROVIDERS stays in lockstep with the enum that validates
// order entries (the single-source rule the admin allowlist + settings panel rely on).

import { describe, expect, test } from "bun:test";
import {
  KNOWN_ENRICH_PROVIDERS,
  enrichProviderId,
  enrichmentJobDataSchema,
  enrichmentRequestSchema,
  enrichmentTriggerAckSchema,
} from "./intel.ts";

describe("enrichmentRequestSchema (waterfall v2)", () => {
  test("accepts fields alone (the shipped v1 body, unchanged)", () => {
    expect(enrichmentRequestSchema.parse({ fields: ["email"] })).toEqual({ fields: ["email"] });
  });

  test("accepts a providerOrder drawn from the known set", () => {
    const parsed = enrichmentRequestSchema.parse({
      fields: ["email", "phone"],
      providerOrder: ["pdl", "apollo"],
    });
    expect(parsed.providerOrder).toEqual(["pdl", "apollo"]);
  });

  test("rejects an unknown provider name in providerOrder (free text never reaches the ordering)", () => {
    const parsed = enrichmentRequestSchema.safeParse({
      fields: ["email"],
      providerOrder: ["evil-corp"],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects an empty fields list", () => {
    expect(enrichmentRequestSchema.safeParse({ fields: [] }).success).toBe(false);
  });
});

describe("enrichmentTriggerAckSchema", () => {
  test("round-trips the 202 body; queued must be literal true and jobId non-empty", () => {
    expect(enrichmentTriggerAckSchema.parse({ queued: true, jobId: "42" })).toEqual({
      queued: true,
      jobId: "42",
    });
    expect(enrichmentTriggerAckSchema.safeParse({ queued: false, jobId: "42" }).success).toBe(
      false,
    );
    expect(enrichmentTriggerAckSchema.safeParse({ queued: true, jobId: "" }).success).toBe(false);
  });
});

describe("enrichmentJobDataSchema (the api↔worker queue contract)", () => {
  test("accepts the full payload and stays PII-free by construction (ids + field names only)", () => {
    const parsed = enrichmentJobDataSchema.parse({
      tenantId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      contactId: "33333333-3333-3333-3333-333333333333",
      fields: ["email"],
      requestedByUserId: null,
      providerOrder: ["coresignal"],
    });
    expect(parsed.fields).toEqual(["email"]);
  });

  test("rejects a non-uuid contact id", () => {
    const parsed = enrichmentJobDataSchema.safeParse({
      tenantId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      contactId: "not-a-uuid",
      fields: ["email"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("KNOWN_ENRICH_PROVIDERS ↔ enrichProviderId lockstep", () => {
  test("every KNOWN provider id is an enum member, and vice versa", () => {
    const ids = KNOWN_ENRICH_PROVIDERS.map((p) => p.provider).sort();
    const enumMembers = [...enrichProviderId.options].sort();
    expect(ids).toEqual(enumMembers);
  });
});
