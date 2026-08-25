import { describe, expect, test } from "bun:test";
// Cross-system identity-match guard (P-01.6): Forge's silver blind index (hex), decoded hex→bytes, MUST equal
// the master graph's bytea for the same email — so a Forge-synced person LINKs to the existing master_persons
// cluster instead of minting a duplicate, and DSAR/suppression keyed on that index reaches Forge data. The
// master-side reference is @leadwolf/identity, imported by relative path (test files are exempt from the
// dependency-cruiser boundary rules).
import {
  blindIndex as coreBlindIndex,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
} from "../../identity/src/index.ts";
import { blindIndex, normalizeEmail } from "../src/blindIndex.ts";

// Uint8Array.from on both sides, and the result annotated Uint8Array<ArrayBuffer>. TypeScript 5.7 made the
// typed arrays generic over their buffer, and identity.blindIndex returns node crypto's Buffer — whose
// buffer is ArrayBufferLike (it may be a SharedArrayBuffer), which does not satisfy the Uint8Array<ArrayBuffer>
// that bun's toEqual overloads accept. Uint8Array.from copies element-wise, so the BYTES compared are exactly
// what they were; only the declared buffer kind changes.
const masterBytes = (email: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(coreBlindIndex(normalizeEmailForIndex(normalizeEmailForStorage(email) ?? email)));

describe("forge blind index ↔ master graph", () => {
  const emails = ["Jane.Doe@Example.com", "jane+promo@example.com", "  Mixed+Tag@Sub.Domain.COM "];

  test("normalizeEmail produces the master index form (+tag stripped, dots kept)", () => {
    expect(normalizeEmail("Jane+promo@Example.com")).toBe("jane@example.com");
    expect(normalizeEmail("jane.doe@example.com")).toBe("jane.doe@example.com");
  });

  test("forge hex, decoded hex→bytes (the sync-seam decode), equals the master bytea", () => {
    for (const e of emails) {
      const forgeHex = blindIndex(normalizeEmail(e)); // what Forge stores in silver (text)
      expect(forgeHex).toMatch(/^[0-9a-f]{64}$/);
      expect(Uint8Array.from(Buffer.from(forgeHex, "hex"))).toEqual(masterBytes(e));
    }
  });
});
