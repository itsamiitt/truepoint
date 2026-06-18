// validateRow.test.ts — the pure per-row validation verdict shared by the preview and runImport (G-IMP-1).
// A row is valid iff it carries at least one well-formed identity key (email / LinkedIn / Sales-Nav id);
// otherwise it is rejected with per-field reasons that drive the rejected-rows artifact. No DB, no crypto.

import { describe, expect, test } from "bun:test";
import type { ColumnMapping } from "@leadwolf/types";
import { identitySignature, rejectedRowsFor, validateRow } from "./validateRow.ts";

const MAPPING: ColumnMapping = {
  email: "Email",
  firstName: "First",
  linkedinUrl: "LinkedIn",
  salesNavLeadId: "SNId",
};

describe("validateRow", () => {
  test("accepts a row with a well-formed email and exposes its normalized identity key", () => {
    const v = validateRow({ Email: "Jane+tag@Acme.com", First: "Jane" }, MAPPING);
    expect(v.ok).toBe(true);
    if (v.ok) {
      // +tag stripped + lowercased for the dedup key (normalizeEmailForIndex).
      expect(v.identity.emailKey).toBe("jane@acme.com");
      expect(identitySignature(v.identity)).toBe("e:jane@acme.com");
    }
  });

  test("rejects a row with no identity key (a whole-row reason, field=null)", () => {
    const v = validateRow({ First: "NoId" }, MAPPING);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reasons).toHaveLength(1);
      expect(v.reasons[0]?.field).toBeNull();
      expect(v.reasons[0]?.reason).toContain("no email");
    }
  });

  test("rejects a malformed email (field-level reason) AND the missing-identity-key reason", () => {
    const v = validateRow({ Email: "not-an-email", First: "Bad" }, MAPPING);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const fields = v.reasons.map((r) => r.field);
      expect(fields).toContain("email");
      // No valid identity key either → also a whole-row reason.
      expect(fields).toContain(null);
    }
  });

  test("a LinkedIn URL alone is a valid identity (no email needed)", () => {
    const v = validateRow({ LinkedIn: "https://linkedin.com/in/jane-doe" }, MAPPING);
    expect(v.ok).toBe(true);
    if (v.ok) expect(identitySignature(v.identity)).toBe("l:jane-doe");
  });

  test("a Sales-Nav id alone is a valid identity", () => {
    const v = validateRow({ SNId: "ACwAAA123" }, MAPPING);
    expect(v.ok).toBe(true);
    if (v.ok) expect(identitySignature(v.identity)).toBe("s:ACwAAA123");
  });

  test("an unmapped/empty email field does not crash and yields a missing-identity reject", () => {
    const v = validateRow({ Email: "  ", First: "Blank" }, MAPPING);
    expect(v.ok).toBe(false);
  });
});

describe("rejectedRowsFor", () => {
  test("emits one artifact entry per reason, echoing the raw row", () => {
    const raw = { Email: "bad", First: "X" };
    const rows = rejectedRowsFor(7, raw, [
      { field: "email", reason: "Malformed email address." },
      { field: null, reason: "No identity key." },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ row: 7, field: "email", reason: "Malformed email address.", raw });
    expect(rows[1]?.field).toBeNull();
    expect(rows[1]?.raw).toBe(raw);
  });
});

describe("identitySignature", () => {
  test("is undefined when no key is present", () => {
    expect(identitySignature({})).toBeUndefined();
  });
  test("prefers email over linkedin over sales-nav (stable precedence)", () => {
    expect(
      identitySignature({ emailKey: "a@b.com", linkedinPublicId: "x", salesNavLeadId: "y" }),
    ).toBe("e:a@b.com");
    expect(identitySignature({ linkedinPublicId: "x", salesNavLeadId: "y" })).toBe("l:x");
  });
});
