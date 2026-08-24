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
// ERROR-AWARE WALK (expo.truepoint.in/docs §Errors & classifications, via classifySourceError):
//   2xx + JSON object        → recordOutcome(ok), cooldown cleared, {status:"ok", payload, originId}
//   permanent(request)/miss  → the REQUEST is bad or honestly unmatched — every mirror answers the same,
//                              chain STOPS, origin recorded HEALTHY: {status:"rejected", httpStatus}
//   throttled / source_down /
//   permanent(origin)        → the ORIGIN is busy, out of service, or misconfigured (AUTH/FORBIDDEN) —
//                              cool it for the verdict's horizon (Retry-After wins, clamped to
//                              ENRICH_ORIGIN_COOLDOWN_MAX_MS), recordOutcome(fail, "[CLASS] http N …"),
//                              NEXT origin. Cooling origins are skipped on later walks at zero cost.
//   transient (502-class,
//   transport throw)         → up to ENRICH_ORIGIN_TRANSIENT_RETRIES cheap same-origin retries (the proxy
//                              caches + single-flights, so a retry is nearly free), then NEXT origin.
//   chain exhausted          → {status:"unavailable", retryAfterMs?, reason?} — retryAfterMs is the
//                              smallest horizon seen, so callers can DEFER instead of burning attempts.

import { env } from "@leadwolf/config";
import { retryAfterFromHeaders } from "../reliability/retryAfter.ts";
import { classifySourceError } from "../reliability/sourceErrorClassifier.ts";
import type { SourceClassifierDefaults } from "../reliability/sourceErrorClassifier.ts";
import { type OriginCooldownStore, originCooldowns } from "./originCooldowns.ts";
import { type ResolvedOrigin, loadOrigins, recordOriginOutcome } from "./originRouter.ts";

export interface LinkedinFetchOptions {
  /** Bypass the vendor's 6h capture cache (admin test-fetch only; spend-relevant). */
  refresh?: boolean;
  engine?: "auto" | "browser" | "replay";
}

export type LinkedinFetchResult =
  | { status: "ok"; payload: unknown; originId: string | null }
  | { status: "rejected"; httpStatus: number }
  | { status: "unavailable"; retryAfterMs?: number; reason?: "throttled" | "down" };

/** Injectable transport for tests — same shape as one hardened attempt. `headers` (lowercased) is
 *  optional so existing fake transports stay valid; without it Retry-After hints are simply absent. */
export type LinkedinTransport = (
  url: string,
  init: { headers: Record<string, string>; body: unknown },
) => Promise<{ status: number; json: unknown; headers?: Record<string, string> }>;

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
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, json, headers };
  } finally {
    clearTimeout(timer);
  }
};

/** The classifier's per-class waits, from env at call time (the ENRICH_PROVIDER_TIMEOUT_MS idiom). */
function classifierDefaults(): SourceClassifierDefaults {
  return {
    throttleFallbackMs: env.ENRICH_ORIGIN_THROTTLE_FALLBACK_MS,
    shutdownCooldownMs: env.ENRICH_ORIGIN_SHUTDOWN_COOLDOWN_MS,
    poolDeadCooldownMs: env.ENRICH_ORIGIN_POOL_DEAD_COOLDOWN_MS,
    seatDeadCooldownMs: env.ENRICH_ORIGIN_SEAT_DEAD_COOLDOWN_MS,
  };
}

/** `[CLASSIFICATION] http NNN retry_after=Ns cid=<id>` — the provider_origins.last_error format the
 *  admin console surfaces; recordOutcome truncates, so keep it front-loaded. */
function errorDetail(
  httpStatus: number | undefined,
  classification: string | undefined,
  correlationId: string | undefined,
  retryAfterMs: number | undefined,
): string {
  const parts: string[] = [];
  if (classification) parts.push(`[${classification}]`);
  if (httpStatus !== undefined) parts.push(`http ${httpStatus}`);
  if (retryAfterMs !== undefined) parts.push(`retry_after=${Math.round(retryAfterMs / 1000)}s`);
  if (correlationId) parts.push(`cid=${correlationId}`);
  return parts.length > 0 ? parts.join(" ") : "unclassified failure";
}

/** Dependency seams for walkOriginChain — all defaulted, so production callers are unchanged and tests
 *  need no module mocks (this file's stated convention). */
export interface ChainDeps {
  cooldowns?: OriginCooldownStore;
  recordOutcome?: typeof recordOriginOutcome;
  /** Same-origin retries for `transient` verdicts. Default env.ENRICH_ORIGIN_TRANSIENT_RETRIES. */
  transientRetries?: number;
  transientRetryDelayMs?: number;
  /** Jitter over the transient-retry delay — default spreads UP (never earlier than the base delay). */
  jitter?: (ms: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

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
  return walkOriginChain(origins, path, body, transport);
}

/**
 * The failover walk over a resolved origin list — exported with injected deps so tests drive it with
 * fake transports/cooldowns/clocks directly (no module mocks). Cooling origins are skipped for free;
 * their remaining horizon still feeds the `unavailable` result's retryAfterMs.
 */
export async function walkOriginChain(
  origins: ResolvedOrigin[],
  path: "/api/linkedin/profile" | "/api/linkedin/company",
  body: unknown,
  transport: LinkedinTransport,
  deps: ChainDeps = {},
): Promise<LinkedinFetchResult> {
  const cooldowns = deps.cooldowns ?? originCooldowns;
  const record = deps.recordOutcome ?? recordOriginOutcome;
  const transientRetries = deps.transientRetries ?? env.ENRICH_ORIGIN_TRANSIENT_RETRIES;
  const retryDelayMs = deps.transientRetryDelayMs ?? env.ENRICH_ORIGIN_TRANSIENT_RETRY_DELAY_MS;
  // Spread UP, never down: retrying EARLIER than the base delay is the herd behavior jitter exists to kill.
  const jitter = deps.jitter ?? ((ms: number) => Math.round(ms * (1 + 0.5 * Math.random())));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let minHorizonMs: number | undefined;
  let anyThrottled = false;
  const noteHorizon = (ms: number, throttled: boolean) => {
    minHorizonMs = Math.min(minHorizonMs ?? Number.POSITIVE_INFINITY, ms);
    if (throttled) anyThrottled = true;
  };

  for (const origin of origins) {
    const key = origin.id ?? origin.baseUrl;
    const state = cooldowns.cooling(key);
    if (state.cooling) {
      // Zero requests spent; the stored throttled bit keeps `reason` honest on later walks too
      // (a fleet cooled by AUTH/outage must not report as "throttled").
      noteHorizon(state.remainingMs, state.throttled);
      continue;
    }

    let attempt = await attemptOrigin(origin, path, body, transport);
    for (let retry = 0; attempt.kind === "transient" && retry < transientRetries; retry++) {
      await sleep(Math.max(0, jitter(retryDelayMs)));
      attempt = await attemptOrigin(origin, path, body, transport);
    }

    if (attempt.kind === "ok") {
      cooldowns.clear(key);
      await record(origin.id, true);
      return { status: "ok", payload: attempt.payload, originId: origin.id };
    }
    if (attempt.kind === "rejected") {
      // The request itself is bad or honestly unmatched — no origin will disagree. Origin HEALTHY.
      await record(origin.id, true);
      return { status: "rejected", httpStatus: attempt.httpStatus };
    }
    if (attempt.kind === "cooled") {
      // The STORED cooldown is clamped (a bad header must not brick an origin), but the REPORTED
      // horizon stays the vendor's own — the breaker/deferral layers carry their own caps, and a
      // daily-budget 86400s hint truncated to 1h would cost a wasted probe per origin per hour.
      cooldowns.set(
        key,
        Math.min(attempt.cooldownMs, env.ENRICH_ORIGIN_COOLDOWN_MAX_MS),
        attempt.throttled,
      );
      noteHorizon(attempt.cooldownMs, attempt.throttled);
      await record(origin.id, false, attempt.error);
      continue;
    }
    // transient, retries exhausted — record and fall through to the next origin (no cooldown: the next
    // walk should probe it again; a persistent fault graduates to source_down via its own classification).
    await record(origin.id, false, attempt.error);
  }

  if (minHorizonMs !== undefined && Number.isFinite(minHorizonMs)) {
    return {
      status: "unavailable",
      retryAfterMs: minHorizonMs,
      reason: anyThrottled ? "throttled" : "down",
    };
  }
  return { status: "unavailable" };
}

type AttemptOutcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "rejected"; httpStatus: number }
  | { kind: "cooled"; error: string; cooldownMs: number; throttled: boolean }
  | { kind: "transient"; error: string };

function envelopeStrings(json: unknown): { classification?: string; correlationId?: string } {
  if (typeof json !== "object" || json === null) return {};
  const body = json as Record<string, unknown>;
  return {
    classification: typeof body.classification === "string" ? body.classification : undefined,
    correlationId: typeof body.correlation_id === "string" ? body.correlation_id : undefined,
  };
}

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
    if (new URL(url).host !== origin.host) {
      // A stored base_url that no longer parses to its own host is origin MISCONFIG, not a blip — cool
      // it like a bad credential (operator has to act) instead of re-probing it on every walk.
      return {
        kind: "cooled",
        error: "host mismatch",
        cooldownMs: env.ENRICH_ORIGIN_SEAT_DEAD_COOLDOWN_MS,
        throttled: false,
      };
    }
  } catch {
    return {
      kind: "cooled",
      error: "unparseable origin url",
      cooldownMs: env.ENRICH_ORIGIN_SEAT_DEAD_COOLDOWN_MS,
      throttled: false,
    };
  }
  const headers: Record<string, string> = {};
  if (origin.apiKey) headers["x-api-key"] = origin.apiKey;

  let res: Awaited<ReturnType<LinkedinTransport>>;
  try {
    res = await transport(url, { headers, body });
  } catch (e) {
    return { kind: "transient", error: e instanceof Error ? e.message : String(e) };
  }

  const retryAfterMs = retryAfterFromHeaders(res.headers);
  if (res.status >= 400) {
    const { classification, correlationId } = envelopeStrings(res.json);
    const verdict = classifySourceError(
      { httpStatus: res.status, classification, retryAfterMs },
      classifierDefaults(),
    );
    const detail = errorDetail(res.status, classification, correlationId, retryAfterMs);
    switch (verdict.kind) {
      case "permanent":
        // request-scoped → the chain must stop; origin-scoped (AUTH/FORBIDDEN) → THIS origin's key is
        // bad, cool it long (operator has to act) and let the walk try the next mirror.
        return verdict.scope === "request"
          ? { kind: "rejected", httpStatus: res.status }
          : {
              kind: "cooled",
              error: detail,
              cooldownMs: env.ENRICH_ORIGIN_SEAT_DEAD_COOLDOWN_MS,
              throttled: false,
            };
      case "provider_miss":
        return { kind: "rejected", httpStatus: res.status };
      case "throttled":
        return { kind: "cooled", error: detail, cooldownMs: verdict.retryAfterMs, throttled: true };
      case "source_down":
        return { kind: "cooled", error: detail, cooldownMs: verdict.cooldownMs, throttled: false };
      case "transient":
        return { kind: "transient", error: detail };
    }
  }
  if (typeof res.json !== "object" || res.json === null) {
    return { kind: "transient", error: "non-json response" };
  }
  return unwrapEnvelope(res.json, retryAfterMs);
}

/**
 * The vendor answers 200 with an ENVELOPE — `{ success, data, meta }` — where `data` is the document and
 * `meta` is capture telemetry (captured_at, engine, counts). Everything downstream (the zod contracts, the
 * mapper, the content hash) is defined over the DOCUMENT, so the envelope is peeled off here, at the one
 * place that owns the vendor's wire format.
 *
 * This was a SILENT total failure before: the envelope has no `schema_version` at its root, so every
 * payload failed both payload schemas, `landLinkedinPayload` returned `shape_drift`, and `fetchAndLandUrl`
 * still stamped the registry `ok` — fetches "succeeded", nothing was ever stored, and the 30-day freshness
 * clock was burned on each URL.
 *
 * `success: false` WITHOUT a classification is the vendor's own refusal (unknown profile, unsupported
 * URL): a REJECTED request, not a sick origin — a different mirror would answer identically, so the chain
 * must stop rather than retry. WITH a classification, the classifier decides: a throttle/outage class
 * smuggled into a 200 envelope must cool-and-failover, never masquerade as "no such profile" (defensive —
 * the proxy documents these on 5xx/429, but a misbehaving mirror must not poison the registry). A bare
 * document (no envelope) is still accepted, so a vendor that drops the wrapper keeps working.
 */
export function unwrapEnvelope(json: object, retryAfterMs?: number): AttemptOutcome {
  const body = json as Record<string, unknown>;
  if ("success" in body) {
    if (body.success !== true) {
      const { classification, correlationId } = envelopeStrings(body);
      if (classification) {
        const verdict = classifySourceError(
          { httpStatus: 200, classification, retryAfterMs },
          classifierDefaults(),
        );
        const detail = errorDetail(200, classification, correlationId, retryAfterMs);
        switch (verdict.kind) {
          case "throttled":
            return {
              kind: "cooled",
              error: detail,
              cooldownMs: verdict.retryAfterMs,
              throttled: true,
            };
          case "source_down":
            return {
              kind: "cooled",
              error: detail,
              cooldownMs: verdict.cooldownMs,
              throttled: false,
            };
          case "transient":
            return { kind: "transient", error: detail };
          case "permanent":
            if (verdict.scope === "origin") {
              return {
                kind: "cooled",
                error: detail,
                cooldownMs: env.ENRICH_ORIGIN_SEAT_DEAD_COOLDOWN_MS,
                throttled: false,
              };
            }
            break; // request-scoped → rejected below
          case "provider_miss":
            break; // honest no-match → rejected below
        }
      }
      return { kind: "rejected", httpStatus: 200 };
    }
    const data = body.data;
    if (typeof data !== "object" || data === null) {
      return { kind: "transient", error: "envelope success without a data object" };
    }
    return { kind: "ok", payload: data };
  }
  return { kind: "ok", payload: body };
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
