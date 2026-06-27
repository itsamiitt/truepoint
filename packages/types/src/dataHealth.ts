// dataHealth.ts — the data-quality & freshness keystone (22 §2–§3, ADR-0025; list-plan/06 §3.3). Pure,
// set-/row-reusable scoring: the 0–100 data_quality_score composite (0.4·completeness + 0.3·verification +
// 0.3·freshness) with the cold-start re-weighting (§2.2), the per-entity completeness weights (§2.3), the
// verification sub-score from email_status/phone_status, and the freshness SLAs + freshness_status bands +
// continuous decay (§3). This is the math everything downstream references — re-verify priority (§4), the
// list-detail Data Health column (list-plan/06 §3.3), the badge — so it lives in the LEAF types package,
// pure, so every layer can reuse it without forking: @leadwolf/db (the masked list-member projection),
// @leadwolf/core (re-exported from data-health/dataQualityScore.ts), and the web Data Health column.
//
// CORRECTNESS ≠ LEAD QUALITY (22 §1): this measures FIELD correctness/currency, never prospect quality (the
// lead score, ADR-0008). Never conflate. PURE: present-flags + field statuses + a last-verified age only — no
// PII, so it is safe to compute on the masked DTO.

import type { FreshnessStatus } from "./intel.ts";

// ── Freshness (§3) ───────────────────────────────────────────────────────────────────────────────────────
/** Per-field re-verify SLAs in days (22 §3). The record-level freshness proxy uses the email SLA (email is the
 *  dominant, most-decaying field); per-field freshness uses the matching SLA. */
export const FRESHNESS_SLA_DAYS = {
  email: 90,
  phone: 180,
  employment: 60,
  firmographics: 180,
  intent: 30,
} as const;
export type FreshnessField = keyof typeof FRESHNESS_SLA_DAYS;

/** Cold-start freshness sub-score (§2.2): with no last_verified_at / as-of date, a record starts in the
 *  "aging" band (a conservative mid-band) rather than masquerading as fresh. 0.5 is the aging-band midpoint
 *  of the decay curve below. */
export const COLD_START_FRESHNESS = 0.5;

/** freshness_status from the age/SLA ratio (22 §3): <0.5 fresh · <1.0 aging · <1.5 stale · else expired. */
export function freshnessStatusFor(ageDays: number, slaDays: number): FreshnessStatus {
  const ratio = ageDays / slaDays;
  if (ratio < 0.5) return "fresh";
  if (ratio < 1.0) return "aging";
  if (ratio < 1.5) return "stale";
  return "expired";
}

/** Continuous freshness sub-score ∈ [0,1] (§3 "decays continuously"): 1 at age 0, linearly to 0 by 1.5×SLA
 *  (the expired threshold), so quality degrades gracefully rather than at a cliff. */
export function freshnessSubScore(ageDays: number, slaDays: number): number {
  const ratio = ageDays / slaDays;
  return clamp01(1 - ratio / 1.5);
}

/** The re-verify cutoff timestamp (22 §3/§4, ADR-0025): a record whose `last_verified_at` is older than this
 *  (or null) has reached its freshness SLA and is due for re-verification. Defaults to the email SLA — the
 *  dominant, most-decaying field the record-level freshness proxy uses (see `computeContactDataQuality`). Pure. */
export function reverifyCutoff(now: Date = new Date(), slaDays: number = FRESHNESS_SLA_DAYS.email): Date {
  return new Date(now.getTime() - slaDays * 86_400_000);
}

// ── Verification (§2.3) ──────────────────────────────────────────────────────────────────────────────────
/** Verification sub-score for one field status (handles BOTH the email_status and phone_status closed sets,
 *  since both feed the mean): a confirmed-good verdict = 1 (email `valid`; phone `valid`/`direct`/`mobile`/`hq`
 *  line types — a resolved reachable line is verified data); `catch_all`/`unknown` = 0.5; `invalid` = 0.
 *  Returns `null` for an UNVERIFIED/absent status (§2.2 cold start) so it is EXCLUDED from the mean, not
 *  penalized as 0. Phone line types are graded here so a verified mobile/direct number is credited, not dropped. */
export function verificationSubScore(status: string | null | undefined): number | null {
  switch (status) {
    case "valid":
    case "direct": // phone line types: a resolved, reachable line is confirmed-good data (ADR-0013 set)
    case "mobile":
    case "hq":
      return 1;
    case "catch_all":
    case "unknown":
      return 0.5;
    case "invalid":
      return 0;
    default:
      return null; // unverified / risky / absent → excluded from the sub-score
  }
}

/** Mean of the present field statuses (§2.3); `null` when no field carries a real status yet (cold start). */
export function verificationMean(statuses: Array<string | null | undefined>): number | null {
  const scored = statuses.map(verificationSubScore).filter((s): s is number => s !== null);
  if (scored.length === 0) return null;
  return scored.reduce((a, b) => a + b, 0) / scored.length;
}

// ── Completeness (§2.3) ──────────────────────────────────────────────────────────────────────────────────
/** One expected field's weight + whether it is present-and-valid (a present-but-invalid field earns nothing). */
export interface CompletenessField {
  weight: number;
  present: boolean;
}

/** Weighted share of expected fields present-and-valid ∈ [0,1] (§2.3). */
export function completenessSubScore(fields: CompletenessField[]): number {
  const total = fields.reduce((s, f) => s + f.weight, 0);
  if (total === 0) return 0;
  const got = fields.reduce((s, f) => s + (f.present ? f.weight : 0), 0);
  return clamp01(got / total);
}

/** The default expected-field completeness weights per entity type (§2.3; sum to 1.0 each). */
export const COMPLETENESS_WEIGHTS = {
  contact: {
    name: 0.1,
    email: 0.3,
    phone: 0.2,
    title: 0.1,
    company: 0.1,
    location: 0.1,
    linkedin: 0.1,
  },
  account: {
    name: 0.1,
    domain: 0.3,
    industry: 0.15,
    size: 0.15,
    location: 0.15,
    linkedin: 0.15,
  },
} as const;

// ── Composite (§2 + cold-start §2.2) ─────────────────────────────────────────────────────────────────────
export interface QualitySubScores {
  /** [0,1] — always present (needs no verification). */
  completeness: number;
  /** [0,1] or null → cold start: re-weighted out (§2.2), not penalized. */
  verification: number | null;
  /** [0,1] — always present (cold start uses the aging-band value, not null). */
  freshness: number;
}

/**
 * The 0–100 data_quality_score (§2): round(100 × (0.4·completeness + 0.3·verification + 0.3·freshness)). When
 * verification is null (cold start, §2.2) it is re-weighted OUT: round(100 × (0.4·c + 0.3·f) / 0.7) — an
 * unverified import is not punished for a check that has not run. Inputs are clamped to [0,1].
 */
export function dataQualityScore(sub: QualitySubScores): number {
  const completeness = clamp01(sub.completeness);
  const freshness = clamp01(sub.freshness);
  if (sub.verification === null) {
    return Math.round((100 * (0.4 * completeness + 0.3 * freshness)) / 0.7);
  }
  const verification = clamp01(sub.verification);
  return Math.round(100 * (0.4 * completeness + 0.3 * verification + 0.3 * freshness));
}

// ── Contact convenience composer ─────────────────────────────────────────────────────────────────────────
/** The non-PII signals needed to score a contact's data quality (present-flags, statuses, last-verified age). */
export interface ContactQualityInput {
  hasName: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  hasTitle: boolean;
  hasCompany: boolean;
  hasLocation: boolean;
  hasLinkedin: boolean;
  emailStatus?: string | null;
  phoneStatus?: string | null;
  /** Days since the record was last verified; null = never verified (cold start → aging). */
  ageDaysSinceVerified: number | null;
}

export interface ContactQualityResult {
  score: number;
  freshnessStatus: FreshnessStatus;
}

/**
 * Score one contact's data quality (§2) + derive its freshness_status (§3). Freshness uses the email SLA (the
 * dominant field); a never-verified record is cold-start "aging" (§2.2). All inputs are non-PII present-flags +
 * field statuses, so this is safe to compute on the masked DTO.
 */
export function computeContactDataQuality(input: ContactQualityInput): ContactQualityResult {
  const w = COMPLETENESS_WEIGHTS.contact;
  const completeness = completenessSubScore([
    { weight: w.name, present: input.hasName },
    { weight: w.email, present: input.hasEmail },
    { weight: w.phone, present: input.hasPhone },
    { weight: w.title, present: input.hasTitle },
    { weight: w.company, present: input.hasCompany },
    { weight: w.location, present: input.hasLocation },
    { weight: w.linkedin, present: input.hasLinkedin },
  ]);
  const verification = verificationMean([input.emailStatus, input.phoneStatus]);
  const sla = FRESHNESS_SLA_DAYS.email;
  const age = input.ageDaysSinceVerified;
  const freshness = age === null ? COLD_START_FRESHNESS : freshnessSubScore(age, sla);
  const status: FreshnessStatus = age === null ? "aging" : freshnessStatusFor(age, sla);
  return {
    score: dataQualityScore({ completeness, verification, freshness }),
    freshnessStatus: status,
  };
}

/** Whole-days elapsed since an ISO last-verified timestamp, as `computeContactDataQuality` consumes it.
 *  Returns null for a never-verified record (cold start → aging). Floors to whole days; never negative. */
export function ageDaysSince(
  lastVerifiedAtIso: string | null | undefined,
  now = new Date(),
): number | null {
  if (!lastVerifiedAtIso) return null;
  const then = new Date(lastVerifiedAtIso);
  if (Number.isNaN(then.getTime())) return null;
  const ms = now.getTime() - then.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
