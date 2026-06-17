// overlayMatcher.ts — the real, day-one MatchPort: resolve a bulk row against the calling workspace's
// Layer-1 overlay (31 §5.2, ADR-0037 stage 1). Deterministic-first down the ladder
// (email blind index → linkedin → phone → registrable domain) → match_method = deterministic_*,
// outcome = matched_internal, confidence 1.0. If only the fuzzy name+company facet matches, the candidate's
// Splink-style score is compared to the accept threshold: at/above → fuzzy_name_company matched_internal;
// below → routed to manual review (outcome unmatched, needsReview, NOT auto-merged/billed — 31 §5.5). No
// candidate → unmatched/none. The DB lookup is INJECTED as a CandidateFinder; @leadwolf/db is never imported.

// The narrow 5-value KEY type (no `provider`/`none`) — what a candidate can actually agree on.
import type { MatchMethod as MatchKeyMethod, MatchKeys } from "../matchKeys.ts";
import type {
  Candidate,
  CandidateFinder,
  MatchContext,
  MatchPort,
  MatchRowResult,
} from "./matchPort.ts";

/** Deterministic ladder, strongest → weakest. The first method whose key the row HAS and a candidate AGREES on wins. */
const DETERMINISTIC_LADDER: readonly MatchKeyMethod[] = [
  "deterministic_email",
  "deterministic_linkedin",
  "deterministic_phone",
  "deterministic_domain",
];

/** Which deterministic keys the row actually carries — a candidate can only match on a key the row has. */
function rowDeterministicKeys(keys: MatchKeys): Set<MatchKeyMethod> {
  const present = new Set<MatchKeyMethod>();
  if (keys.emailIndex) present.add("deterministic_email");
  if (keys.linkedinPublicId) present.add("deterministic_linkedin");
  if (keys.e164Phone) present.add("deterministic_phone");
  if (keys.registrableDomain) present.add("deterministic_domain");
  return present;
}

/**
 * The strongest deterministic method that BOTH the row carries and some candidate agreed on, or undefined
 * if no candidate shares any deterministic key the row has.
 */
function bestDeterministicMethod(
  candidates: Candidate[],
  rowKeys: Set<MatchKeyMethod>,
): MatchKeyMethod | undefined {
  for (const method of DETERMINISTIC_LADDER) {
    if (!rowKeys.has(method)) continue;
    if (candidates.some((c) => c.matchedKeys.includes(method))) return method;
  }
  return undefined;
}

/** The highest-confidence candidate that agreed on a given method (deterministic candidates are 1.0). */
function candidateFor(candidates: Candidate[], method: MatchKeyMethod): Candidate | undefined {
  return candidates
    .filter((c) => c.matchedKeys.includes(method))
    .reduce<Candidate | undefined>(
      (best, c) => (best === undefined || c.confidence > best.confidence ? c : best),
      undefined,
    );
}

export interface OverlayMatcherOptions {
  /**
   * Min confidence to auto-accept a fuzzy_name_company match (∈ [0,1]). At/above → matched_internal; below →
   * manual review (unmatched + needsReview). Deterministic hits ignore this — they are always confidence 1.0.
   */
  confidenceThreshold: number;
}

/**
 * Build a MatchPort backed by an INJECTED CandidateFinder over the workspace overlay. The finder does the DB
 * lookup (real impl in the worker; a fake in tests); this module owns only the deterministic→fuzzy→miss logic.
 */
export function createOverlayMatcher(
  findCandidates: CandidateFinder,
  options: OverlayMatcherOptions,
): MatchPort {
  return {
    async matchRow(keys: MatchKeys, ctx: MatchContext): Promise<MatchRowResult> {
      const candidates = await findCandidates(ctx, keys);
      if (candidates.length === 0) return { method: "none", outcome: "unmatched" };

      // 1) Deterministic ladder — strongest shared key wins, confidence 1.0, free internal hit.
      const detMethod = bestDeterministicMethod(candidates, rowDeterministicKeys(keys));
      if (detMethod) {
        const hit = candidateFor(candidates, detMethod);
        return {
          method: detMethod,
          outcome: "matched_internal",
          contactId: hit?.contactId,
          masterPersonId: hit?.masterPersonId,
          confidence: 1.0,
        };
      }

      // 2) Fuzzy name+company — only when the row actually has both facets and a candidate scored the tail.
      const canFuzzy = keys.name !== undefined && keys.companyName !== undefined;
      const fuzzy = canFuzzy ? candidateFor(candidates, "fuzzy_name_company") : undefined;
      if (fuzzy) {
        // Auto-accept only a POSITIVE score at/above the threshold. A 0-confidence "match" is meaningless,
        // so even a threshold of 0 (valid per the options schema) must route it to review, never auto-merge.
        if (fuzzy.confidence > 0 && fuzzy.confidence >= options.confidenceThreshold) {
          return {
            method: "fuzzy_name_company",
            outcome: "matched_internal",
            contactId: fuzzy.contactId,
            masterPersonId: fuzzy.masterPersonId,
            confidence: fuzzy.confidence,
          };
        }
        // Below threshold → manual review; NOT auto-merged, NOT billed (31 §5.5).
        return {
          method: "fuzzy_name_company",
          outcome: "unmatched",
          confidence: fuzzy.confidence,
          needsReview: true,
        };
      }

      // 3) Candidates returned, but none agreed on a key the row carries → a genuine miss.
      return { method: "none", outcome: "unmatched" };
    },
  };
}
