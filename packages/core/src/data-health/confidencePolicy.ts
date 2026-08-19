// confidencePolicy.ts — the gated, cached bridge between master_confidence_policy and the badge
// (C9 resolution, decisions.md 2026-08-19, D-2: shipped leaf function + table-sourced constants,
// display-only first).
//
// Three properties, in priority order:
//   1. DARK BY DEFAULT — CONFIDENCE_POLICY_BADGE_ENABLED off ⇒ returns undefined ⇒ every caller passes
//      undefined ⇒ computeFieldConfidence uses its hardcoded constants, byte-identical to before.
//   2. NEVER FAILS A CALLER — the badge decorates a paid reveal; a policy read that throws returns
//      undefined (hardcoded constants), same posture as revealContact's badge try/catch.
//   3. CHEAP — one withErTx read per process per TTL window, not per badge. Policy tuning is an UPDATE
//      that takes effect within the TTL, not a deploy; the schema's own promise.

import { env } from "@leadwolf/config";
import { masterConfidencePolicyRepository, withErTx } from "@leadwolf/db";
import type { ConfidenceHalfLifePolicy } from "@leadwolf/types";

const POLICY_CACHE_TTL_MS = 5 * 60_000;

let cached: { value: ConfidenceHalfLifePolicy; loadedAt: number } | null = null;

/** Test seam: drop the cache so the next call re-reads. */
export function resetConfidencePolicyCache(): void {
  cached = null;
}

/**
 * The badge's half-life policy, or undefined when the gate is off or the read failed — undefined always
 * means "use the shipped hardcoded constants".
 */
export async function badgeHalfLifePolicy(): Promise<ConfidenceHalfLifePolicy | undefined> {
  if (!env.CONFIDENCE_POLICY_BADGE_ENABLED) return undefined;
  const nowMs = Date.now();
  if (cached && nowMs - cached.loadedAt < POLICY_CACHE_TTL_MS) return cached.value;
  try {
    const value = await withErTx((tx) => masterConfidencePolicyRepository.loadBadgeHalfLives(tx));
    cached = { value, loadedAt: nowMs };
    return value;
  } catch (err) {
    console.warn("[confidence] policy load failed; using hardcoded constants", err);
    return undefined;
  }
}
