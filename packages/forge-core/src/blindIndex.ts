// blindIndex.ts — Forge's silver blind index, now derived from the CANONICAL @leadwolf/identity primitives
// (doc 16 duplication kill-list #1; the P-01.6 / P-01.14 fix). The bytes are HMAC-SHA256 under the single
// validated env.BLIND_INDEX_KEY — the SAME key + normalization the master graph uses — so a Forge silver index
// and a master_emails index for the same email are byte-identical, and the sync seam decodes this hex straight
// to the master bytea (forgeSyncRepository.applyItem). The old forge dev-default key and trim-only normalization
// are gone; Silver still carries HMAC only, never clear PII (invariant 3).
import {
  blindIndexHex,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
} from "@leadwolf/identity";

/** Canonical index-form normalization: the storage form (trim+lowercase) minus the local-part "+tag". */
export function normalizeEmail(email: string): string {
  const storage = normalizeEmailForStorage(email);
  return storage ? normalizeEmailForIndex(storage) : email.trim().toLowerCase();
}

/** HEX HMAC blind index for Forge's silver `text` columns — the hex of the master graph's exact bytea. */
export function blindIndex(normalized: string): string {
  return blindIndexHex(normalized);
}
