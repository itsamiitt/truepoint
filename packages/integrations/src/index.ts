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

// CRM connector adapters (crm-sync §5.1): the HubSpot adapter implementing core's CrmConnector port, plus the
// configured-set factory (mirrors defaultProviders()). The transport is the injectable CrmFetch; client
// id/secret are injected (never read from env here), so the adapter is unit-testable on recorded fixtures.
// Salesforce is the deferred fast-follow. core OWNS the port; this package implements it (16 §5).
export { hubspotConnector, defaultCrmConnectors, type HubspotConfig } from "./crm/hubspot.ts";
export {
  defaultCrmFetch,
  classifyHubspotStatus,
  parseHubspotLimits,
  CrmOAuthError,
  type CrmErrorOutcome,
} from "./crm/hubspotHttp.ts";
