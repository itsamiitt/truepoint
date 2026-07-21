// accountChildPlan.ts — the PURE decision half of `applyAccountDomainWrite` (import-and-data-model-redesign
// 06 §1, S-A2): given what already lives on the account for its domain set, decide what the domain upsert
// does. IO-free so the primary-designation rules are unit-testable without a database; the repository
// (accountChildRepository.ts) executes the verdict inside the caller's withTenantTx and adds the
// workspace-collision probe + cache projection. The direct sibling of contactChannelPlan.planChannelUpsert
// (05 §2.1/§3.3) applied to the account domain set — the SAME first-live-primary + never-flip discipline,
// minus the per-contact cap (domain caps are app-layer at the API edge, 06 §Misuse; the write path has none).
//
// The rules it encodes (06 §1, restated):
//   • per-account append-with-dedup: a domain already live on the account is never re-inserted;
//   • the first live domain for an account becomes the primary (the flat accounts.domain cache-fill row) — and
//     ONLY then; the cache projection rides insert_primary / promote_existing (repo half);
//   • an EXISTING live primary is NEVER flipped by import/enrichment (06 §1 asymmetry 2: on UPDATE the primary
//     changes only via an explicit request on an unpinned row — a promote verb, never an upsert side effect);
//   • a matched non-primary domain under a live-primary account stays as-is (keep_existing); it is promoted
//     ONLY into a primary vacuum (no live primary at all) — the exactly-one-when-any-live-row-exists half.
// The workspace-collision case (the domain is live on ANOTHER account, 06 §1 "match signal, never an error")
// is NOT a verdict here — it is a repo-level probe outcome (`collision`), because it needs a query. This module
// only decides the per-account shape once the caller knows the domain is free to attach to THIS account.

/** What already lives on the account for its domain set (live = deleted_at IS NULL rows only). */
export interface AccountDomainUpsertState {
  /** A live domain row with the SAME domain already exists on this account. */
  matchExists: boolean;
  /** The matched row (when matchExists) is already the live primary. */
  matchIsPrimary: boolean;
  /** Some live domain row on this account is the primary. */
  hasLivePrimary: boolean;
}

export type AccountDomainVerdict =
  /** Insert a new row and designate it the primary (first live domain ⇒ accounts.domain cache-fill). */
  | "insert_primary"
  /** Insert a new row as a secondary (a live primary exists — never flipped by import/enrichment). */
  | "insert_secondary"
  /** The domain already lives on the account and no live primary exists ⇒ promote it (repair-grade fill). */
  | "promote_existing"
  /** The domain already lives on the account; nothing to change. */
  | "keep_existing";

/** Decide what a domain upsert does for one account — the pure core of applyAccountDomainWrite. Mirrors
 *  planChannelUpsert exactly (minus the cap): a dedup hit promotes only into a primary vacuum, never flips a
 *  live primary; a new domain becomes primary only when the account has no live primary yet. */
export function planAccountDomainWrite(state: AccountDomainUpsertState): AccountDomainVerdict {
  if (state.matchExists) {
    // Per-account dedup hit: the domain is already represented. Promote only into a PRIMARY VACUUM (no live
    // primary at all — the exactly-one-whenever-any-live-row-exists half); never demote/flip an existing primary.
    if (!state.hasLivePrimary) return "promote_existing";
    return "keep_existing";
  }
  return state.hasLivePrimary ? "insert_secondary" : "insert_primary";
}
