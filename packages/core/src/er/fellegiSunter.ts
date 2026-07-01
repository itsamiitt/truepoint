// fellegiSunter.ts — the pure probabilistic record-match scorer (Fellegi-Sunter; 03 §5.1:478) for I5 probabilistic
// ER (prospect-database-platform / audit P02, A10). Given a COMPARISON VECTOR (the per-field agreement outcome for
// a candidate record pair) plus the model's m/u probabilities per field, it sums the per-field match weights into a
// total (in bits), converts that to a posterior match probability, and classifies the pair into a review
// DISPOSITION by two thresholds. PURE: no DB, no I/O, no randomness — just the math. The candidate generator
// (blocking) that produces the pairs, and the SHADOW writer that persists match_links(review_status='pending')
// behind a default-OFF flag, are later slices. This module NEVER decides to merge — it only scores.
//
// Fellegi-Sunter, per field: weight(agree) = log2(m/u); weight(disagree) = log2((1-m)/(1-u)); a field that could
// not be compared (a null on either side) contributes 0 (no evidence). m = P(fields agree | the pair is a match),
// u = P(fields agree | the pair is NOT a match). The total match weight is the prior log2-odds plus the per-field
// weights; the posterior odds are 2^weight and the probability is odds/(1+odds).

/** The outcome of comparing one field between the two records. `not_compared` = a null/absent value on either side. */
export type FieldComparison = "agree" | "disagree" | "not_compared";

/** Trained parameters for one field. m = P(agree | match), u = P(agree | non-match); both strictly in (0,1). */
export interface FieldWeights {
  m: number;
  u: number;
}

/** One field's comparison outcome paired with its model weights (the caller supplies both). */
export interface FieldObservation {
  field: string;
  comparison: FieldComparison;
  weights: FieldWeights;
}

/** The statistical disposition of a candidate pair. NOTE: `auto_match` is a SCORE class, not an instruction —
 *  the shadow writer (I5, later) NEVER auto-merges; it routes even auto_match pairs to human review. */
export type MatchDisposition = "auto_match" | "pending_review" | "no_match";

export interface FellegiSunterConfig {
  /** Prior log2-odds of a match among CANDIDATE pairs (post-blocking). Negative — most candidate pairs are non-matches. */
  priorLog2Odds: number;
  /** Posterior probability at/above which a pair scores as auto_match (still human-gated in shadow mode). */
  autoMatchThreshold: number;
  /** Posterior probability at/above which a pair is queued for clerical review (below autoMatchThreshold). */
  reviewThreshold: number;
}

export interface FellegiSunterResult {
  /** Total match weight in bits = priorLog2Odds + Σ per-field weights. */
  matchWeightBits: number;
  /** Posterior match probability ∈ [0, 1]. */
  probability: number;
  disposition: MatchDisposition;
}

/**
 * A conservative placeholder config (03 §5.1; calibrate on a labelled set — roadmap I5 test). The prior assumes
 * ~1 true match per ~90 candidate pairs after blocking (log2(1/90) ≈ −6.5). Thresholds are deliberately cautious:
 * auto_match only at ≥0.95 posterior, review from 0.80 — the tail between them is exactly what a human sees.
 */
export const DEFAULT_FELLEGI_SUNTER_CONFIG: FellegiSunterConfig = {
  priorLog2Odds: -6.5,
  autoMatchThreshold: 0.95,
  reviewThreshold: 0.8,
};

/** Per-field weight in bits. `not_compared` yields 0 (no evidence either way). */
function fieldWeightBits(o: FieldObservation): number {
  const { m, u } = o.weights;
  if (o.comparison === "agree") return Math.log2(m / u);
  if (o.comparison === "disagree") return Math.log2((1 - m) / (1 - u));
  return 0;
}

/** Convert a match weight in bits to a posterior probability, clamped and overflow-safe. */
function weightToProbability(weightBits: number): number {
  // 2^60 already saturates a double's useful range for this purpose; clamp to avoid Infinity/NaN.
  if (weightBits >= 60) return 1;
  if (weightBits <= -60) return 0;
  const odds = 2 ** weightBits;
  return odds / (1 + odds);
}

/**
 * Score a candidate pair from its per-field comparison observations. Returns the total match weight, the posterior
 * probability, and the disposition (auto_match ≥ autoMatchThreshold; pending_review ≥ reviewThreshold; else
 * no_match). Pure + deterministic.
 */
export function scoreFellegiSunter(
  observations: FieldObservation[],
  config: FellegiSunterConfig = DEFAULT_FELLEGI_SUNTER_CONFIG,
): FellegiSunterResult {
  const matchWeightBits = observations.reduce(
    (sum, o) => sum + fieldWeightBits(o),
    config.priorLog2Odds,
  );
  const probability = weightToProbability(matchWeightBits);
  const disposition: MatchDisposition =
    probability >= config.autoMatchThreshold
      ? "auto_match"
      : probability >= config.reviewThreshold
        ? "pending_review"
        : "no_match";
  return { matchWeightBits, probability, disposition };
}
