// @leadwolf/identity — the one canonical home for the monorepo's identity primitives: pre-hash normalization,
// the HMAC blind index, and the stable content hash (doc 16 duplication kill-list #1/#9). Pure, side-effect-
// free, and keyed off the single validated env.BLIND_INDEX_KEY, so Forge and the main app resolve the same
// person/company to the same keys. All callers (core, forge-core, db) resolve these from here — the old
// core/import copies are gone; test/parity.test.ts locks the outputs to the persisted convention.
export { blindIndex, blindIndexHex } from "./blindIndex.ts";
export { contentHash, contentHashHex } from "./contentHash.ts";
export {
  emailDomainOf,
  linkedinPublicIdOf,
  normalizeDomain,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
  normalizeText,
} from "./normalize.ts";
