// contacts.test.ts — guards the masked-contact contract (05 §6/§7). maskedContactSchema is the single source
// of truth for the pre-reveal list shared by apps/api, apps/web, and packages/db; it must (1) accept a
// well-formed masked row including the T4b reporting dimensions (ownerUserId, createdAt) and (2) NEVER carry
// PII — no plaintext or ciphertext email/phone may ride the masked list. Pure unit test (no DB).

import { describe, expect, it } from "bun:test";
import { maskedContactSchema } from "./contacts.ts";

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
