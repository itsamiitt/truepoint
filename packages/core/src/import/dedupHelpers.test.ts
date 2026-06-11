// dedupHelpers.test.ts — the crypto primitives behind dedup + at-rest PII. Blind index must be stable
// (same input → same bytes) so the unique index catches duplicates; PII encryption must round-trip; the
// content hash must be order-independent and identical-payload-stable.
import { describe, expect, test } from "bun:test";
import { blindIndex } from "./blindIndex.ts";
import { contentHash } from "./contentHash.ts";
import { decryptPii, encryptPii } from "./encryptPii.ts";

describe("blindIndex", () => {
  test("is deterministic for the same input", () => {
    expect(Buffer.from(blindIndex("jane@acme.com"))).toEqual(
      Buffer.from(blindIndex("jane@acme.com")),
    );
  });
  test("differs for different inputs", () => {
    expect(Buffer.from(blindIndex("jane@acme.com"))).not.toEqual(
      Buffer.from(blindIndex("john@acme.com")),
    );
  });
  test("produces 32 bytes (SHA-256)", () => {
    expect(blindIndex("x@y.com").length).toBe(32);
  });
});

describe("encryptPii", () => {
  test("round-trips", () => {
    const ct = encryptPii("jane@acme.com");
    expect(decryptPii(ct)).toBe("jane@acme.com");
  });
  test("is non-deterministic (random IV) but still decrypts", () => {
    const a = encryptPii("secret");
    const b = encryptPii("secret");
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
    expect(decryptPii(a)).toBe("secret");
    expect(decryptPii(b)).toBe("secret");
  });
});

describe("contentHash", () => {
  test("is stable regardless of key order", () => {
    const a = contentHash({ email: "j@a.com", name: "Jane" });
    const b = contentHash({ name: "Jane", email: "j@a.com" });
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });
  test("differs when content differs", () => {
    expect(Buffer.from(contentHash({ email: "j@a.com" }))).not.toEqual(
      Buffer.from(contentHash({ email: "J@a.com" })),
    );
  });
});
