// jobChange.ts — PURE job-change detection (06-roadmap Phase 4 "decay engine + job-change detection";
// outcomes S-09 "minimize likelihood a record's person has left the company", S-13 "fast detection of job
// changes on saved contacts", S-14 "fast replacement with the role successor").
//
// S-09 and S-13 sit second and fifth on the opportunity board, and 04's own reading is that the whole top of
// that board is one theme: freshness and decay. This is the decision at the centre of it — given what we
// believed about someone's employment and what a source now claims, has this person moved?
//
// PURE on purpose. The hard part is not reading the database, it is the JUDGEMENT: a single stale crawl must
// not be allowed to mark a live contact as departed, and three independent confirmations must not be ignored
// because the old record happened to come from a paid provider. 07 states the rule outright — "a departure
// correction corroborated by 3 users beats a year-old crawl" — and that is a comparison of two confidences,
// which is exactly what @leadwolf/types' confidence model computes. So this composes that rather than
// inventing a second scoring scheme.

import { computeFieldConfidence } from "@leadwolf/types";

/** What a source is claiming, or what we currently believe. */
export interface EmploymentClaim {
  /** The company the person is at. Null = an explicit "no longer employed here" with no known destination. */
  companyId: string | null;
  title?: string | null;
  /** How this was established — feeds METHOD_PRIOR. */
  method?: string | null;
  /** Whole days since the claim was OBSERVED (valid time). Null = unknown, treated as cold-start. */
  ageDays?: number | null;
  /** Independent channels asserting it. One user confirming is not three. */
  distinctSources?: number;
}

export type JobChangeKind =
  /** Same company, different title — a promotion or a lateral move. The contact is still reachable. */
  | "title_change"
  /** Moved to a KNOWN new company. The most actionable outcome: the successor search has a target. */
  | "moved"
  /** Left, destination unknown. Still actionable — the record must stop being treated as current. */
  | "departed";

export interface JobChangeVerdict {
  changed: boolean;
  kind: JobChangeKind | null;
  /** Confidence in the NEW claim after decay and corroboration, ∈ [0,1]. */
  confidence: number;
  /** Confidence in what we previously believed, for comparison. */
  priorConfidence: number;
  /** Why the verdict went the way it did — shown in review queues and alert copy, so a human can disagree. */
  reason:
    | "no_prior"
    | "same_employment"
    | "new_claim_stronger"
    | "prior_stronger"
    | "insufficient_margin";
}

/**
 * How much more believable the new claim must be before we act on it.
 *
 * Not zero, deliberately. Employment claims are noisy — a scraped page lags reality, a title string differs
 * by punctuation — and a bare `>` comparison would flip a record back and forth every time two sources
 * disagreed by a rounding error. That flapping is worse than being slightly stale: it burns the alert
 * (S-13) that is supposed to mean something, and an alert users learn to ignore has negative value.
 */
export const CHANGE_MARGIN = 0.1;

/** Compare titles ignoring case, punctuation and spacing — "VP, Sales" and "vp sales" are not a job change. */
function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) =>
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

function confidenceOf(claim: EmploymentClaim): number {
  return computeFieldConfidence({
    field: "employment",
    method: claim.method,
    ageDays: claim.ageDays,
    distinctSources: claim.distinctSources ?? 1,
  });
}

/**
 * Decide whether `observed` represents a job change from `prior`.
 *
 * THE ASYMMETRY THAT MATTERS: this compares CONFIDENCES, not timestamps. A fresh but weak claim (one crawl,
 * yesterday) does not beat a strong older one (three users confirming, six months ago) — and 07 asks for
 * exactly that, because the alternative is that the noisiest source always wins simply by being last.
 *
 * A "departed" verdict — companyId null — is held to the same bar as a move. Marking someone as gone is not
 * the safe default: it silently removes them from every list and sequence they belong to, and doing that on
 * one weak signal is how a working contact disappears.
 */
export function detectJobChange(
  prior: EmploymentClaim | null,
  observed: EmploymentClaim,
): JobChangeVerdict {
  const confidence = confidenceOf(observed);

  // Nothing to compare against: the first employment we ever see is not a CHANGE, it is the baseline.
  // Reporting it as a change would fire a "they moved!" alert for every newly imported contact.
  if (!prior) {
    return { changed: false, kind: null, confidence, priorConfidence: 0, reason: "no_prior" };
  }

  const priorConfidence = confidenceOf(prior);
  const sameCompany = prior.companyId === observed.companyId;
  const titleMatches = sameTitle(prior.title, observed.title);

  if (sameCompany && titleMatches) {
    return { changed: false, kind: null, confidence, priorConfidence, reason: "same_employment" };
  }

  if (confidence <= priorConfidence) {
    return { changed: false, kind: null, confidence, priorConfidence, reason: "prior_stronger" };
  }
  if (confidence - priorConfidence < CHANGE_MARGIN) {
    return {
      changed: false,
      kind: null,
      confidence,
      priorConfidence,
      reason: "insufficient_margin",
    };
  }

  const kind: JobChangeKind = sameCompany
    ? "title_change"
    : observed.companyId
      ? "moved"
      : "departed";
  return { changed: true, kind, confidence, priorConfidence, reason: "new_claim_stronger" };
}

/**
 * Whether a verdict warrants alerting a user who has this contact saved (S-13).
 *
 * A title change does NOT alert. The contact is still at the company and still reachable, so the practical
 * value to a seller is near zero while the notification cost is real — and every ignorable alert makes the
 * ones that matter (they left; you are about to email a dead address) less likely to be read.
 */
export function shouldAlert(verdict: JobChangeVerdict): boolean {
  return verdict.changed && (verdict.kind === "moved" || verdict.kind === "departed");
}
