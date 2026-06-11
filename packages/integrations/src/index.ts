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
