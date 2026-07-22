// Public surface of @leadwolf/integrations — vendor adapters implementing core's enrichment port (06 §3).
// Consumers (apps/workers) inject these into core's enrichContact; core never imports this package (16 §5).
export {
  apolloProvider,
  zoominfoProvider,
  clearbitProvider,
  defaultProviders,
} from "./enrichment/providers.ts";
export {
  vendorProvider,
  defaultFetchJson,
  type FetchJson,
  type VendorSpec,
} from "./enrichment/httpProvider.ts";

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
export { forgeRateLimiter } from "./forgeRateLimiter.ts";
export { forgeObjectStore, type ForgeS3Config } from "./forgeObjectStore.ts";
export {
  anthropicExtractionPort,
  defaultAnthropicTransport,
  type AnthropicExtractionConfig,
  type AnthropicResponse,
  type FetchJson as ForgeExtractionFetchJson,
} from "./forgeAnthropicExtraction.ts";
