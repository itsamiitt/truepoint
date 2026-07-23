// contentHash.ts — the CANONICAL stable SHA-256 over a payload (@leadwolf/identity; doc 16 kill-list #9).
// Keys are sorted before hashing so field order never changes the hash; undefined fields are dropped.
// Relocated verbatim from packages/core/src/import/contentHash.ts so import idempotency and Forge's
// server-side capture hash derive from one implementation (never the client-declared hash — P-01.12).
import { createHash } from "node:crypto";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** SHA-256 of the stable-serialized payload → 32 raw bytes for a bytea content_hash column. */
export function contentHash(payload: unknown): Uint8Array {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest();
}

/** Hex of the same 32 bytes — for text content_hash columns (e.g. Forge's raw_captures.content_hash). */
export function contentHashHex(payload: unknown): string {
  return Buffer.from(contentHash(payload)).toString("hex");
}
