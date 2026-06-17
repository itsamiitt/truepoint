// waterfall.ts — the sequential provider waterfall (06 §4): order capable providers by
// trust ÷ estimated cost (expectedHitRate learning lands with real provider telemetry), call the next
// until one hits, skip providers whose circuit breaker is open, and count every miss/error against it.
// Breakers are per-process (a Redis-shared breaker is the M12 scale follow-up — 18 §9).

import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "./providerPort.ts";

const BREAKER_THRESHOLD = 3; // consecutive errors → open
const BREAKER_COOLDOWN_MS = 60_000; // half-open probe after cooldown

interface BreakerState {
  consecutiveErrors: number;
  openedAt: number | null;
}

const breakers = new Map<string, BreakerState>();

function breakerFor(name: string): BreakerState {
  let s = breakers.get(name);
  if (!s) {
    s = { consecutiveErrors: 0, openedAt: null };
    breakers.set(name, s);
  }
  return s;
}

export function breakerOpen(name: string, now = Date.now()): boolean {
  const s = breakerFor(name);
  if (s.openedAt === null) return false;
  if (now - s.openedAt >= BREAKER_COOLDOWN_MS) return false; // half-open: allow a probe
  return true;
}

export function recordOutcome(name: string, ok: boolean, now = Date.now()): void {
  const s = breakerFor(name);
  if (ok) {
    s.consecutiveErrors = 0;
    s.openedAt = null;
    return;
  }
  s.consecutiveErrors += 1;
  if (s.consecutiveErrors >= BREAKER_THRESHOLD) s.openedAt = now;
}

/** Test seam: reset all breaker state. */
export function resetBreakers(): void {
  breakers.clear();
}

/** The waterfall ordering score: trust ÷ estimated cost (06 §4), clamped so a sub-1µ cost can't blow up. */
function providerScore(provider: EnrichmentProvider, req: EnrichRequest): number {
  return provider.trust / Math.max(1, provider.estimateCostMicros(req));
}

export function orderProviders(
  providers: EnrichmentProvider[],
  req: EnrichRequest,
): EnrichmentProvider[] {
  return [...providers].sort((a, b) => providerScore(b, req) - providerScore(a, req));
}

export interface WaterfallOutcome {
  provider: string | null; // null = no provider hit
  result: ProviderResult | null;
  attempts: Array<{ provider: string; status: ProviderResult["status"]; costMicros: number }>;
}

/** Call providers in order until one hits; record attempts (each is persisted by the caller). */
export async function runWaterfall(
  providers: EnrichmentProvider[],
  req: EnrichRequest,
): Promise<WaterfallOutcome> {
  const attempts: WaterfallOutcome["attempts"] = [];
  for (const provider of orderProviders(providers, req)) {
    if (breakerOpen(provider.name)) continue;
    const result = await callProvider(provider, req);
    attempts.push({
      provider: provider.name,
      status: result.status,
      costMicros: result.costMicros,
    });
    recordOutcome(provider.name, result.status === "hit" || result.status === "miss");
    if (result.status === "hit") return { provider: provider.name, result, attempts };
  }
  return { provider: null, result: null, attempts };
}

/** One provider call, never throwing — a thrown adapter error becomes a zero-cost `error` status. */
async function callProvider(
  provider: EnrichmentProvider,
  req: EnrichRequest,
): Promise<ProviderResult> {
  try {
    return await provider.enrich(req);
  } catch {
    return { fields: [], rawPayload: null, costMicros: 0, status: "error" };
  }
}

/** Tuning knobs for the bulk / parallel-cheap waterfall (06 §4 allows parallel-cheap for low-cost providers). */
export interface BulkWaterfallOptions {
  /**
   * The cost ceiling (micros) below which a provider is "cheap" enough to fire in the parallel batch. Cheap
   * providers race together (latency win on the bulk residual); any provider above this is treated as
   * expensive and only runs sequentially AFTER the cheap batch misses, preserving cost discipline.
   */
  cheapCostThresholdMicros: number;
}

/**
 * Bulk / parallel-cheap waterfall (06 §4; 31 §4) for the bulk residual. Cheap providers (estimated cost
 * below the threshold) are called CONCURRENTLY and the best hit wins; if none of the cheap batch hits, the
 * remaining (expensive) providers run as the normal sequential waterfall. ADDITIVE — `runWaterfall` is
 * unchanged, so single-call behavior is untouched. Breakers + attempt accounting work identically: every
 * call is recorded for cost, open breakers are skipped, and a thrown adapter error is a zero-cost `error`.
 */
export async function runWaterfallBulk(
  providers: EnrichmentProvider[],
  req: EnrichRequest,
  options: BulkWaterfallOptions,
): Promise<WaterfallOutcome> {
  // Partition in ONE pass — estimateCostMicros is evaluated once per provider (it may be non-trivial), and
  // open breakers are dropped up front. cheap = below the threshold (race in parallel); the rest run last.
  const cheap: EnrichmentProvider[] = [];
  const expensive: EnrichmentProvider[] = [];
  for (const provider of orderProviders(providers, req)) {
    if (breakerOpen(provider.name)) continue;
    if (provider.estimateCostMicros(req) < options.cheapCostThresholdMicros) cheap.push(provider);
    else expensive.push(provider);
  }

  const attempts: WaterfallOutcome["attempts"] = [];

  // 1) Race the cheap batch in parallel; record every attempt; pick the best hit by trust ÷ cost (same
  //    score as orderProviders, so the bulk path doesn't prefer a costlier hit over a cheaper equal-trust one).
  if (cheap.length > 0) {
    const results = await Promise.all(
      cheap.map(async (provider) => ({ provider, result: await callProvider(provider, req) })),
    );
    for (const { provider, result } of results) {
      attempts.push({
        provider: provider.name,
        status: result.status,
        costMicros: result.costMicros,
      });
      recordOutcome(provider.name, result.status === "hit" || result.status === "miss");
    }
    let best: { provider: EnrichmentProvider; result: ProviderResult } | null = null;
    for (const candidate of results) {
      if (candidate.result.status !== "hit") continue;
      if (
        best === null ||
        providerScore(candidate.provider, req) > providerScore(best.provider, req)
      ) {
        best = candidate;
      }
    }
    if (best) return { provider: best.provider.name, result: best.result, attempts };
  }

  // 2) No cheap hit → fall through to the expensive providers sequentially (cost-disciplined, first hit wins).
  for (const provider of expensive) {
    const result = await callProvider(provider, req);
    attempts.push({
      provider: provider.name,
      status: result.status,
      costMicros: result.costMicros,
    });
    recordOutcome(provider.name, result.status === "hit" || result.status === "miss");
    if (result.status === "hit") return { provider: provider.name, result, attempts };
  }

  return { provider: null, result: null, attempts };
}
