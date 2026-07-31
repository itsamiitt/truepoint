// badgeV1.ts — PURE assembly of confidence badge v1 (06-roadmap Phase 2: "score + recency + corroboration
// count, shown in app, extension, and exports"; outcome S-10).
//
// v0 showed recency and a source count. v1 adds the SCORE, which is the number 09 §Customer-facing trust
// actually asks a buyer to rely on ("verified <n> days ago via <k> independent signals") and the axis the
// Phase 2 bounce-rate-by-confidence chart plots — 06 calls that chart "the product's proof".
//
// Takes the provenance aggregate and returns a badge. No IO, no DB types, so the API, the extension bridge
// and the exporter all produce identical numbers from identical inputs — a badge that disagrees with itself
// across surfaces is worse than no badge, because the user cannot tell which one is lying.

import {
  METHOD_PRIOR,
  type ConfidenceBand,
  computeFieldConfidence,
  confidenceBand,
} from "@leadwolf/types";

export interface BadgeAggregate {
  /** Distinct source CHANNELS that asserted something — NOT the raw event count. */
  sourceDiversity: number;
  /** Most recent VALID time any source vouched for the entity. */
  lastObservedAt: Date | null;
  /** Distinct methods seen across those assertions. */
  methods: string[];
}

export interface ConfidenceBadgeV1 {
  /** ISO of the last verification, or null when never verified. */
  lastVerifiedAt: string | null;
  /** Whole days since that, or null. */
  ageDays: number | null;
  /** Independent corroborating channels. */
  sourceCount: number;
  /** Field confidence ∈ [0,1]. */
  confidence: number;
  /** The word the UI shows — a badge renders a band, not a decimal. */
  band: ConfidenceBand;
  /** The method the score was priced off, so a support answer to "why is this low" is one field away. */
  strongestMethod: string | null;
}

/**
 * Pick the method with the highest prior.
 *
 * Ranking lives HERE rather than in SQL on purpose: METHOD_PRIOR is the single policy statement about which
 * evidence is stronger, and a `max()` in a query would silently fork that ordering the first time a method is
 * added. An unrecognised method is ignored for ranking (it still counts as corroboration) so a typo cannot
 * promote itself to the top of the ladder.
 */
export function strongestMethod(methods: readonly string[]): string | null {
  let best: string | null = null;
  let bestPrior = -1;
  for (const m of methods) {
    const prior = METHOD_PRIOR[m as keyof typeof METHOD_PRIOR];
    if (prior !== undefined && prior > bestPrior) {
      bestPrior = prior;
      best = m;
    }
  }
  return best;
}

/** Whole days between two instants, floored, never negative. */
function daysSince(then: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

/**
 * Assemble badge v1 for one field of one entity.
 *
 * `now` is injected rather than read from the clock so the result is a pure function of its inputs — the
 * badge is asserted in tests and rendered in three surfaces, and a hidden `Date.now()` makes both of those
 * quietly non-deterministic.
 *
 * Returns null when there is NO evidence at all, mirroring provenanceBadgeRepository.badgeFor: "we hold no
 * evidence log for this record" is not "nothing vouched for it", and until the provenance gate is on that is
 * true of every record. Rendering a confident-looking zero across the whole database would be worse than
 * showing nothing.
 */
export function buildConfidenceBadgeV1(
  field: string,
  agg: BadgeAggregate | null,
  now: Date = new Date(),
): ConfidenceBadgeV1 | null {
  if (!agg || agg.sourceDiversity <= 0) return null;

  const ageDays = agg.lastObservedAt ? daysSince(agg.lastObservedAt, now) : null;
  const method = strongestMethod(agg.methods);
  const confidence = computeFieldConfidence({
    field,
    method,
    ageDays,
    distinctSources: agg.sourceDiversity,
  });

  return {
    lastVerifiedAt: agg.lastObservedAt ? agg.lastObservedAt.toISOString() : null,
    ageDays,
    sourceCount: agg.sourceDiversity,
    confidence,
    band: confidenceBand(confidence),
    strongestMethod: method,
  };
}
