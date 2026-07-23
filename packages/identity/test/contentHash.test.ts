import { describe, expect, test } from "bun:test";
import { contentHash, contentHashHex } from "../src/contentHash.ts";

describe("contentHash", () => {
  test("returns 32 raw bytes", () => {
    const h = contentHash({ a: 1 });
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h.length).toBe(32);
  });
  test("is key-order independent", () => {
    expect(contentHashHex({ a: 1, b: 2 })).toBe(contentHashHex({ b: 2, a: 1 }));
  });
  test("drops undefined fields", () => {
    expect(contentHashHex({ a: 1, b: undefined })).toBe(contentHashHex({ a: 1 }));
  });
  test("distinct payloads → distinct hashes", () => {
    expect(contentHashHex({ a: 1 })).not.toBe(contentHashHex({ a: 2 }));
  });
  test("hex accessor is the hex of the raw bytes (64 chars)", () => {
    expect(contentHashHex({ a: 1 })).toBe(Buffer.from(contentHash({ a: 1 })).toString("hex"));
    expect(contentHashHex({ a: 1 })).toHaveLength(64);
  });
});
