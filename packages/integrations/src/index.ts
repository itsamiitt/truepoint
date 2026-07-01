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
  stripeAdapter,
  type StripeAdapterOptions,
  type FetchStripe,
  defaultFetchStripe,
} from "./stripe/stripeAdapter.ts";
