// suppressionRepository.ts — data access for the suppression/DNC list (compliance domain, 08 §3). The
// match query runs INSIDE the reveal/send transaction; the RLS read policy already exposes exactly the
// rows that may gate this scope (global + this tenant + this workspace), so the predicate here is only
// the match itself.

import type { SuppressionMatchType, SuppressionScope } from "@leadwolf/types";
import { type SQL, desc, eq, inArray, ne, or } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { suppressionList } from "../schema/billing.ts";

/** The identifying keys of the subject being checked; any present key can match a suppression row. */
export interface SuppressionKeys {
  contactId?: string;
  emailBlindIndex?: Uint8Array | null;
  emailDomain?: string | null;
}

export interface SuppressionHit {
  scope: SuppressionScope;
  matchType: SuppressionMatchType;
  reason: string | null;
}

export interface SuppressionEntryInput {
  scope: SuppressionScope;
  tenantId?: string | null;
  workspaceId?: string | null;
  matchType: SuppressionMatchType;
  emailBlindIndex?: Uint8Array | null;
  domain?: string | null;
  contactId?: string | null;
  reason?: string | null;
  createdByUserId?: string | null;
}

/** A suppression row for the management list. The blind-index (HMAC) columns are deliberately OMITTED —
 *  HMACs of PII must never leave the DB; email/phone matches are identified by type only. */
export interface SuppressionListRow {
  id: string;
  scope: string;
  matchType: string;
  domain: string | null;
  contactId: string | null;
  reason: string | null;
  createdAt: Date;
}

export const suppressionRepository = {
  /** First matching suppression row visible to this scope, or null. Runs in the caller's transaction. */
  async findMatch(tx: Tx, keys: SuppressionKeys): Promise<SuppressionHit | null> {
    const matches: SQL[] = [];
    if (keys.contactId) matches.push(eq(suppressionList.contactId, keys.contactId));
    if (keys.emailBlindIndex)
      matches.push(eq(suppressionList.emailBlindIndex, keys.emailBlindIndex));
    if (keys.emailDomain) matches.push(eq(suppressionList.domain, keys.emailDomain));
    if (matches.length === 0) return null;

    const rows = await tx
      .select({
        scope: suppressionList.scope,
        matchType: suppressionList.matchType,
        reason: suppressionList.reason,
      })
      .from(suppressionList)
      .where(or(...matches))
      .limit(1);
    const hit = rows[0];
    if (!hit) return null;
    return {
      scope: hit.scope as SuppressionScope,
      matchType: hit.matchType as SuppressionMatchType,
      reason: hit.reason,
    };
  },

  /** Insert an entry (tenant/workspace scope from the app; global rows are platform-managed). */
  async insert(tx: Tx, entry: SuppressionEntryInput): Promise<string> {
    const rows = await tx
      .insert(suppressionList)
      .values(entry)
      .returning({ id: suppressionList.id });
    return rows[0]!.id;
  },

  /** Remove entries by id within the caller's scope (RLS limits what is deletable). */
  async removeByIds(tx: Tx, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.delete(suppressionList).where(inArray(suppressionList.id, ids));
  },

  /** List the caller's manageable suppression entries (tenant + workspace scope; global rows are platform-
   *  managed and excluded). RLS already restricts visibility to the caller's tenant/workspace; this only
   *  drops global rows and the blind-index columns (HMACs of PII never leave the DB). Newest first. */
  async list(tx: Tx): Promise<SuppressionListRow[]> {
    return tx
      .select({
        id: suppressionList.id,
        scope: suppressionList.scope,
        matchType: suppressionList.matchType,
        domain: suppressionList.domain,
        contactId: suppressionList.contactId,
        reason: suppressionList.reason,
        createdAt: suppressionList.createdAt,
      })
      .from(suppressionList)
      .where(ne(suppressionList.scope, "global"))
      .orderBy(desc(suppressionList.createdAt));
  },
};
