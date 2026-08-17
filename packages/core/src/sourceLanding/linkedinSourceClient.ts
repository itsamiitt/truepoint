// linkedinSourceClient.ts — the ONE outbound client for the linkedin_api vendor fleet
// (docs/planning/linkedin-source-ingestion/ §fetch layer). The real contract, verbatim:
//
//   POST <origin>/api/linkedin/profile   body {url, include_raw, refresh, engine}   → person payload (v1)
//   POST <origin>/api/linkedin/company   body {url, include_raw, refresh, engine}   → company payload (v2)
//
// `url` is a LinkedIn / Sales-Navigator URL. include_raw is ALWAYS false from TruePoint (it echoes the
// vendor's intercepted payloads — the response body already carries everything we land). refresh defaults
// false to ride the vendor's 6h capture cache; the admin test-fetch overrides it. engine stays "auto".
//
// FAILOVER CHAIN (recorded user decision): origins from the router (priority-ordered, ≤60s-stale, keys
// decrypted) are tried in order. Per attempt the transport is the defaultFetchJson hardening, origin-scoped:
// https-only, the request host must equal THAT origin's host (no static allowlist — the fleet is
// DB-managed, super-admin-gated config), redirect:"error", ENRICH_PROVIDER_TIMEOUT_MS abort,
// ENRICH_PROVIDER_MAX_RESPONSE_BYTES cap before JSON.parse.
//
// Outcome taxonomy per attempt:
//   2xx + JSON object  → recordOutcome(ok), return {status:"ok", payload, originId}
//   429 / 5xx / transport error → recordOutcome(fail), NEXT origin
//   other 4xx          → the vendor rejected the REQUEST (bad url, unknown profile) — a different origin
//                        will say the same thing, so the chain STOPS: {status:"rejected", httpStatus}
//   chain exhausted    → {status:"unavailable"}

import { env } from "@leadwolf/config";
import { type ResolvedOrigin, loadOrigins, recordOriginOutcome } from "./originRouter.ts";

export interface LinkedinFetchOptions {
  /** Bypass the vendor's 6h capture cache (admin test-fetch only; spend-relevant). */
  refresh?: boolean;
  engine?: "auto" | "browser" | "replay";
}

export type LinkedinFetchResult =
  | { status: "ok"; payload: unknown; originId: string | null }
  | { status: "rejected"; httpStatus: number }
  | { status: "unavailable" };

/** Injectable transport for tests — same shape as one hardened attempt. */
export type LinkedinTransport = (
  url: string,
  init: { headers: Record<string, string>; body: unknown },
) => Promise<{ status: number; json: unknown }>;

export const defaultLinkedinTransport: LinkedinTransport = async (url, init) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`origin url must be https: ${parsed.protocol}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ENRICH_PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(init.body ?? {}),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    if (text.length > env.ENRICH_PROVIDER_MAX_RESPONSE_BYTES) {
      throw new Error(`response exceeds ${env.ENRICH_PROVIDER_MAX_RESPONSE_BYTES} bytes`);
    }
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
};

async function fetchViaChain(
  path: "/api/linkedin/profile" | "/api/linkedin/company",
  linkedinUrl: string,
  opts: LinkedinFetchOptions,
  transport: LinkedinTransport,
): Promise<LinkedinFetchResult> {
  const origins = await loadOrigins("linkedin_api");
  if (origins.length === 0) return { status: "unavailable" };

  const body = {
    url: linkedinUrl,
    include_raw: false,
    refresh: opts.refresh === true,
    engine: opts.engine ?? "auto",
  };

  for (const origin of origins) {
    const attempt = await attemptOrigin(origin, path, body, transport);
    if (attempt.kind === "ok") {
      await recordOriginOutcome(origin.id, true);
      return { status: "ok", payload: attempt.payload, originId: origin.id };
    }
    if (attempt.kind === "rejected") {
      // The request itself is bad — no origin will disagree. The origin is HEALTHY (it answered).
      await recordOriginOutcome(origin.id, true);
      return { status: "rejected", httpStatus: attempt.httpStatus };
    }
    await recordOriginOutcome(origin.id, false, attempt.error);
    // fall through to the next origin
  }
  return { status: "unavailable" };
}

type AttemptOutcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "rejected"; httpStatus: number }
  | { kind: "failed"; error: string };

async function attemptOrigin(
  origin: ResolvedOrigin,
  path: string,
  body: unknown,
  transport: LinkedinTransport,
): Promise<AttemptOutcome> {
  const url = `${origin.baseUrl}${path}`;
  // Origin-scoped host pinning: the URL we fetch is built from the stored base_url and nothing else, and
  // its host must still parse to the origin's own host (defence against a stored value that smuggles
  // credentials/paths — validated on write too; belt and braces).
  try {
    if (new URL(url).host !== origin.host) return { kind: "failed", error: "host mismatch" };
  } catch {
    return { kind: "failed", error: "unparseable origin url" };
  }
  const headers: Record<string, string> = {};
  if (origin.apiKey) headers["x-api-key"] = origin.apiKey;

  let res: { status: number; json: unknown };
  try {
    res = await transport(url, { headers, body });
  } catch (e) {
    return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 429 || res.status >= 500) {
    return { kind: "failed", error: `http ${res.status}` };
  }
  if (res.status >= 400) return { kind: "rejected", httpStatus: res.status };
  if (typeof res.json !== "object" || res.json === null) {
    return { kind: "failed", error: "non-json response" };
  }
  return { kind: "ok", payload: res.json };
}

/** Fetch one prospect profile document by LinkedIn/Sales-Navigator URL. */
export async function fetchLinkedinProfile(
  linkedinUrl: string,
  opts: LinkedinFetchOptions = {},
  transport: LinkedinTransport = defaultLinkedinTransport,
): Promise<LinkedinFetchResult> {
  return fetchViaChain("/api/linkedin/profile", linkedinUrl, opts, transport);
}

/** Fetch one company document by LinkedIn/Sales-Navigator URL. */
export async function fetchLinkedinCompany(
  linkedinUrl: string,
  opts: LinkedinFetchOptions = {},
  transport: LinkedinTransport = defaultLinkedinTransport,
): Promise<LinkedinFetchResult> {
  return fetchViaChain("/api/linkedin/company", linkedinUrl, opts, transport);
}

/** Sales-Navigator company URL from the stored numeric LinkedIn company id — the sweep's key. */
export function salesNavCompanyUrl(linkedinCompanyId: string): string {
  return `https://www.linkedin.com/sales/company/${encodeURIComponent(linkedinCompanyId)}`;
}
