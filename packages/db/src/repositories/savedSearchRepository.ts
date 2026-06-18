// savedSearchRepository.ts — data access for `saved_searches` (M8, 24 §8). The ONLY data layer for saved
// searches: every method is tx-aware (composed inside one withTenantTx by the core layer) so RLS scopes the
// rows to the active workspace. Two visibility rules live here:
//   • listVisible — workspace rows where visibility='workspace' OR owner = caller (private rows stay private).
//   • mutations (rename/delete) — caller MUST be the owner; the repo selects owner_user_id so core can gate.
// `filters` is the persisted contactQuery blob; it is stored/returned as JSON verbatim (never SQL).

import type { ContactQuery, SavedSearchVisibility } from "@leadwolf/types";
import { and, desc, eq, or } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { savedSearches } from "../schema/savedSearches.ts";

/** A saved-search row as stored (filters is the contactQuery blob; timestamps are Date). */
export interface SavedSearchRow {
  id: string;
  name: string;
  filters: ContactQuery;
  visibility: SavedSearchVisibility;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The values a create needs (PII-free; the blob is already validated by the core layer). */
export interface SavedSearchInsert {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  filters: ContactQuery;
  visibility: SavedSearchVisibility;
}

function toRow(r: typeof savedSearches.$inferSelect): SavedSearchRow {
  return {
    id: r.id,
    name: r.name,
    filters: r.filters as ContactQuery,
    visibility: r.visibility as SavedSearchVisibility,
    ownerUserId: r.ownerUserId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const savedSearchRepository = {
  /** Insert a new saved search; returns the persisted row. RLS pins it to the active workspace. */
  async insert(tx: Tx, values: SavedSearchInsert): Promise<SavedSearchRow> {
    const rows = await tx.insert(savedSearches).values(values).returning();
    return toRow(rows[0]!);
  },

  /**
   * Rows the caller may SEE in the active workspace: every `workspace`-visibility row plus the caller's own
   * `private` rows. Newest-first. RLS already constrains to the workspace; this adds the owner/visibility
   * filter so a teammate's private searches never leak.
   */
  async listVisible(tx: Tx, callerUserId: string): Promise<SavedSearchRow[]> {
    const rows = await tx
      .select()
      .from(savedSearches)
      .where(
        or(eq(savedSearches.visibility, "workspace"), eq(savedSearches.ownerUserId, callerUserId)),
      )
      .orderBy(desc(savedSearches.createdAt));
    return rows.map(toRow);
  },

  /** Apply a rename / visibility change to a row OWNED by `ownerUserId`. Returns the updated row, or null
   *  if no owned row matched (wrong id, other workspace via RLS, or not the owner). */
  async updateOwned(
    tx: Tx,
    id: string,
    ownerUserId: string,
    patch: { name?: string; visibility?: SavedSearchVisibility },
  ): Promise<SavedSearchRow | null> {
    const rows = await tx
      .update(savedSearches)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(savedSearches.id, id), eq(savedSearches.ownerUserId, ownerUserId)))
      .returning();
    return rows[0] ? toRow(rows[0]) : null;
  },

  /** Delete a row OWNED by `ownerUserId`. Returns true when a row was removed (false = not found / not owner). */
  async deleteOwned(tx: Tx, id: string, ownerUserId: string): Promise<boolean> {
    const rows = await tx
      .delete(savedSearches)
      .where(and(eq(savedSearches.id, id), eq(savedSearches.ownerUserId, ownerUserId)))
      .returning({ id: savedSearches.id });
    return rows.length > 0;
  },
};
