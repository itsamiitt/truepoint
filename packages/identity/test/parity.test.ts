import { describe, expect, test } from "bun:test";
// Characterization guard: the canonical @leadwolf/identity primitives MUST reproduce, byte-for-byte, the
// implementations the live master graph was persisted with (packages/core/src/import/*). If this fails, the
// later dual-write cutover would silently corrupt master-graph matching (doc 19). Imported by relative path
// purely to lock the canonical form — test files are exempt from the dependency-cruiser boundary rules.
import { blindIndex as coreBlindIndex } from "../../core/src/import/blindIndex.ts";
import { contentHash as coreContentHash } from "../../core/src/import/contentHash.ts";
import {
  normalizeEmailForIndex as coreNormIndex,
  normalizeEmailForStorage as coreNormStorage,
} from "../../core/src/import/normalize.ts";
import { blindIndexHex } from "../src/blindIndex.ts";
import { contentHashHex } from "../src/contentHash.ts";
import { normalizeEmailForIndex, normalizeEmailForStorage } from "../src/normalize.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const emails = [
  "Jane.Doe@Example.com",
  "jane+promo@example.com",
  "  MixedCase+tag@Sub.Domain.COM ",
  "renée@example.com",
  "j@d.io",
];

const payloads: unknown[] = [
  { a: 1, b: 2 },
  { b: 2, a: 1 },
  { nested: { z: 1, a: [3, 2, 1] }, x: undefined },
  "scalar",
  [1, 2, 3],
];

describe("parity with the persisted main-app convention", () => {
  test("email normalization matches core/import", () => {
    for (const e of emails) {
      expect(normalizeEmailForStorage(e)).toBe(coreNormStorage(e));
      const s = normalizeEmailForStorage(e);
      if (s) expect(normalizeEmailForIndex(s)).toBe(coreNormIndex(s));
    }
  });
  test("blind index matches core/import byte-for-byte", () => {
    for (const e of emails) {
      const s = normalizeEmailForStorage(e);
      if (!s) continue;
      expect(blindIndexHex(normalizeEmailForIndex(s))).toBe(hex(coreBlindIndex(coreNormIndex(s))));
    }
  });
  test("content hash matches core/import byte-for-byte", () => {
    for (const p of payloads) {
      expect(contentHashHex(p)).toBe(hex(coreContentHash(p)));
    }
  });
});
