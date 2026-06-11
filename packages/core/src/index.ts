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

export {
  enrichContact,
  type EnrichContactInput,
  type EnrichContactResult,
} from "./enrichment/enrichContact.ts";
export type {
  EnrichmentProvider,
  EnrichRequest,
  EnrichSubject,
  ProviderResult,
  ProviderFieldResult,
} from "./enrichment/providerPort.ts";
export { requestHash } from "./enrichment/requestHash.ts";
export { runWaterfall, orderProviders, resetBreakers } from "./enrichment/waterfall.ts";

export {
  passThroughVerifier,
  staticVerifier,
  type EmailVerifierPort,
} from "./data-health/emailVerifier.ts";
export { chargeFor, type ChargeInput } from "./data-health/chargeFor.ts";
export { validatePhone } from "./data-health/validatePhone.ts";

export {
  computeScore,
  type ComputeScoreInput,
  type ComputeScoreResult,
} from "./scoring/computeScore.ts";
export { grantFromStripe } from "./billing/grantFromStripe.ts";
export {
  verifyStripeSignature,
  signStripePayload,
  parseCreditGrantEvent,
  type CreditGrantEvent,
} from "./billing/stripeWebhook.ts";
