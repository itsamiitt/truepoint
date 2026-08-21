// masterConfidencePolicyRepository.ts — reads of the tunable confidence constants (migration 0107,
// master_confidence_policy). Always called inside withErTx (leadwolf_er): Layer-0 system table, grant-off
// from the app role by the `^master_` convention.
//
// C9 RESOLUTION (decisions.md 2026-08-19, D-2): the shipped badge leaf function stays the only scoring
// path; this repository supplies its CONSTANTS. Display-only slice, so this reads exactly the rows the
// badge can honour — per-FIELD half-lives (source_type = '*') plus the ('*','*') fallback. The
// per-source-type dimension parameterizes the (still unwired) provenance fold, not the badge: a badge is
// priced off a METHOD, and collapsing source_type into it here would fork the model's semantics.

import type { ConfidenceHalfLifePolicy } from "@leadwolf/types";
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Matches the seeded ('*','*') row's 730d; used only if that row was deleted — the load can never miss. */
const FALLBACK_DEFAULT_HALF_LIFE_DAYS = 730;

export const masterConfidencePolicyRepository = {
  /**
   * The badge's half-life constants: every ENABLED per-field wildcard-source row, plus the universal
   * fallback. `half_life_days IS NULL` is a real value ("does not decay") and is carried through as null,
   * never coalesced. Disabled rows are invisible — is_enabled is the per-row rollout switch the schema
   * promises.
   */
  async loadBadgeHalfLives(tx: Tx): Promise<ConfidenceHalfLifePolicy> {
    const rows = (await tx.execute(sql`
      SELECT field, half_life_days
        FROM master_confidence_policy
       WHERE is_enabled AND source_type = '*'
    `)) as unknown as Array<{ field: string; half_life_days: number | null }>;

    const fieldHalfLifeDays: Record<string, number | null> = {};
    let defaultHalfLifeDays = FALLBACK_DEFAULT_HALF_LIFE_DAYS;
    for (const r of rows) {
      if (r.field === "*")
        defaultHalfLifeDays = r.half_life_days ?? FALLBACK_DEFAULT_HALF_LIFE_DAYS;
      else fieldHalfLifeDays[r.field] = r.half_life_days;
    }
    return { fieldHalfLifeDays, defaultHalfLifeDays };
  },
};
