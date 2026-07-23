// blindIndex.ts — re-export shim. The canonical HMAC-SHA256 blind index now lives ONCE in @leadwolf/identity
// (doc 16 duplication kill-list #1), so the main app and Forge derive the SAME per-workspace index from a
// single source. Behavior is byte-for-byte unchanged — proven by packages/identity/test/parity.test.ts —
// and every existing `../import/blindIndex.ts` caller (plus the public re-export at core index.ts) keeps
// working. Key discipline (stable, secret, KMS-wrapped; rotating it breaks dedup) is documented at the source.
export { blindIndex } from "@leadwolf/identity";
