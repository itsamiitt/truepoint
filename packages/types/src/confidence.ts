// confidence.ts — PER-FIELD confidence (07 §Quality control; 06-roadmap Phase 2 "per-field decay curves").
// Pure, leaf-package, so every layer reuses one implementation: the badge, the re-verify priority queue, and
// (Phase 2) the bounce-rate-by-confidence chart 06 calls "the product's proof".
//
// ⚠ THIS IS THE LIVE CONFIDENCE ENGINE — the numbers below are the ones customers see, via
// buildConfidenceBadgeV1 (revealContact.ts, the account-intelligence provenance route). There is a SECOND,
// more capable model in packages/core/src/prospect/confidence.ts: Noisy-OR corroboration parameterised per
// (field, source_type) from master_confidence_policy, so staff can tune it without a deploy. It has zero
// production consumers. This file's half-lives are hardcoded (FIELD_HALF_LIFE_DAYS) and its corroboration is
// capped at 1.25×, so the two disagree by 0.09–0.17 on the same fact. Do not "unify" them casually — the
// swap re-scores every displayed record. Audit 32 §9D states the decision.
//
// NOT THE SAME THING AS dataHealth.ts, and conflating them is the easy mistake:
//   dataHealth   = RECORD-level data_quality_score — completeness + verification + freshness, 0-100, answers
//                  "how complete and current is this record".
//   this file    = FIELD-level confidence ∈ [0,1] — answers "how much do we believe THIS value right now".
// A record can be 90/100 complete while its jobTitle is barely believable, and the badge and the decay engine
// both need the second number. dataHealth's freshness is a LINEAR ramp against one SLA; this is exponential
// against a per-field half-life, which is what 07 actually specifies.
//
// SHAPE OF THE MODEL (07: "prior from source type, updated by events, decayed by per-field half-lives"):
//   confidence = prior(sourceType, method) · decay(age, halfLife(field)) · corroboration(distinctSources)
// Deliberately multiplicative, not additive. An old value from a strong source and a fresh value from a weak
// one should BOTH be mediocre; addition lets one term paper over the other, which is how a year-old
// SMTP-verified email ends up looking as trustworthy as one verified this morning.

/**
 * Per-field half-life in days: how long until we believe a value HALF as much, absent any fresh evidence.
 *
 * These encode churn rate, not importance. Job title and employment decay fastest because people change roles
 * constantly — which is outcome S-09, the second-highest-scoring outcome on the board. Firmographics decay
 * slowly because a company's industry and headcount band rarely move. `name` barely decays at all: people
 * change employers far more often than they change their name.
 */
export const FIELD_HALF_LIFE_DAYS = {
  jobTitle: 180,
  seniorityLevel: 180,
  department: 240,
  employment: 180,
  email: 270,
  phone: 365,
  locationCity: 365,
  locationCountry: 730,
  firmographics: 540,
  name: 1825,
} as const;
export type ConfidenceField = keyof typeof FIELD_HALF_LIFE_DAYS;

/** Fields with no explicit half-life fall back to this — the email half-life, the dominant decaying field. */
export const DEFAULT_HALF_LIFE_DAYS = FIELD_HALF_LIFE_DAYS.email;

/**
 * Prior confidence by how the value was obtained, before any decay (07: "SMTP-verified beats
 * pattern-inferred"). These are the METHOD priors — how the value was established — because method
 * discriminates far better than vendor does.
 *
 * pattern_inferred sits deliberately low: 07 requires inferred email formats be "marked as inferred-low-
 * confidence until corroborated", and a guessed address that looks confident is exactly what produces the
 * first-contact bounces S-08 exists to prevent.
 */
export const METHOD_PRIOR = {
  smtp_verify: 0.95,
  carrier_lookup: 0.95,
  user_confirm: 0.9,
  deterministic: 0.85,
  provider: 0.75,
  crawl: 0.6,
  fuzzy: 0.55,
  pattern_inferred: 0.35,
} as const;
export type ConfidenceMethod = keyof typeof METHOD_PRIOR;

/** An unrecognised method is treated as a provider-grade assertion — the middle of the range, never the top. */
export const DEFAULT_METHOD_PRIOR = METHOD_PRIOR.provider;

export interface FieldConfidenceInput {
  /** The field being scored. Unknown fields use DEFAULT_HALF_LIFE_DAYS. */
  field: string;
  /** How the value was established. Unknown methods use DEFAULT_METHOD_PRIOR. */
  method?: string | null;
  /** Whole days since the value was last OBSERVED (valid time), not since we recorded it. Null = never
   *  observed, which is cold-start rather than stale. */
  ageDays?: number | null;
  /** Distinct independent source CHANNELS that asserted this value — provenance_event's sourceDiversity, not
   *  its raw event count. Ten assertions from one importer is one source. */
  distinctSources?: number;
  /** True when a human pinned the value. A pin is an assertion by the person who owns the consequence. */
  pinned?: boolean;
}

/** Exponential decay factor ∈ (0,1]: 1 at age 0, 0.5 at one half-life, 0.25 at two. */
export function decayFactor(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1;
  return 2 ** (-Math.max(0, ageDays) / halfLifeDays);
}

/**
 * Corroboration multiplier ∈ [1, 1.25] with DIMINISHING returns: the second independent source is worth far
 * more than the tenth. Capped so corroboration can lift a mediocre value but never manufacture certainty —
 * a hundred crawls of the same stale page are still a stale page, which is the failure mode a linear boost
 * would walk straight into.
 */
export function corroborationBoost(distinctSources: number): number {
  const n = Math.max(0, Math.floor(distinctSources));
  if (n <= 1) return 1;
  return 1 + Math.min(0.25, 0.25 * (1 - 1 / Math.log2(n + 1)));
}

/**
 * Confidence in one field's current value, ∈ [0,1].
 *
 * COLD START: a value we have never observed a date for returns the undecayed prior rather than 0. "We do not
 * know when this was true" is not "this is false" — treating it as false would make every legacy record
 * look fabricated the day this ships.
 *
 * A PIN IS NOT CERTAINTY, but it is the strongest signal available: a human corrected this and owns the
 * outcome. It floors the result rather than replacing it, so a pinned value that is now three years old still
 * decays — because the human was right in 2023, not necessarily today.
 */
export function computeFieldConfidence(input: FieldConfidenceInput): number {
  const halfLife = FIELD_HALF_LIFE_DAYS[input.field as ConfidenceField] ?? DEFAULT_HALF_LIFE_DAYS;
  const prior = METHOD_PRIOR[input.method as ConfidenceMethod] ?? DEFAULT_METHOD_PRIOR;
  const decay = input.ageDays == null ? 1 : decayFactor(input.ageDays, halfLife);
  const boost = corroborationBoost(input.distinctSources ?? 1);

  const raw = prior * decay * boost;
  const floored = input.pinned ? Math.max(raw, METHOD_PRIOR.user_confirm * decay) : raw;
  return Math.min(1, Math.max(0, floored));
}

/** Coarse bands for display — the badge shows a word, not a decimal. Thresholds match the freshness bands in
 *  dataHealth.ts so the two surfaces never disagree about the same record. */
export type ConfidenceBand = "high" | "medium" | "low" | "unverified";

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  if (confidence >= 0.25) return "low";
  return "unverified";
}
