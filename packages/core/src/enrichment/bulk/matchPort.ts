// matchPort.ts — the bulk match-first resolution contract (31 §5, ADR-0037). A bulk row is reduced to
// MatchKeys (matchKeys.ts), then resolved through a MatchPort in strict cost order: workspace overlay →
// global master graph (stub) → provider residual. core OWNS the port; the future bulk worker wires the real
// DB-backed CandidateFinder and the provider waterfall. This module NEVER imports @leadwolf/db: the lookup
// is injected as a CandidateFinder dependency (the same swappable-seam discipline as ProviderPort).

// MatchMethod has TWO scopes that must NOT be conflated:
//  - the CANONICAL match_method (7 values incl. `provider`/`none`) is the terminal classification of a row,
//    so MatchRowResult.method uses it (a miss is `none`); imported from @leadwolf/types (single source).
//  - a candidate can only AGREE on one of the 5 KEY methods (matchKeys.MatchMethod, no `provider`/`none`),
//    so Candidate.matchedKeys uses that narrower type — a finder can never claim `provider`/`none` as a key.
import type { MatchMethod as CanonicalMatchMethod, MatchOutcome } from "@leadwolf/types";
import type { MatchMethod as MatchKeyMethod, MatchKeys } from "../matchKeys.ts";

/**
 * The workspace scope a match runs in. Kept minimal + structural (no @leadwolf/db TenantScope import — this
 * module is DI-only); the real finder receives whatever it needs to scope the lookup to one workspace.
 */
export interface MatchContext {
  workspaceId: string;
}

/**
 * One resolved-graph candidate the injected finder returns for a set of keys. The matcher decides — from the
 * keys that actually agreed and the candidate's own confidence — which match_method/outcome applies; the
 * finder only surfaces who *could* match. `confidence` (∈ [0,1]) is the candidate's own match strength
 * (1.0 for a deterministic-key row; a probabilistic score for the fuzzy tail).
 */
export interface Candidate {
  /** Overlay copy id (the workspace's contacts row), when the candidate is a Layer-1 overlay record. */
  contactId?: string;
  /** Layer-0 golden id, when the candidate is a master-graph record (nullable until that infra lands). */
  masterPersonId?: string;
  /** Which match KEYS this candidate agreed on, strongest first — drives match_method selection. */
  matchedKeys: MatchKeyMethod[];
  /** The candidate's own confidence ∈ [0,1]; 1.0 for deterministic, a Splink-style score for fuzzy. */
  confidence: number;
}

/**
 * The INJECTED data-lookup dependency: given a scope + the row's keys, return the candidate records the
 * resolved graph holds (deterministic-key hits and/or fuzzy-block candidates). Implementations live in the
 * worker (real, DB-backed) or in tests (a fake). core defines only the shape — it never imports @leadwolf/db.
 */
export type CandidateFinder = (ctx: MatchContext, keys: MatchKeys) => Promise<Candidate[]>;

/** The terminal result of resolving one row. Mirrors the 31 §5 MatchResult, using the canonical enums. */
export interface MatchRowResult {
  method: CanonicalMatchMethod;
  outcome: MatchOutcome;
  /** Overlay copy id on an internal overlay hit. */
  contactId?: string;
  /** Layer-0 golden id on a master-graph hit (nullable). */
  masterPersonId?: string;
  /** Match confidence ∈ [0,1]; deterministic = 1.0, fuzzy = the probabilistic score. */
  confidence?: number;
  /**
   * True when the match is below the accept threshold and must go to the manual-review queue rather than be
   * auto-accepted (31 §5.5). The outcome stays `unmatched` (not silently merged, not billed) until reviewed.
   */
  needsReview?: boolean;
}

/**
 * Resolve a single normalized row to a match. Implementations short-circuit on the strongest stage they own
 * (overlay deterministic → fuzzy → miss; or the master-graph stub). The bulk pipeline calls each MatchPort
 * in cost order and falls through to the provider waterfall only on a miss.
 */
export interface MatchPort {
  matchRow(keys: MatchKeys, ctx: MatchContext): Promise<MatchRowResult>;
}
