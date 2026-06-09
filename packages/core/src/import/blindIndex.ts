// blindIndex.ts — deterministic HMAC-SHA256 blind index for per-workspace dedup of encrypted PII (03 §5,
// 08). The key (env.BLIND_INDEX_KEY) is STABLE + SECRET: rotating it changes every index and breaks dedup
// (14 §5.2), so it is treated like a long-lived data key. Same input → same bytes → the unique index
// (workspace_id, email_blind_index) makes exact duplicates impossible.

import { createHmac } from "node:crypto";
import { env } from "@leadwolf/config";

/** HMAC-SHA256(value) → 32 raw bytes, stored in a bytea column. Caller passes the already-normalized value. */
export function blindIndex(value: string): Uint8Array {
  return createHmac("sha256", env.BLIND_INDEX_KEY).update(value, "utf8").digest();
}
