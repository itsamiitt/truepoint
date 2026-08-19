// Public surface of @leadwolf/integrations — vendor adapters implementing core's enrichment port (06 §3).
// Consumers (apps/workers) inject these into core's enrichContact; core never imports this package (16 §5).
export {
  apolloProvider,
  zoominfoProvider,
  clearbitProvider,
  pdlProvider,
  coresignalProvider,
  pdlExtract,
  coresignalExtract,
  defaultProviders,
} from "./enrichment/providers.ts";
export {
  vendorProvider,
  defaultFetchJson,
  ALLOWED_PROVIDER_HOSTS,
  ProviderTransportError,
  type FetchJson,
  type VendorSpec,
} from "./enrichment/httpProvider.ts";
// Waterfall v2 (0111): the Redis-shared circuit breaker + per-provider rate/budget gate implementing
// core's BreakerStore/ProviderGate ports (wired at the worker composition root beside crmBudget).
export { redisBreakerStore, type BreakerRedis } from "./enrichment/redisBreakerStore.ts";
export { redisProviderGate, type GateRedis } from "./enrichment/redisProviderGate.ts";

// AI adapters (23, ADR-0023): the Anthropic Claude adapter fulfilling core's AiPort for NL→structured
// search. Injected at the app/composition layer; core declares the port and never imports this.
export {
  anthropicNlSearchAdapter,
  type NlSearchAdapterOptions,
  type FetchJson as AiFetchJson,
  defaultFetchJson as defaultAiFetchJson,
} from "./anthropic/nlSearchAdapter.ts";
export {
  anthropicReplyClassifierAdapter,
  ReplyClassifierError,
  type ReplyClassifierAdapterOptions,
} from "./anthropic/replyClassifierAdapter.ts";
export {
  stripeAdapter,
  type StripeAdapterOptions,
  type FetchStripe,
  defaultFetchStripe,
} from "./stripe/stripeAdapter.ts";

// GATE C (G08 / S-S2): the ClamAV clamd INSTREAM adapter for core's MalwareScannerPort — dependency-free
// node:net socket protocol, env-selected at the roots (MALWARE_SCANNER=clamav). Fail-closed on any outage.
export {
  clamdScanner,
  parseClamdResponse,
  instreamLengthPrefix,
  INSTREAM_COMMAND,
  INSTREAM_TERMINATOR,
  type ClamdScannerOptions,
  type ClamdSocketLike,
} from "./security/clamdScanner.ts";

// GATE B (G07): the S3-compatible FileStore adapter (dependency-free SigV4 over fetch — no AWS SDK) + the
// env selection seam BOTH app composition roots call: env unset ⇒ null (roots keep diskFileStore — dark,
// byte-identical to today). Provisioning the bucket + setting BULK_IMPORT_S3_* is the user-owed enable step.
export {
  s3FileStore,
  s3FileStoreFromEnv,
  bulkObjectStoreFromEnv,
  sigV4SigningKey,
  sha256Hex,
  S3StoreError,
  type S3FileStoreOptions,
  type S3Fetch,
} from "./storage/s3FileStore.ts";

// TruePoint Forge adapters (ADR-0046/0047; re-homed from @forge/integrations): the Redis rate limiter,
// the S3/MinIO object store, and the Anthropic extraction port the forge-api/forge-worker composition
// roots inject. Forge-core declares the ports and never imports this package.
export { forgeAiBudgetStore } from "./forgeAiBudgetStore.ts";
export { forgeRateLimiter } from "./forgeRateLimiter.ts";
export { forgeObjectStore, type ForgeS3Config } from "./forgeObjectStore.ts";
export {
  anthropicExtractionPort,
  defaultAnthropicTransport,
  type AnthropicExtractionConfig,
  type AnthropicResponse,
  type FetchJson as ForgeExtractionFetchJson,
} from "./forgeAnthropicExtraction.ts";
export { redisCacheStore } from "./redisCacheStore.ts";
export {
  bumpSearchVersion,
  scopeFromJobData,
  type SearchBumpRedis,
} from "./searchCacheBump.ts";

// CRM connector adapters (crm-sync §5.1): the HubSpot + Salesforce adapters implementing core's CrmConnector
// port, plus the configured-set factory (mirrors defaultProviders()). The transport is the injectable
// CrmFetch; client id/secret are injected (never read from env here), so the adapters are unit-testable on
// recorded fixtures. core OWNS the port; this package implements it (16 §5).
export { hubspotConnector, defaultCrmConnectors, type HubspotConfig } from "./crm-sync/hubspot.ts";
export {
  crmConnectorsFromEnv,
  type CrmCredentialEnv,
} from "./crm-sync/connectorsFromEnv.ts";
export {
  defaultCrmFetch,
  classifyHubspotStatus,
  parseHubspotLimits,
  CrmOAuthError,
  type CrmErrorOutcome,
} from "./crm-sync/hubspotHttp.ts";
export { salesforceConnector, type SalesforceConfig } from "./crm-sync/salesforce.ts";
export { classifySalesforceStatus, parseSalesforceLimits } from "./crm-sync/salesforceHttp.ts";

// The Redis-backed CRM API budget store (crm-sync §8.2) — SHARED across processes by design: a
// process-local counter would let N workers each grant the full budget. Injected at the composition root.
export {
  redisCrmBudgetStore,
  type CrmBudgetRedis,
} from "./crm-sync/crmBudgetStore.ts";
