// masterGraphMatcher.ts — the Layer-0 global master-graph MatchPort (31 §5.3, ADR-0037 stage 2). This is the
// free middle tier: a synchronous, candidate-indexed READ of the already-resolved master graph (deterministic
// KV in Redis for the ~95% common case, then blocking + MinHash/LSH + Splink for the fuzzy tail) — NOT a
// batch re-resolution.
//
// INFRA-GATED: the billions-scale candidate index (Citus golden store + OpenSearch + Spark-built LSH blocks)
// is on the M12/M13 scale track and is NOT built yet. So this ships now as a STUB behind MatchPort: it always
// returns unmatched/none, and the pipeline runs end-to-end on the overlay matcher + provider waterfall in the
// interim. When the scale infra lands, the real implementation (wired with an injected CandidateFinder over
// the resolved graph, exactly like overlayMatcher) drops in with NO caller change — the seam's whole purpose.
//
// TODO(M12/M13, ADR-0037 "Revisit if"): replace this stub with the real candidate-indexed matcher —
//   1. deterministic KV lookup (email blind index / linkedin id / E.164 phone / registrable domain) → 1.0;
//   2. blocking + MinHash/LSH candidate generation, then Splink scoring of the fuzzy_name_company tail;
//   link matched_master_person_id, 0 credits, outcome matched_internal. Take an injected CandidateFinder
//   over the resolved graph (do NOT import @leadwolf/db here — keep the DI seam).

import type { MatchKeys } from "../matchKeys.ts";
import type { MatchContext, MatchPort, MatchRowResult } from "./matchPort.ts";

/**
 * Build the master-graph MatchPort. Until the M12/M13 scale infra (Citus/OpenSearch/Spark candidate index)
 * is live, every call falls through (unmatched/none) so the bulk pipeline reaches the provider waterfall.
 * The signature is the documented real interface so the real impl drops in with no caller change.
 */
export function createMasterGraphMatcher(): MatchPort {
  return {
    matchRow(_keys: MatchKeys, _ctx: MatchContext): Promise<MatchRowResult> {
      // Stub: the resolved-graph candidate index is not provisioned (ADR-0037 §Consequences). Falling through
      // is SAFE — no correctness regression, only the cost/speed of routing Layer-0-only rows to providers.
      return Promise.resolve({ method: "none", outcome: "unmatched" });
    },
  };
}
