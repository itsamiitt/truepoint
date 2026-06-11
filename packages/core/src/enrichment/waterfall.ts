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

export function orderProviders(
  providers: EnrichmentProvider[],
  req: EnrichRequest,
): EnrichmentProvider[] {
  return [...providers].sort((a, b) => {
    const scoreA = a.trust / Math.max(1, a.estimateCostMicros(req));
    const scoreB = b.trust / Math.max(1, b.estimateCostMicros(req));
    return scoreB - scoreA;
  });
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
    let result: ProviderResult;
    try {
      result = await provider.enrich(req);
    } catch {
      result = { fields: [], rawPayload: null, costMicros: 0, status: "error" };
    }
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
