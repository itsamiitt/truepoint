// Public surface of @leadwolf/core — domain logic shared by apps/api and apps/workers. M1 exposes the
// import pipeline + the PII/dedup primitives; M3 adds the money loop (reveal transaction, suppression
// gate, audit writer, Stripe grant). Internals (normalize, contentHash, columnMap) stay private; import
// them relatively from within the package (incl. co-located tests).

export { runImport, type RunImportInput } from "./import/runImport.ts";
export { parseImportFile, parseCsv, type ParsedCsv } from "./import/parseFile.ts";
export type { RawRow } from "./import/columnMap.ts";
export { blindIndex } from "./import/blindIndex.ts";
export { encryptPii, decryptPii } from "./import/encryptPii.ts";

export { revealContact, revealCostFor, type RevealInput } from "./reveal/revealContact.ts";
export { assertNotSuppressed, type SuppressionKeys } from "./compliance/assertNotSuppressed.ts";
export { writeAudit, type AuditEntryInput } from "./compliance/writeAudit.ts";
export { grantFromStripe } from "./billing/grantFromStripe.ts";
export {
  verifyStripeSignature,
  signStripePayload,
  parseCreditGrantEvent,
  type CreditGrantEvent,
} from "./billing/stripeWebhook.ts";
