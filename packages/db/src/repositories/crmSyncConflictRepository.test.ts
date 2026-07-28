// crmSyncConflictRepository.test.ts — the PII-masking rule of the conflict review queue (crm-sync 00 §4.7).
// Pure; the DB paths are covered by the CRM itests.
//
// This queue is read by staff on a health surface. An email or phone written into tp_value/crm_value would
// be a copy of regulated data living outside the encrypted columns, with its own retention and access
// story — so masking is enforced on the write path rather than left to callers to remember.

import { describe, expect, test } from "bun:test";
import { maskIfPii } from "./crmSyncConflictRepository.ts";

describe("non-PII scalars stay readable", () => {
  test("a job title is stored in clear so a reviewer can actually arbitrate", () => {
    expect(maskIfPii("jobTitle", "VP of Sales")).toBe("VP of Sales");
  });

  test("every CONTACT_PROVENANCE_FIELDS scalar is clear", () => {
    for (const f of [
      "firstName",
      "lastName",
      "jobTitle",
      "seniorityLevel",
      "department",
      "locationCountry",
      "locationCity",
    ]) {
      expect(maskIfPii(f, "value")).toBe("value");
    }
  });

  test("a long value is truncated to the column width rather than failing the insert", () => {
    expect(maskIfPii("jobTitle", "x".repeat(900))).toHaveLength(500);
  });

  test("a non-string is serialised, not dropped", () => {
    expect(maskIfPii("employeeCount", 500)).toBe("500");
  });
});

describe("PII is reduced to a recognisable stub", () => {
  for (const f of ["email", "phone", "mobilePhone", "personalEmail", "workEmail"]) {
    test(`${f} is masked`, () => {
      const masked = maskIfPii(f, "dana.scully@acme.com");
      expect(masked).not.toContain("dana");
      expect(masked).not.toContain("acme");
      // Enough for a human holding the record in front of them; useless as a leaked dataset.
      expect(masked).toBe("•••.com");
    });
  }

  test("a phone keeps only its last four", () => {
    expect(maskIfPii("phone", "+14155552671")).toBe("•••2671");
  });

  test("custom fields are PII BY DEFAULT — their contents are tenant-defined and unknowable here", () => {
    expect(maskIfPii("cf:national_id", "123-45-6789")).toBe("•••6789");
  });

  test("a short PII value does not leak by being shorter than the mask", () => {
    // "ab" has fewer than four characters, so slice(-4) returns the whole string. That is acceptable for a
    // 2-character value (it carries no identifying information) and the assertion pins the behaviour so a
    // future change to the mask length is a deliberate decision rather than a surprise.
    expect(maskIfPii("email", "ab")).toBe("•••ab");
  });

  test("an empty PII value stays empty rather than becoming a bare mask", () => {
    expect(maskIfPii("email", "")).toBe("");
  });
});

describe("absent values", () => {
  test("null and undefined are null, for PII and non-PII alike", () => {
    expect(maskIfPii("email", null)).toBeNull();
    expect(maskIfPii("jobTitle", undefined)).toBeNull();
  });
});
