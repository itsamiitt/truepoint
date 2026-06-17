// contacts.test.ts — guards the masked-contact contract (05 §6/§7). maskedContactSchema is the single source
// of truth for the pre-reveal list shared by apps/api, apps/web, and packages/db; it must (1) accept a
// well-formed masked row including the T4b reporting dimensions (ownerUserId, createdAt) and (2) NEVER carry
// PII — no plaintext or ciphertext email/phone may ride the masked list. Pure unit test (no DB).

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CONFLICT_POLICY,
  conflictPolicy,
  importPreviewSchema,
  importRequestSchema,
  importSummarySchema,
  maskedContactSchema,
  rejectedRowSchema,
} from "./contacts.ts";

const valid = {
  id: "00000000-0000-7000-8000-000000000001",
  firstName: "Jane",
  lastName: null,
  jobTitle: "VP Sales",
  emailDomain: "acme.com",
  emailStatus: "valid",
  hasEmail: true,
  hasPhone: false,
  seniorityLevel: "vp",
  department: null,
  locationCountry: "US",
  locationCity: null,
  outreachStatus: "new",
  isRevealed: false,
  ownerUserId: null,
  createdAt: "2026-06-14T10:00:00.000Z",
};

describe("maskedContactSchema", () => {
  it("accepts a well-formed masked contact incl. the T4b reporting dimensions", () => {
    const parsed = maskedContactSchema.parse(valid);
    expect(parsed.createdAt).toBe("2026-06-14T10:00:00.000Z");
    expect(parsed.ownerUserId).toBeNull();
  });

  it("accepts an owned contact carrying the revealing member (ownerUserId set)", () => {
    const parsed = maskedContactSchema.parse({
      ...valid,
      isRevealed: true,
      ownerUserId: "00000000-0000-7000-8000-0000000000aa",
    });
    expect(parsed.ownerUserId).toBe("00000000-0000-7000-8000-0000000000aa");
  });

  it("rejects a non-ISO createdAt", () => {
    const result = maskedContactSchema.safeParse({ ...valid, createdAt: "2026-06-14" });
    expect(result.success).toBe(false);
  });

  it("NEVER carries PII: no email/phone (plaintext or ciphertext) in the masked contract", () => {
    const keys = new Set(Object.keys(maskedContactSchema.shape));
    for (const pii of ["email", "phone", "emailEnc", "phoneEnc", "emailBlindIndex"]) {
      expect(keys.has(pii)).toBe(false);
    }
    // Zod strips unknown keys, so PII never survives a parse even if a caller over-supplies a raw row.
    const parsed = maskedContactSchema.parse({ ...valid, email: "jane@acme.com", phoneEnc: "x" });
    expect("email" in parsed).toBe(false);
    expect("phoneEnc" in parsed).toBe(false);
  });
});

describe("conflictPolicy (G-IMP-5)", () => {
  it("accepts the three policies and rejects anything else", () => {
    expect(conflictPolicy.options).toEqual(["overwrite", "skip", "keep_both"]);
    expect(conflictPolicy.safeParse("review").success).toBe(false);
  });

  it("the safe default is skip (no silent overwrite)", () => {
    expect(DEFAULT_CONFLICT_POLICY).toBe("skip");
  });

  it("importRequestSchema defaults conflictPolicy to the safe default when omitted", () => {
    const parsed = importRequestSchema.parse({ sourceName: "manual", mapping: { email: "Email" } });
    expect(parsed.conflictPolicy).toBe("skip");
  });

  it("importRequestSchema honors an explicit policy", () => {
    const parsed = importRequestSchema.parse({
      sourceName: "manual",
      mapping: { email: "Email" },
      conflictPolicy: "overwrite",
    });
    expect(parsed.conflictPolicy).toBe("overwrite");
  });
});

describe("rejectedRowSchema (G-IMP-1 artifact)", () => {
  it("accepts a field-level reject and a whole-row reject (field=null)", () => {
    expect(
      rejectedRowSchema.safeParse({
        row: 0,
        field: "email",
        reason: "Malformed email address.",
        raw: { Email: "bad" },
      }).success,
    ).toBe(true);
    expect(
      rejectedRowSchema.safeParse({ row: 3, field: null, reason: "No key.", raw: {} }).success,
    ).toBe(true);
  });
});

describe("importSummarySchema (three-way accounting)", () => {
  it("carries rejected / duplicates / rejectedRows alongside the legacy tallies", () => {
    const parsed = importSummarySchema.parse({
      total: 3,
      created: 1,
      matched: 0,
      skipped: 0,
      rejected: 1,
      duplicates: 1,
      errors: [{ row: 2, message: "bad" }],
      rejectedRows: [{ row: 2, field: "email", reason: "bad", raw: { Email: "x" } }],
    });
    expect(parsed.rejected).toBe(1);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.rejectedRows).toHaveLength(1);
  });
});

describe("importPreviewSchema", () => {
  it("accepts a preview with a sample of rejected rows", () => {
    const parsed = importPreviewSchema.parse({
      total: 5,
      valid: 3,
      rejected: 1,
      duplicate: 1,
      sampleRejectedRows: [{ row: 4, field: null, reason: "No key.", raw: { Name: "x" } }],
    });
    expect(parsed.valid).toBe(3);
    expect(parsed.sampleRejectedRows).toHaveLength(1);
  });
});
