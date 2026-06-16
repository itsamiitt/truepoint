// billing.test.ts — guards the usage-reveal contract (07 §9, 09 §3). usageRevealSchema is the single source
// of truth for GET /credits/usage rows, shared by apps/api and apps/web (Settings ▸ Billing, Reports). It must
// accept a well-formed metered reveal (incl. the T4b member dimension revealedByUserId) and reject the easy
// mistakes: a revealType outside the closed enum and a negative credit count. Pure unit test (no DB).

import { describe, expect, it } from "bun:test";
import { usageRevealSchema } from "./billing.ts";

const valid = {
  id: "00000000-0000-7000-8000-000000000001",
  contactId: "00000000-0000-7000-8000-000000000002",
  revealType: "email",
  creditsConsumed: 1,
  revealedAt: "2026-06-14T10:00:00.000Z",
  revealedByUserId: "00000000-0000-7000-8000-0000000000aa",
};

describe("usageRevealSchema", () => {
  it("accepts a well-formed usage reveal incl. revealedByUserId (member dimension)", () => {
    const parsed = usageRevealSchema.parse(valid);
    expect(parsed.revealedByUserId).toBe("00000000-0000-7000-8000-0000000000aa");
    expect(parsed.revealType).toBe("email");
  });

  it("rejects a revealType outside the closed enum", () => {
    expect(usageRevealSchema.safeParse({ ...valid, revealType: "sms" }).success).toBe(false);
  });

  it("rejects a negative credit count", () => {
    expect(usageRevealSchema.safeParse({ ...valid, creditsConsumed: -1 }).success).toBe(false);
  });
});
