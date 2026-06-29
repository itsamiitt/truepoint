// providerConfigs.ts — the platform-admin provider-config contract (13 §3.6). The MASKED view sent to the
// staff console (NEVER a provider secret) + the enable/budget mutation bodies. Single source of truth shared
// by apps/api (validates) and apps/admin (derives its view type). Provider keys live in env/KMS, never here.

import { z } from "zod";

export const providerHealth = z.enum(["healthy", "degraded", "down", "unknown"]);
export type ProviderHealth = z.infer<typeof providerHealth>;

/**
 * Recent call-STATUS counts for ONE provider over a bounded window — the raw input to
 * {@link deriveProviderHealth}. Sourced from `provider_calls.status` only (never response_payload, so no
 * PII/secrets): `hit` = served from cache (provider NOT contacted); `miss` = live call SUCCEEDED;
 * `rateLimited` = provider throttled us; `error` = call failed.
 */
export interface ProviderCallStatusCounts {
  hit: number;
  miss: number;
  rateLimited: number;
  error: number;
}

/**
 * PASSIVE provider health, derived PURELY from recent call-STATUS history — no live probe, no secret read.
 *
 * Only *live* calls reflect provider liveness, so cache hits are EXCLUDED from the denominator:
 *   liveCalls = miss + rateLimited + error.
 *
 * Thresholds (evaluated over the caller's window — 24h in the admin console):
 *   - liveCalls === 0                          → "unknown"  (no live activity to judge — honest, not green)
 *   - errorRate (error / liveCalls) >= 0.5     → "down"     (failing the majority of live calls)
 *   - (error + rateLimited) / liveCalls >= 0.2 → "degraded" (a meaningful failure/throttle rate)
 *   - otherwise                                → "healthy"
 */
export function deriveProviderHealth(counts: ProviderCallStatusCounts): ProviderHealth {
  const liveCalls = counts.miss + counts.rateLimited + counts.error;
  if (liveCalls === 0) return "unknown";
  const errorRate = counts.error / liveCalls;
  if (errorRate >= 0.5) return "down";
  if ((counts.error + counts.rateLimited) / liveCalls >= 0.2) return "degraded";
  return "healthy";
}

/** The masked provider row shown in the staff console. `keyHint` is a non-reversible indicator, never the secret. */
export const providerConfigViewSchema = z.object({
  provider: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  keyHint: z.string().nullable(),
  rateLimitPerMin: z.number().int().nullable(),
  monthlyBudgetCents: z.number().int().nullable(),
  monthToDateCents: z.number().int().nullable(),
  health: providerHealth,
});
export type ProviderConfigView = z.infer<typeof providerConfigViewSchema>;

export const providerEnabledToggleSchema = z.object({ enabled: z.boolean() });
export type ProviderEnabledToggle = z.infer<typeof providerEnabledToggleSchema>;

// Monthly cost budget in cents — non-negative and capped to a sane ceiling ($1M/mo) so a fat-finger can't
// set an absurd budget.
export const providerBudgetSchema = z.object({
  monthly_budget_cents: z.number().int().nonnegative().max(100_000_000),
});
export type ProviderBudget = z.infer<typeof providerBudgetSchema>;
