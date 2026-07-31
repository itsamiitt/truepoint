// provenanceBadgeRepository.ts — the corroboration half of confidence badge v0 (06-roadmap Phase 1: "show
// confidence badge v0 — last verified ⟨n⟩ days ago · ⟨k⟩ sources"; outcome S-10).
//
// The FRESHNESS half already ships: computeContactDataQuality / freshnessStatus over contacts.last_verified_at,
// surfaced as `dataHealth` on the masked DTO. Only "⟨k⟩ sources" was missing, so this adds exactly that rather
// than a second badge pipeline.
//
// RUNS UNDER withErTx, NOT withTenantTx — a deliberate consequence of the access model, not an oversight.
// leadwolf_app is REVOKE'd from provenance_event entirely (it carries contributor_ref, and per-record
// contribution patterns are C-02-sensitive even in aggregate form), so the request path physically cannot read
// this table. leadwolf_er can. The precedent is resolveMasterForLanding, which already steps outside the
// per-row tenant tx into its own withErTx for exactly this reason.
//
// WHAT LEAVES THE DATABASE: counts and a timestamp. contributor_ref is aggregated INSIDE the query via
// count(DISTINCT …) and never appears in a result column. That is invariant 2 ("public surfaces show
// counts/recency, not sources' identities") enforced by the shape of the SQL rather than by a caller
// remembering to strip a field.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface ProvenanceBadge {
  /** Distinct contributors who asserted something about this entity. Contributors only — platform-side
   *  sources (import, forge, crawl) carry a null ref and are counted by `sourceCount` instead. */
  contributorCount: number;
  /** Distinct source CHANNELS (provider, import, forge, extension …) that asserted something. */
  sourceCount: number;
  /** How many independent channel KINDS agree — the corroboration signal 07 § Quality control describes.
   *  One source asserting ten times is not ten sources. */
  sourceDiversity: number;
  /** The most recent VALID time any source vouched for this entity (observed_at, not recorded_at). */
  lastObservedAt: Date | null;
  /**
   * The distinct METHODS that established these values (smtp_verify, pattern_inferred, …). Returned as a set
   * rather than a single "best" because ranking them is a policy decision that belongs in the pure confidence
   * model (METHOD_PRIOR), not in SQL — putting it here would fork the ordering the moment a method is added.
   */
  methods: string[];
}

export const provenanceBadgeRepository = {
  /**
   * Aggregate the accepted assertions about one Layer-0 entity.
   *
   * Returns null when the entity has NO events at all, and the distinction matters: "we hold no evidence log
   * for this record" is not "no source vouched for it". A badge rendering "0 sources" for the first case would
   * be actively misleading — most records have no events yet, because the log only starts filling when
   * PROVENANCE_EVENTS_ENABLED flips. Callers should omit the source clause rather than render a zero.
   */
  async badgeFor(
    tx: Tx,
    entityType: "person" | "company",
    entityId: string,
  ): Promise<ProvenanceBadge | null> {
    const rows = (await tx.execute(sql`
      SELECT count(DISTINCT contributor_ref)::int                AS contributor_count,
             count(*)::int                                       AS source_count,
             count(DISTINCT source_type)::int                    AS source_diversity,
             max(observed_at)                                    AS last_observed_at,
             coalesce(array_agg(DISTINCT method)
                        FILTER (WHERE method IS NOT NULL), '{}') AS methods
        FROM provenance_event
       WHERE entity_type = ${entityType}
         AND entity_id   = ${entityId}
         AND acceptance_state = 'accepted'
    `)) as unknown as Array<{
      contributor_count: number;
      source_count: number;
      source_diversity: number;
      last_observed_at: string | Date | null;
      methods: string[] | null;
    }>;

    const row = rows[0];
    // count(*) over no rows is 0, so an absent log and a genuinely empty one look identical here — treat 0 as
    // "no evidence yet" and let the caller omit the clause.
    if (!row || Number(row.source_count) === 0) return null;

    return {
      contributorCount: Number(row.contributor_count),
      sourceCount: Number(row.source_count),
      sourceDiversity: Number(row.source_diversity),
      lastObservedAt: row.last_observed_at ? new Date(row.last_observed_at) : null,
      methods: row.methods ?? [],
    };
  },
};
