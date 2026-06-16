// password.test.ts — proves the Argon2id credential primitive (ADR-0010) and the bug-3 FAIL-CLOSED contract:
// the password it was hashed from verifies TRUE, a wrong password FALSE, and an UNPARSEABLE/foreign digest
// fails CLOSED (resolves to false — never throws out, never returns true). A verify-time fault can therefore
// never become an auth bypass; it is only ever a rejection. argon2 only — no DB, no env.
import { describe, expect, it } from "bun:test";
import { hashPassword, verifyPassword } from "./password.ts";

describe("verifyPassword", () => {
  it("round-trips: the digest verifies TRUE for the password it was hashed from", async () => {
    const digest = await hashPassword("correct horse battery staple");
    expect(digest.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(digest, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password — FALSE, not a throw", async () => {
    const digest = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(digest, "wrong password")).toBe(false);
  });

  it("fails CLOSED on an unparseable/foreign digest — always false, never throws, never bypasses", async () => {
    // A malformed/foreign digest makes argon2 verify throw; verifyPassword must resolve it to FALSE (reject),
    // never true. This is the bug-3 guarantee — a non-password fault can never grant access.
    for (const bad of ["", "not-a-hash", "$2b$10$bcryptish", "$argon2id$v=19$broken"]) {
      expect(await verifyPassword(bad, "anything")).toBe(false);
    }
  });

  it("is salted: the same password hashes to distinct digests that each verify TRUE", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same-password")).toBe(true);
    expect(await verifyPassword(b, "same-password")).toBe(true);
  });
});
