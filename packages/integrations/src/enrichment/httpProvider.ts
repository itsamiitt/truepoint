// httpProvider.ts — the shared shape of a vendor-backed EnrichmentProvider (06 §3): one POST to the
// vendor's match endpoint, mapped onto the port's ProviderResult. `fetchJson` is injectable so contract
// tests run on RECORDED fixtures with zero live spend (14 §3.5); a missing API key reports `miss` and the
// waterfall simply moves on.

import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "@leadwolf/core";
import type { EnrichField } from "@leadwolf/types";

export type FetchJson = (
  url: string,
  init: { headers: Record<string, string>; body: unknown },
) => Promise<{ status: number; json: unknown }>;

export const defaultFetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(init.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

export interface VendorSpec {
  name: string;
  trust: number; // ∈ [0,1] — waterfall ordering input (06 §4)
  costMicrosPerCall: number;
  url: string;
  apiKey: string | undefined;
  headers(apiKey: string): Record<string, string>;
  body(req: EnrichRequest): unknown;
  /** Map the vendor payload to (field → value); return {} for a no-match payload. */
  extract(json: unknown, fields: EnrichField[]): Partial<Record<EnrichField, string>>;
}

export function vendorProvider(
  spec: VendorSpec,
  fetchJson: FetchJson = defaultFetchJson,
): EnrichmentProvider {
  return {
    name: spec.name,
    capabilities: ["contact.email", "contact.phone", "contact.profile"],
    trust: spec.trust,
    estimateCostMicros: () => spec.costMicrosPerCall,
    async enrich(req: EnrichRequest): Promise<ProviderResult> {
      if (!spec.apiKey) return { fields: [], rawPayload: null, costMicros: 0, status: "miss" };
      const { status, json } = await fetchJson(spec.url, {
        headers: spec.headers(spec.apiKey),
        body: spec.body(req),
      });
      if (status === 429)
        return { fields: [], rawPayload: json, costMicros: 0, status: "rate_limited" };
      if (status >= 400) return { fields: [], rawPayload: json, costMicros: 0, status: "error" };

      const extracted = spec.extract(json, req.fields);
      const fields = Object.entries(extracted)
        .filter(([, v]) => typeof v === "string" && v.length > 0)
        .map(([field, value]) => ({ field: field as EnrichField, value: value as string }));
      return fields.length > 0
        ? { fields, rawPayload: json, costMicros: spec.costMicrosPerCall, status: "hit" }
        : { fields: [], rawPayload: json, costMicros: spec.costMicrosPerCall, status: "miss" };
    },
  };
}
