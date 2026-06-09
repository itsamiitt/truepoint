// contentHash.ts — a stable SHA-256 over a row's mapped payload so an identical re-import is a no-op
// (idempotency). Keys are sorted before hashing so field order never changes the hash. Backs the unique
// index (workspace_id, content_hash) on source_imports (03 §5/§11).

import { createHash } from "node:crypto";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** SHA-256 of the stable-serialized payload → 32 raw bytes for the bytea content_hash column. */
export function contentHash(payload: unknown): Uint8Array {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest();
}
