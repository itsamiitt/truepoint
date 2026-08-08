// confidence.ts — PURE, IO-free confidence + freshness scoring. Sits beside fieldProvenance.ts and follows
// the same contract: same input → same output, no mutation of arguments, no DB. The caller loads policy rows
// (master_confidence_policy, migration 0107) and persists whatever it decides; this module only computes.
//
// 08-architecture states plainly that "Decay curves are Phase 2 — not built". This is that curve. Until it is
// wired, a five-year-old assertion and one verified this morning score identically, which undermines three
// outcomes at once: [S-09] has the person left the company · [S-10] confidence visible at a glance ·
// [S-13] fast job-change detection.
//
// ── THE MODEL, AND ONE DELIBERATE DEVIATION FROM THE PHASE-3 DESIGN ──────────────────────────────────────
// 03-target-architecture.md §4 wrote the model as THREE factors:
//     confidence = base(source_weight) × corroboration(source_count) × decay(age, half_life)
// Implemented as TWO, because the first two collapse into one principled function:
//     confidence = noisyOr(source_weight, source_count) × decay(age, half_life)
//
// Noisy-OR is the standard way to combine independent evidence for the same proposition: if one source of
// reliability w asserts X, the chance X is false is (1-w); if n INDEPENDENT sources assert it, the chance all
// of them are wrong together is (1-w)^n, so belief is 1-(1-w)^n. It is also exactly the philosophy
// `cascade 1.md` §2.4 names for contact attestations ("confidence grows with independent corroboration — the
// same Noisy-OR philosophy the propagation engine uses").
//
// Multiplying a separate hand-rolled corroboration curve on top would double-count corroboration and needs a
// second set of magic numbers to tune. Noisy-OR needs none: the "second source is worth far more than the
// tenth" property falls out of the algebra. With w=0.85: 1 source → 0.850, 2 → 0.978 (+0.128),
// 5 → 0.99999 (+0.00007 over the 4th). That IS the diminishing-returns shape the design asked for.
//
// The independence assumption is the honest caveat: two providers that both resold the same upstream feed are
// NOT independent, and noisy-OR will overstate them. `corroboration_ceiling` in the policy is the blunt
// defence — it caps how many sources may compound — and it is why the ceiling is per-policy rather than a
// constant. Real source-independence modelling is a much later problem; capping is the right amount of
// machinery for now.

/** One row of master_confidence_policy (0107), as loaded by the caller. */
export interface ConfidencePolicy {
  /** provenance_event.field, or "*" for any. */
  field: string;
  /** provenance_event.source_type, or "*" for any. */
  sourceType: string;
  /** NULL = does not decay (a funding round that happened stays happened). */
  halfLifeDays: number | null;
  /** Per-source reliability ∈ [0,1]. Active sources outrank passive ones. */
  sourceWeight: number;
  /** source_count at which corroboration stops compounding. */
  corroborationCeiling: number;
  /** Disabled rows are inert — treated as absent, so lookup falls through to the next precedence tier. */
  isEnabled: boolean;
}

export interface ScoreInput {
  /** Candidate policy rows. Order does not matter; precedence is resolved here. */
  policies: readonly ConfidencePolicy[];
  field: string;
  sourceType: string;
  /** Number of independent sources asserting this value (master_*.source_count). */
  sourceCount: number;
  /** VALID time — when the source says the fact held. NOT recorded_at: conflating them is what makes a
   *  late-arriving old fact look fresh. */
  observedAt: Date | null;
  /** Evaluation instant. Passed in rather than read from the clock so the function stays pure and testable. */
  asOf: Date;
}

export interface ScoreResult {
  /** Final score ∈ [0,1], or null when no policy applies (see `scoreConfidence`). */
  confidence: number | null;
  /** The evidence term, before decay. */
  evidence: number;
  /** The decay multiplier ∈ (0,1]. 1 when the fact does not decay or age is unknown. */
  decay: number;
  /** Age in days used for decay, or null when `observedAt` is unknown. */
  ageDays: number | null;
  /** The policy row that won precedence, or null. */
  policy: ConfidencePolicy | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Resolve the winning policy, MOST SPECIFIC FIRST:
 *   1. (field, sourceType)   2. ("*", sourceType)   3. (field, "*")   4. ("*", "*")
 *
 * Disabled rows are skipped at every tier rather than short-circuiting the search — that is what makes
 * `is_enabled` a safe rollout switch: turning one row off falls back to the next tier instead of dropping the
 * field out of scoring entirely.
 */
export function resolvePolicy(
  policies: readonly ConfidencePolicy[],
  field: string,
  sourceType: string,
): ConfidencePolicy | null {
  const find = (f: string, s: string): ConfidencePolicy | undefined =>
    policies.find((p) => p.isEnabled && p.field === f && p.sourceType === s);

  return (
    find(field, sourceType) ?? find("*", sourceType) ?? find(field, "*") ?? find("*", "*") ?? null
  );
}

/**
 * Exponential decay by half-life: after `halfLifeDays`, the multiplier is exactly 0.5.
 *
 * `2^(-age/halfLife)` rather than the equivalent `exp(-ln2 * age / halfLife)` — same curve, but the half-life
 * is legible in the expression, which matters for a number product managers will argue about.
 *
 * Returns 1 (no decay) when the half-life is null. NEGATIVE AGE IS CLAMPED TO ZERO: an observed_at in the
 * future is clock skew or a bad source, and without the clamp it would produce a multiplier ABOVE 1 and hand
 * out confidence greater than any source justified.
 */
export function decayFactor(ageDays: number, halfLifeDays: number | null): number {
  if (halfLifeDays === null || halfLifeDays <= 0) {
    return 1;
  }
  const age = Math.max(0, ageDays);
  return 2 ** (-age / halfLifeDays);
}

/**
 * Noisy-OR over `n` independent sources of reliability `weight`: 1 - (1-weight)^n.
 *
 * `n` is clamped to [1, ceiling]. The lower clamp matters: a stored row always represents at least one
 * assertion, so a `source_count` of 0 (or a negative from a bad backfill) must not score the value at zero
 * and silently bury a real fact.
 */
export function evidenceFactor(weight: number, sourceCount: number, ceiling: number): number {
  const w = Math.min(1, Math.max(0, weight));
  const n = Math.min(Math.max(1, Math.trunc(sourceCount)), Math.max(1, Math.trunc(ceiling)));
  return 1 - (1 - w) ** n;
}

/**
 * Score one field's confidence.
 *
 * Returns `confidence: null` when NO policy matches — deliberately, rather than defaulting to some number.
 * ("*","*") is seeded by 0107 so this should not happen in a migrated database; if it does, the honest answer
 * is "this system has no opinion", and the caller must leave the stored confidence untouched. Inventing a
 * default here would silently rescore every field in the graph off a fallback nobody chose.
 *
 * `observedAt: null` means the age is unknown, so decay is skipped (multiplier 1) rather than assumed. An
 * unknown age is not the same as a fresh one, but penalising it would punish sources that simply do not
 * report a timestamp — and `ageDays: null` in the result lets the caller surface that distinction.
 */
export function scoreConfidence(input: ScoreInput): ScoreResult {
  const policy = resolvePolicy(input.policies, input.field, input.sourceType);
  if (policy === null) {
    return { confidence: null, evidence: 0, decay: 1, ageDays: null, policy: null };
  }

  const evidence = evidenceFactor(
    policy.sourceWeight,
    input.sourceCount,
    policy.corroborationCeiling,
  );

  const ageDays =
    input.observedAt === null
      ? null
      : (input.asOf.getTime() - input.observedAt.getTime()) / MS_PER_DAY;

  const decay = ageDays === null ? 1 : decayFactor(ageDays, policy.halfLifeDays);

  return { confidence: evidence * decay, evidence, decay, ageDays, policy };
}

/**
 * Days until a value's confidence decays past `threshold`, given its current score — the reverification
 * scheduler's input, and the reason the whole curve is worth having: it turns "re-check everything every N
 * days" into "re-check this value when it is about to stop being trustworthy".
 *
 * Returns null when the value does not decay (it never crosses the threshold) or is already below it (it is
 * due now, and the caller should not be told to wait).
 */
export function daysUntilStale(current: ScoreResult, threshold: number): number | null {
  if (current.confidence === null || current.policy?.halfLifeDays == null) {
    return null;
  }
  if (current.confidence <= threshold || current.evidence <= threshold) {
    // Already stale, or so weakly evidenced that decay can never be the deciding factor.
    return null;
  }
  // Solve evidence * 2^(-t/H) = threshold  →  t = H * log2(evidence / threshold)
  const total = current.policy.halfLifeDays * Math.log2(current.evidence / threshold);
  const elapsed = current.ageDays ?? 0;
  return Math.max(0, total - elapsed);
}
