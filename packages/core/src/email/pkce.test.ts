// pkce.test.ts — RFC 7636 conformance for the mailbox-OAuth PKCE/state helpers (M12 P1). Pure, no network.

import { describe, expect, it } from "bun:test";
import { generatePkce, pkceChallenge, randomState } from "./pkce.ts";

const URLSAFE = /^[A-Za-z0-9_-]+$/;

describe("generatePkce", () => {
  it("mints a 43-char url-safe verifier within RFC 7636's 43..128 bound", () => {
    const { verifier } = generatePkce();
    expect(verifier).toHaveLength(43); // base64url(32 bytes), no padding
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(URLSAFE);
  });

  it("produces a challenge that is the S256 of the verifier", () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(pkceChallenge(verifier));
    expect(challenge).toMatch(URLSAFE);
    expect(challenge).not.toContain("=");
  });

  it("is non-deterministic across calls (fresh entropy each time)", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("pkceChallenge", () => {
  it("is stable for a fixed verifier and matches a known S256 vector", () => {
    // RFC 7636 Appendix B canonical example.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("randomState", () => {
  it("returns a url-safe high-entropy token that varies per call", () => {
    const s1 = randomState();
    const s2 = randomState();
    expect(s1).toMatch(URLSAFE);
    expect(s1.length).toBeGreaterThanOrEqual(32);
    expect(s1).not.toBe(s2);
  });
});
