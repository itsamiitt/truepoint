// successor.ts — PURE ranking of who now holds a departed contact's role (06-roadmap Phase 4 "successor
// suggestions from the graph"; outcome S-14 "minimize the time it takes to replace a departed contact with
// the current holder of that role").
//
// The job map calls this out as the Modify step's whole problem: today a seller re-researches the account
// from scratch the moment someone leaves. The graph already knows who else is at that company — this decides
// which of them is the person to talk to instead.
//
// PURE, and the candidate set is supplied. Finding people at a company is a query that already exists
// (erRepository.findBlockingCandidates blocks on exactly that); ranking them is the judgement, and judgement
// is the part worth testing without a database.

import { jaroWinkler } from "../er/stringSimilarity.ts";

/** The ladder, most senior first. Distance on this ladder is the seniority signal. */
const SENIORITY_LADDER = ["c_suite", "vp", "director", "manager", "ic"] as const;

export interface SuccessorCandidate {
  id: string;
  title?: string | null;
  seniorityLevel?: string | null;
  department?: string | null;
}

export interface DepartedRole {
  title?: string | null;
  seniorityLevel?: string | null;
  department?: string | null;
}

export interface SuccessorSuggestion {
  candidateId: string;
  /** Fit ∈ [0,1]. Not a probability — a ranking score, and the UI should present it as an ordering. */
  score: number;
  /** Why this candidate surfaced, so a seller can disagree with the ranking rather than trust it blindly. */
  reasons: string[];
}

/** Normalise a title for comparison: case, punctuation and spacing carry no signal. */
function normTitle(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Seniority proximity ∈ [0,1]: 1 for the same rung, decaying by distance on the ladder.
 *
 * Distance, not equality, because the realistic successor is often one rung away — a manager stepping into a
 * director's seat is the single most common backfill, and an equality test would rank them level with an IC.
 * An unknown or off-ladder value scores neutral rather than zero: absent data is not evidence of a bad fit,
 * and scoring it zero would bury every candidate whose seniority we simply have not resolved.
 */
export function seniorityProximity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ia = SENIORITY_LADDER.indexOf((a ?? "") as (typeof SENIORITY_LADDER)[number]);
  const ib = SENIORITY_LADDER.indexOf((b ?? "") as (typeof SENIORITY_LADDER)[number]);
  if (ia < 0 || ib < 0) return 0.5;
  return Math.max(0, 1 - Math.abs(ia - ib) / (SENIORITY_LADDER.length - 1));
}

/** Weights. Title dominates because it is the most direct statement of what someone actually does. */
const W_TITLE = 0.55;
const W_SENIORITY = 0.3;
const W_DEPARTMENT = 0.15;

/**
 * Score one candidate against the departed person's role.
 *
 * Returns null when there is NOTHING to compare on — no title, no seniority, no department on either side.
 * A score built from no signal is a guess wearing a number, and S-14's value depends on the suggestion being
 * trustworthy enough to act on without re-checking.
 */
export function scoreSuccessor(
  departed: DepartedRole,
  candidate: SuccessorCandidate,
): SuccessorSuggestion | null {
  const reasons: string[] = [];
  const dTitle = normTitle(departed.title);
  const cTitle = normTitle(candidate.title);

  const haveTitles = dTitle.length > 0 && cTitle.length > 0;
  const haveSeniority = Boolean(departed.seniorityLevel && candidate.seniorityLevel);
  const haveDepartment = Boolean(departed.department && candidate.department);
  if (!haveTitles && !haveSeniority && !haveDepartment) return null;

  const titleSim = haveTitles ? jaroWinkler(dTitle, cTitle) : 0.5;
  if (haveTitles && titleSim > 0.85) reasons.push("same_title");
  else if (haveTitles && titleSim > 0.6) reasons.push("similar_title");

  const senSim = seniorityProximity(departed.seniorityLevel, candidate.seniorityLevel);
  if (haveSeniority && departed.seniorityLevel === candidate.seniorityLevel) {
    reasons.push("same_seniority");
  } else if (haveSeniority && senSim >= 0.75) {
    reasons.push("adjacent_seniority");
  }

  const sameDept =
    haveDepartment && normTitle(departed.department) === normTitle(candidate.department);
  if (sameDept) reasons.push("same_department");

  const score =
    W_TITLE * titleSim +
    W_SENIORITY * senSim +
    W_DEPARTMENT * (sameDept ? 1 : haveDepartment ? 0 : 0.5);

  return { candidateId: candidate.id, score: Math.min(1, Math.max(0, score)), reasons };
}

/** Suggestions below this are not worth a seller's attention — showing them costs more trust than it saves time. */
export const SUCCESSOR_MIN_SCORE = 0.5;

/**
 * Rank successors, best first.
 *
 * Filtered by SUCCESSOR_MIN_SCORE rather than returned wholesale. "Here are five colleagues, one might be
 * right" is what the seller could already do themselves by scrolling the company; the feature only earns its
 * place if a suggestion is good enough to act on. A weak list is worse than an empty one, because it teaches
 * the user the feature does not work.
 *
 * Ties break on candidateId so the ordering is deterministic — an unstable list that reshuffles between
 * renders reads as broken.
 */
export function rankSuccessors(
  departed: DepartedRole,
  candidates: readonly SuccessorCandidate[],
  limit = 3,
): SuccessorSuggestion[] {
  return candidates
    .map((c) => scoreSuccessor(departed, c))
    .filter((s): s is SuccessorSuggestion => s !== null && s.score >= SUCCESSOR_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))
    .slice(0, Math.max(0, limit));
}
