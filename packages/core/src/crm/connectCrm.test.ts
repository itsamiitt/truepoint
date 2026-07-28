// connectCrm.test.ts — the PURE security gates of the CRM OAuth connect (crm-sync 00 §5.2). No DB, no
// network: these cover the three checks that stand between a hostile callback and a stored connection —
// the instance-URL validation, the granted-scope check, and PKCE generation.
//
// The tenancy check (a callback must never select a tenant) and the single-use state consume are covered in
// packages/db/test/crmConnect.itest.ts, because both need a real database to mean anything.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CrmConnectError,
  assertSafeInstanceUrl,
  assertScopesNotBroadened,
  generatePkcePair,
} from "./connectCrm.ts";

describe("assertSafeInstanceUrl", () => {
  test("accepts a real Salesforce instance host and returns its ORIGIN", async () => {
    // Returns the origin, not the raw string: a provider that hands back a URL with a path, query or
    // fragment must not have any of it concatenated into every later API call.
    expect(await assertSafeInstanceUrl("https://acme.my.salesforce.com/services/data/v61.0/")).toBe(
      "https://acme.my.salesforce.com",
    );
  });

  test("accepts a force.com host", async () => {
    expect(await assertSafeInstanceUrl("https://acme.lightning.force.com")).toBe(
      "https://acme.lightning.force.com",
    );
  });

  for (const hostile of [
    "https://evil.example.com", // public, not Salesforce — the SSRF guard alone would PASS this
    "https://salesforce.com.evil.example.com", // suffix-lookalike
    "https://notsalesforce.com", // substring, not a suffix match
    "http://acme.my.salesforce.com", // plaintext — a token would ride an unencrypted hop
  ]) {
    test(`rejects ${hostile}`, async () => {
      await expect(assertSafeInstanceUrl(hostile)).rejects.toThrow(CrmConnectError);
    });
  }

  for (const internal of [
    "https://127.0.0.1",
    "https://localhost",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata — the classic SSRF target
    "https://10.0.0.5",
    "file:///etc/passwd",
    "not-a-url",
  ]) {
    test(`rejects the internal/invalid target ${internal}`, async () => {
      await expect(assertSafeInstanceUrl(internal)).rejects.toThrow(CrmConnectError);
    });
  }

  test("the rejection reason is a stable code, safe to log", async () => {
    try {
      await assertSafeInstanceUrl("https://evil.example.com");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CrmConnectError);
      expect((err as CrmConnectError).reason).toBe("instance_url_rejected");
    }
  });
});

describe("assertScopesNotBroadened", () => {
  test("allows exactly what was requested", () => {
    expect(() =>
      assertScopesNotBroadened(["api", "refresh_token"], ["api", "refresh_token"]),
    ).not.toThrow();
  });

  test("allows FEWER scopes than requested (a capability problem, not a security one)", () => {
    expect(() => assertScopesNotBroadened(["api", "refresh_token"], ["api"])).not.toThrow();
  });

  test("refuses a grant broader than requested", () => {
    expect(() => assertScopesNotBroadened(["api"], ["api", "full"])).toThrow(CrmConnectError);
  });

  test("refuses the SFDC 'full' scope sneaking in alone", () => {
    expect(() => assertScopesNotBroadened(["api", "refresh_token"], ["full"])).toThrow(
      CrmConnectError,
    );
  });

  test("compares case-insensitively, so casing alone is not a bypass", () => {
    expect(() => assertScopesNotBroadened(["API"], ["api"])).not.toThrow();
    expect(() => assertScopesNotBroadened(["api"], ["API", "FULL"])).toThrow(CrmConnectError);
  });

  test("an empty grant is not a broadening", () => {
    expect(() => assertScopesNotBroadened(["api"], [])).not.toThrow();
  });

  test("the reason code identifies the check", () => {
    try {
      assertScopesNotBroadened(["api"], ["full"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as CrmConnectError).reason).toBe("scopes_exceeded");
    }
  });
});

describe("generatePkcePair", () => {
  test("challenge is base64url(sha256(verifier)) — RFC 7636 S256", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  test("verifier length is inside the RFC's 43..128 range", () => {
    const { verifier } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  test("base64url only — no +, / or = that would need re-encoding in a URL", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test("every pair is fresh — a reused verifier would defeat the whole exchange", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generatePkcePair().verifier);
    expect(seen.size).toBe(50);
  });
});
