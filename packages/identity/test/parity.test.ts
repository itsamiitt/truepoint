import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
// Characterization guard: these vectors lock the PERSISTED conventions — the master graph's blind indexes
// (master_emails.email_blind_index) and the (workspace_id, content_hash) import-idempotency index were built
// with exactly these algorithms: HMAC-SHA256(BLIND_INDEX_KEY, utf8(normalized)) and SHA-256 over the
// key-sorted, undefined-dropping stable serialization. A drift in any output silently corrupts master-graph
// matching and import dedup (doc 19), so a failure here means STOP and investigate — never update the
// expected values to match new behavior. (This replaced the core-vs-identity parity test, which became
// vacuous once packages/core's copies turned into re-export shims of this package.)
import { env } from "@leadwolf/config";
import { blindIndex, blindIndexHex } from "../src/blindIndex.ts";
import { contentHashHex } from "../src/contentHash.ts";
import { normalizeEmailForIndex, normalizeEmailForStorage } from "../src/normalize.ts";

describe("persisted normalization convention", () => {
  const cases: Array<[raw: string, storage: string, index: string]> = [
    ["Jane.Doe@Example.com", "jane.doe@example.com", "jane.doe@example.com"], // dots KEPT
    ["jane+promo@example.com", "jane+promo@example.com", "jane@example.com"], // +tag stripped for index only
    ["  MixedCase+tag@Sub.Domain.COM ", "mixedcase+tag@sub.domain.com", "mixedcase@sub.domain.com"],
    ["renée@example.com", "renée@example.com", "renée@example.com"], // unicode passes through
    ["j@d.io", "j@d.io", "j@d.io"],
  ];
  test("storage and index forms match the persisted vectors", () => {
    for (const [raw, storage, index] of cases) {
      expect(normalizeEmailForStorage(raw)).toBe(storage);
      expect(normalizeEmailForIndex(storage)).toBe(index);
    }
  });
});

describe("persisted blind-index convention", () => {
  test("is HMAC-SHA256(BLIND_INDEX_KEY, utf8(normalized)) — bytes and hex agree", () => {
    for (const v of ["jane@example.com", "mixedcase@sub.domain.com", "renée@example.com"]) {
      const expected = createHmac("sha256", env.BLIND_INDEX_KEY).update(v, "utf8").digest("hex");
      expect(blindIndexHex(v)).toBe(expected);
      expect(Buffer.from(blindIndex(v)).toString("hex")).toBe(expected);
    }
  });
});

describe("persisted content-hash convention (golden vectors)", () => {
  test("key order never changes the hash", () => {
    const golden = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";
    expect(contentHashHex({ a: 1, b: 2 })).toBe(golden);
    expect(contentHashHex({ b: 2, a: 1 })).toBe(golden);
    expect(contentHashHex({ a: 1, b: 2, c: undefined })).toBe(golden); // undefined fields dropped
  });
  test("nested objects, scalars and arrays match the persisted vectors", () => {
    expect(contentHashHex({ nested: { z: 1, a: [3, 2, 1] }, x: undefined })).toBe(
      "bd37dac9ad2697e1921e01475c75a1b5b3847304147a9417d14985093ebf38bd",
    );
    expect(contentHashHex("scalar")).toBe(
      "1cf2462dbf783967e4408e886e4569a77da29314f99d4e6f78fed80de817b185",
    );
    expect(contentHashHex([1, 2, 3])).toBe(
      "a615eeaee21de5179de080de8c3052c8da901138406ba71c38c032845f7d54f4",
    );
  });
});
