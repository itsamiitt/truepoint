// normalize.ts — re-export shim. The canonical pre-hash normalizers now live ONCE in @leadwolf/identity
// (doc 16 duplication kill-list #1); behavior is byte-for-byte unchanged (packages/identity/test/parity.test.ts).
// The two email forms (storage = trim+lowercase; index = storage minus the local-part "+tag"; dots are NOT
// stripped — that is gmail-only and would merge distinct identities) and the domain/linkedin normalizers all
// resolve from the single source, so import dedup and enrichment match-keys stay identical.
export {
  emailDomainOf,
  linkedinPublicIdOf,
  normalizeDomain,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
  normalizeText,
} from "@leadwolf/identity";
