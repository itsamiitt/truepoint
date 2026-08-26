// sourceErrorClassifier.ts — the PURE error-classification table for data-source/provider responses
// (docs: https://expo.truepoint.in/docs §Errors & classifications). One function maps what a source
// actually said — (httpStatus, envelope `classification`, Retry-After, transport error) — onto what the
// caller must DO, so the origin chain, the vendor adapters, and the job layer all branch on the same
// taxonomy instead of re-deriving it from raw status codes (the crm-sync/reliability.ts posture: pure,
// injected inputs, deterministic).
//
// Verdicts:
//   permanent(request) — the REQUEST is bad (validation, malformed URL): no retry, no failover; fix input.
//   permanent(origin)  — THIS origin's credential/config is bad (401/403): skip the origin, try the next —
//                        a misconfigured key on one mirror says nothing about its siblings.
//   provider_miss      — an honest, well-formed "no match / not found": every mirror of the same upstream
//                        answers identically, so the chain stops and the answer stands.
//   throttled          — backpressure with a wait hint (429 / queue classes): cool the origin for
//                        retryAfterMs and fail over NOW; the provider is healthy, just busy.
//   transient          — a one-off upstream fault (502/504 class): worth ONE cheap same-origin retry
//                        (the proxy caches + single-flights, so the retry is nearly free), then fail over.
//   source_down        — the source declared itself out of service (POOL_DEAD, SHUTDOWN, dead seat pool):
//                        cool the origin for cooldownMs and fail over; no point re-asking sooner.

export type SourceErrorVerdict =
  | { kind: "permanent"; scope: "request" | "origin"; reason: string }
  | { kind: "provider_miss"; reason: string }
  | { kind: "throttled"; retryAfterMs: number; reason: string }
  | { kind: "transient"; reason: string }
  | { kind: "source_down"; cooldownMs: number; reason: string };

export interface SourceErrorInput {
  /** Undefined ⇒ the transport itself failed (timeout, DNS, abort) before any status arrived. */
  httpStatus?: number;
  /** The proxy envelope's `classification` string, when the body carried one. Wins over bare status. */
  classification?: string;
  /** Pre-parsed Retry-After (parseRetryAfterMs) — always honored over the class default. */
  retryAfterMs?: number;
  transportError?: string;
}

/** Per-class default waits, all overridable (the env knobs thread through here). */
export interface SourceClassifierDefaults {
  /** 429/queue classes with no Retry-After header. */
  throttleFallbackMs?: number;
  shutdownCooldownMs?: number;
  poolDeadCooldownMs?: number;
  /** LINKEDIN_SESSION_INVALID / NO_SESSION / ENGINE_UNAVAILABLE — an operator has to act. */
  seatDeadCooldownMs?: number;
}

const THROTTLE_FALLBACK_MS = 15_000;
const SHUTDOWN_COOLDOWN_MS = 30_000; // the doc's "retry ~30 s"
const POOL_DEAD_COOLDOWN_MS = 300_000; // the doc's Retry-After: 300
const SEAT_DEAD_COOLDOWN_MS = 600_000;

const PERMANENT_REQUEST = new Set(["VALIDATION", "LINKEDIN_VALIDATION", "LINKEDIN_BAD_URL"]);
const PROVIDER_MISS = new Set(["REQUEST_ERROR", "LINKEDIN_NOT_FOUND"]);
const PERMANENT_ORIGIN = new Set(["AUTH", "FORBIDDEN"]);
const THROTTLED = new Set([
  "CLIENT_RATE_LIMITED",
  "QUEUE_FULL",
  "QUEUE_TIMEOUT",
  "LINKEDIN_THROTTLED",
  "LINKEDIN_QUEUE_FULL",
]);
const TRANSIENT = new Set([
  "SERVER_ERROR",
  "UNKNOWN",
  "LINKEDIN_UPSTREAM",
  "LINKEDIN_CAPTURE_TIMEOUT",
]);
const SEAT_DEAD = new Set([
  "LINKEDIN_SESSION_INVALID",
  "LINKEDIN_NO_SESSION",
  "LINKEDIN_ENGINE_UNAVAILABLE",
]);

export function classifySourceError(
  input: SourceErrorInput,
  defaults: SourceClassifierDefaults = {},
): SourceErrorVerdict {
  const throttleFallbackMs = defaults.throttleFallbackMs ?? THROTTLE_FALLBACK_MS;
  const cls = input.classification?.trim().toUpperCase();
  const reason =
    cls ??
    (input.httpStatus !== undefined
      ? `http ${input.httpStatus}`
      : (input.transportError ?? "transport error"));

  if (cls) {
    if (PERMANENT_REQUEST.has(cls)) return { kind: "permanent", scope: "request", reason };
    if (PROVIDER_MISS.has(cls)) return { kind: "provider_miss", reason };
    if (PERMANENT_ORIGIN.has(cls)) return { kind: "permanent", scope: "origin", reason };
    if (THROTTLED.has(cls)) {
      return { kind: "throttled", retryAfterMs: input.retryAfterMs ?? throttleFallbackMs, reason };
    }
    if (TRANSIENT.has(cls)) return { kind: "transient", reason };
    if (SEAT_DEAD.has(cls)) {
      return {
        kind: "source_down",
        cooldownMs: defaults.seatDeadCooldownMs ?? SEAT_DEAD_COOLDOWN_MS,
        reason,
      };
    }
    if (cls === "POOL_DEAD") {
      return {
        kind: "source_down",
        cooldownMs: input.retryAfterMs ?? defaults.poolDeadCooldownMs ?? POOL_DEAD_COOLDOWN_MS,
        reason,
      };
    }
    if (cls === "SHUTDOWN") {
      return {
        kind: "source_down",
        cooldownMs: input.retryAfterMs ?? defaults.shutdownCooldownMs ?? SHUTDOWN_COOLDOWN_MS,
        reason,
      };
    }
    // Unknown classification string: fall through to the bare-status rules below — a proxy that grows a
    // new class must degrade to status semantics, never crash or silently stop a chain.
  }

  const status = input.httpStatus;
  if (status === undefined) return { kind: "transient", reason };
  if (status === 429) {
    return { kind: "throttled", retryAfterMs: input.retryAfterMs ?? throttleFallbackMs, reason };
  }
  if (status === 401 || status === 403) return { kind: "permanent", scope: "origin", reason };
  if (status >= 500) return { kind: "transient", reason };
  if (status >= 400) return { kind: "provider_miss", reason };
  // A 2xx/3xx reaching the classifier means the CALLER decided the response was unusable (e.g. an
  // envelope refusal with no classification) — treat as an honest miss, never a retry loop.
  return { kind: "provider_miss", reason };
}
