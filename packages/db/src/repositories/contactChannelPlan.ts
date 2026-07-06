// contactChannelPlan.ts — the PURE decision half of `applyChannelWrite` (import-and-data-model-redesign 05
// §2.1/§3.3/§6, S-CH2): given what already lives on the contact for one channel, decide what the upsert does.
// IO-free so the primary-designation + cap rules are unit-testable without a database; the repository
// (contactChannelRepository.ts) executes the verdict inside the caller's withTenantTx.
//
// The rules it encodes (05, restated):
//   • per-contact append-with-dedup (05 §6): a value already live on the contact (same blind index) is never
//     re-inserted — `first_seen_at` survives re-imports;
//   • first live value for a channel becomes the primary (the 05 §3.3 "cache fill" row) — and ONLY then;
//   • an EXISTING live primary is NEVER flipped by import/enrichment (05 §3.3/§6) — an incoming different
//     value appends as a secondary. (During S-CH2 the shipped writers may still overwrite the FLAT value —
//     that transient flat↔child-primary divergence is the S-CH5 sweep's flat-wins repair case, not a writer
//     decision; see the repository header.)
//   • a contact with a live primary but a MATCHED tombstone-free row that is not primary stays as-is —
//     promotion is an explicit verb (S-CH4/doc 04), never an upsert side effect;
//   • a contact already at the per-contact cap (25, MAX_CHANNEL_VALUES_PER_CONTACT) SKIPS the append —
//     counted + warned by the caller, never an error (05 §Misuse).

/** What already lives on the contact for this channel (live = deleted_at IS NULL rows only). */
export interface ChannelUpsertState {
  /** Count of live rows for (contact, channel). */
  liveCount: number;
  /** A live row with the SAME blind index already exists on this contact. */
  matchExists: boolean;
  /** The matched row (when matchExists) is already the live primary. */
  matchIsPrimary: boolean;
  /** Some live row on this contact is the primary. */
  hasLivePrimary: boolean;
  /** The per-contact cap (MAX_CHANNEL_VALUES_PER_CONTACT). */
  cap: number;
}

export type ChannelUpsertVerdict =
  /** Insert a new row and designate it the primary (first live value ⇒ cache-fill projection). */
  | "insert_primary"
  /** Insert a new row as a secondary (a live primary exists — never flipped). */
  | "insert_secondary"
  /** The value already lives on the contact and no live primary exists ⇒ promote it (repair-grade fill). */
  | "promote_existing"
  /** The value already lives on the contact; nothing to change. */
  | "keep_existing"
  /** New value but the contact is at the per-contact cap ⇒ skip + count (never an error). */
  | "capped";

/** Decide what an email/phone upsert does for one contact — the pure core of applyChannelWrite. */
export function planChannelUpsert(state: ChannelUpsertState): ChannelUpsertVerdict {
  if (state.matchExists) {
    // Per-contact dedup hit: the value is already represented. Promote only into a PRIMARY VACUUM (no live
    // primary at all — the exactly-one-whenever-any-live-row-exists half of CH-INV-1); never demote/flip.
    if (!state.hasLivePrimary) return "promote_existing";
    return "keep_existing";
  }
  if (state.liveCount >= state.cap) return "capped";
  return state.hasLivePrimary ? "insert_secondary" : "insert_primary";
}
