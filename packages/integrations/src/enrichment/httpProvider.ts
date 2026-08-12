// httpProvider.ts — the shared shape of a vendor-backed EnrichmentProvider (06 §3): one GET or POST to
// the vendor's match endpoint, mapped onto the port's ProviderResult. `fetchJson` is injectable so
// contract tests run on RECORDED fixtures with zero live spend (14 §3.5); a missing API key reports
// `miss` and the waterfall simply moves on.
//
// The default transport is HARDENED (truepoint-security integrations mandate — the outbound-allowlist
// gap this file used to carry is closed here):
//   • https-only + a FIXED host allowlist (ALLOWED_PROVIDER_HOSTS) — provider URLs are our constants,
//     never user input, so a registry pin + no-redirect + https-only is the right-sized SSRF guard;
//   • AbortController timeout (ENRICH_PROVIDER_TIMEOUT_MS) — a hung vendor must not hold a worker to
//     its deadline;
//   • response size cap (ENRICH_PROVIDER_MAX_RESPONSE_BYTES) before JSON.parse;
//   • redirect: "error" — a vendor response never silently re-routes egress off the allowlist.
// Status taxonomy (the crm-sync/hubspotHttp.ts idiom): 429 → rate_limited (+ Retry-After surfaced as
// retryAfterMs, zero cost); other 4xx/5xx → error (zero cost; the breaker counts it); a 2xx with no
// extractable fields → PAID miss (vendors charge per lookup). The vendor payload is untrusted input —
// extract() string-narrows every value before it can reach storage.

import { env } from "@leadwolf/config";
import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "@leadwolf/core";
import type { EnrichCapability, EnrichField } from "@leadwolf/types";

export type FetchJson = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown },
) => Promise<{ status: number; json: unknown; headers?: Record<string, string> }>;

/** The only hosts the default transport will speak to. Adding a vendor = adding its API host here. */
export const ALLOWED_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  "api.apollo.io",
  "api.zoominfo.com",
  "person.clearbit.com",
  "api.peopledatalabs.com",
  "api.coresignal.com",
]);

/** Thrown by the default transport on a policy violation (bad scheme/host) — surfaces as a zero-cost error. */
export class ProviderTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

export const defaultFetchJson: FetchJson = async (url, init) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new ProviderTransportError(`provider url must be https: ${parsed.protocol}`);
  }
  if (!ALLOWED_PROVIDER_HOSTS.has(parsed.host)) {
    throw new ProviderTransportError(`provider host not allowlisted: ${parsed.host}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ENRICH_PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      method: init.method,
      headers:
        init.method === "POST"
          ? { "content-type": "application/json", ...init.headers }
          : { ...init.headers },
      body: init.method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    if (text.length > env.ENRICH_PROVIDER_MAX_RESPONSE_BYTES) {
      throw new ProviderTransportError(
        `provider response exceeds ${env.ENRICH_PROVIDER_MAX_RESPONSE_BYTES} bytes`,
      );
    }
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, json, headers };
  } finally {
    clearTimeout(timer);
  }
};

export interface VendorSpec {
  name: string;
  trust: number; // ∈ [0,1] — waterfall ordering input (06 §4)
  costMicrosPerCall: number;
  url: string;
  /** HTTP verb — default POST (the original shape). GET vendors supply `query` instead of `body`. */
  method?: "GET" | "POST";
  apiKey: string | undefined;
  headers(apiKey: string): Record<string, string>;
  /** POST body (ignored for GET). */
  body?(req: EnrichRequest): unknown;
  /** GET query params (ignored for POST). Undefined values are dropped. */
  query?(req: EnrichRequest): Record<string, string | undefined>;
  /** What this vendor can actually answer — the waterfall's capability filter reads it. Default: all contact. */
  capabilities?: EnrichCapability[];
  /** Map the vendor payload to (field → value); return {} for a no-match payload. */
  extract(json: unknown, fields: EnrichField[]): Partial<Record<EnrichField, string>>;
}

/** Parse a Retry-After header (seconds form; the delta every enrichment vendor uses) to ms. */
function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

export function vendorProvider(
  spec: VendorSpec,
  fetchJson: FetchJson = defaultFetchJson,
): EnrichmentProvider {
  const method = spec.method ?? "POST";
  return {
    name: spec.name,
    capabilities: spec.capabilities ?? ["contact.email", "contact.phone", "contact.profile"],
    trust: spec.trust,
    estimateCostMicros: () => spec.costMicrosPerCall,
    async enrich(req: EnrichRequest): Promise<ProviderResult> {
      if (!spec.apiKey) return { fields: [], rawPayload: null, costMicros: 0, status: "miss" };

      let url = spec.url;
      if (method === "GET" && spec.query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(spec.query(req))) {
          if (v !== undefined && v.length > 0) params.set(k, v);
        }
        const qs = params.toString();
        if (qs.length > 0) url = `${spec.url}?${qs}`;
      }

      let response: Awaited<ReturnType<FetchJson>>;
      try {
        response = await fetchJson(url, {
          method,
          headers: spec.headers(spec.apiKey),
          body: method === "POST" ? (spec.body?.(req) ?? {}) : undefined,
        });
      } catch {
        // Transport failure (timeout abort, allowlist violation, network) — zero-cost error; the
        // breaker counts it, the waterfall moves on. Never throw out of an adapter.
        return { fields: [], rawPayload: null, costMicros: 0, status: "error" };
      }

      const { status, json, headers } = response;
      if (status === 429)
        return {
          fields: [],
          rawPayload: json,
          costMicros: 0,
          status: "rate_limited",
          retryAfterMs: retryAfterMs(headers),
        };
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
