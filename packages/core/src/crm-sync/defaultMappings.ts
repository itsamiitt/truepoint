// defaultMappings.ts — the public surface for the out-of-box CRM field-mapping presets (crm-sync §4.3): the
// per-provider default `CrmFieldMapping[]` (HubSpot + Salesforce, each covering contact + account) and a
// `defaultMappingsFor(provider, object?)` selector. These are the tunable defaults a tenant seeds a fresh
// connection with and then overrides; the admin mapping editor + a startup self-check run them through
// validateCrmMappings. PURE data — no IO. The per-provider rationale lives in the two preset files.

import type { CrmFieldMapping, CrmObjectType, CrmProvider } from "@leadwolf/types";
import { HUBSPOT_DEFAULT_MAPPINGS } from "./defaultMappings.hubspot.ts";
import { SALESFORCE_DEFAULT_MAPPINGS } from "./defaultMappings.salesforce.ts";

/** Out-of-box per-provider defaults. Treat as read-only seeds — `defaultMappingsFor` hands back copies. */
export const DEFAULT_CRM_FIELD_MAPPINGS: Record<CrmProvider, CrmFieldMapping[]> = {
  hubspot: HUBSPOT_DEFAULT_MAPPINGS,
  salesforce: SALESFORCE_DEFAULT_MAPPINGS,
};

/**
 * The default mappings for a provider, optionally narrowed to one object. Returns a fresh array (a shallow
 * copy) so a caller may seed + edit without mutating the shared preset constant.
 */
export function defaultMappingsFor(
  provider: CrmProvider,
  objectType?: CrmObjectType,
): CrmFieldMapping[] {
  const all = DEFAULT_CRM_FIELD_MAPPINGS[provider];
  return objectType ? all.filter((m) => m.objectType === objectType) : [...all];
}
