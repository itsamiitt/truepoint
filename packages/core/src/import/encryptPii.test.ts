// encryptPii.test.ts — roundtrip + the corruption-tolerance contract decryptPiiOrNull carries for the
// reveal read path (launch-scale Phase 2 finding F5: a poisoned ciphertext must mask a field, never throw).

import { describe, expect, test } from "bun:test";
import { decryptPii, decryptPiiOrNull, encryptPii } from "./encryptPii.ts";

describe("encryptPii", () => {
  test("roundtrips utf8 plaintext", () => {
    const blob = encryptPii("priya.sharma@example.com");
    expect(decryptPii(blob)).toBe("priya.sharma@example.com");
    expect(decryptPiiOrNull(blob)).toBe("priya.sharma@example.com");
  });

  test("decryptPii throws on a corrupted auth tag; decryptPiiOrNull returns null", () => {
    const blob = Buffer.from(encryptPii("+91 98765 43210"));
    blob.writeUInt8(blob.readUInt8(15) ^ 0xff, 15); // flip one auth-tag byte (layout: iv 12 | tag 16 | ct)
    expect(() => decryptPii(blob)).toThrow();
    expect(decryptPiiOrNull(blob)).toBeNull();
  });

  test("decryptPiiOrNull returns null on truncated/garbage blobs instead of throwing", () => {
    expect(decryptPiiOrNull(Buffer.from("not-a-ciphertext"))).toBeNull();
    expect(decryptPiiOrNull(Buffer.alloc(0))).toBeNull();
    expect(decryptPiiOrNull(Buffer.alloc(40))).toBeNull();
  });
});
