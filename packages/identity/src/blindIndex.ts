// blindIndex.ts — the CANONICAL deterministic HMAC-SHA256 blind index (@leadwolf/identity; doc 16 kill-list
// #1, the P-01.6 fix). The key is env.BLIND_INDEX_KEY — the SAME validated, no-fallback secret the master
// graph was built with, so a Forge value and a main-app value for the same normalized input produce identical
// bytes. There is deliberately NO dev-default key here (unlike the old forge BLIND_INDEX_KEY), so adopting
// this module also closes P-01.14. Rotating the key changes every index and breaks dedup — treat it as a
// long-lived, KMS-wrapped data key (truepoint-security data-protection.md).
import { createHmac } from "node:crypto";
import { env } from "@leadwolf/config";

/** HMAC-SHA256(normalized) → 32 raw bytes for a bytea column. Caller passes an already-normalized value. */
export function blindIndex(normalized: string): Uint8Array {
  return createHmac("sha256", env.BLIND_INDEX_KEY).update(normalized, "utf8").digest();
}

/** Hex of the same 32 bytes — for text columns (e.g. Forge's silver blind-index columns) fed from one source. */
export function blindIndexHex(normalized: string): string {
  return Buffer.from(blindIndex(normalized)).toString("hex");
}
