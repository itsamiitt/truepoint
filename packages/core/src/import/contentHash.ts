// contentHash.ts — re-export shim. The canonical stable SHA-256 content hash now lives ONCE in
// @leadwolf/identity (doc 16 duplication kill-list #9); behavior is byte-for-byte unchanged
// (packages/identity/test/parity.test.ts). Keys are sorted and undefined fields dropped so field order never
// changes the hash — it backs the unique (workspace_id, content_hash) import-idempotency index unchanged.
export { contentHash } from "@leadwolf/identity";
