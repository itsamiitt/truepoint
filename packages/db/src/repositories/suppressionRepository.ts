// suppressionRepository.ts — data access for the suppression/DNC list (compliance domain, 08 §3). The
// match query runs INSIDE the reveal/send transaction; the RLS read policy already exposes exactly the
// rows that may gate this scope (global + this tenant + this workspace), so the predicate here is only
// the match itself.

import type { SuppressionMatchType, SuppressionScope } from "@leadwolf/types";
import { type SQL, and, desc, eq, inArray, ne, or } from "drizzle-orm";
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

  /**
   * Like findMatch, but for the OWNER/privileged path (a STAFF cross-tenant export under withPlatformTx) where
   * RLS is BYPASSED. findMatch trusts the RLS read policy to expose only global + this-tenant + this-workspace
   * rows; under the owner that policy is NOT in effect, so this matcher adds that scope predicate EXPLICITLY.
   * Without it, a suppression row belonging to ANOTHER tenant/workspace would falsely match — the email
   * blind-index is a deterministic global HMAC, identical for the same email across every workspace.
   *
   * SECURITY-CRITICAL (database-management-research export; audit A1/X3): this is the unbypassable suppression
   * gate for the cross-tenant export. The explicit `global OR tenant=? OR workspace=?` predicate is what keeps it
   * correct without RLS — never widen it. MUST run inside a withPlatformTx (owner) transaction.
   */
  async findMatchExplicit(
    tx: Tx,
    keys: SuppressionKeys & { tenantId: string; workspaceId: string },
  ): Promise<SuppressionHit | null> {
    const matches: SQL[] = [];
    if (keys.contactId) matches.push(eq(suppressionList.contactId, keys.contactId));
    if (keys.emailBlindIndex)
      matches.push(eq(suppressionList.emailBlindIndex, keys.emailBlindIndex));
    if (keys.emailDomain) matches.push(eq(suppressionList.domain, keys.emailDomain));
    if (matches.length === 0) return null;

    // Replicate the RLS read policy EXPLICITLY (the owner bypasses RLS): a row gates this subject only if it is
    // global, or scoped to THIS tenant, or scoped to THIS workspace — never another tenant's/workspace's row.
    const inScope = or(
      eq(suppressionList.scope, "global"),
      and(eq(suppressionList.scope, "tenant"), eq(suppressionList.tenantId, keys.tenantId)),
      and(eq(suppressionList.scope, "workspace"), eq(suppressionList.workspaceId, keys.workspaceId)),
    );

    const rows = await tx
      .select({
        scope: suppressionList.scope,
        matchType: suppressionList.matchType,
        reason: suppressionList.reason,
      })
      .from(suppressionList)
      .where(and(or(...matches), inScope))
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

  /** List the GLOBAL suppression entries (the platform blocklist) — for the staff console (13a Area 8). Must
   *  run inside a withPlatformTx transaction (owner). Blind-index columns are omitted (HMACs of PII never
   *  leave the DB); a domain entry is fully shown. Newest first, bounded. */
  async listGlobal(tx: Tx, limit = 500): Promise<SuppressionListRow[]> {
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
      .where(eq(suppressionList.scope, "global"))
      .orderBy(desc(suppressionList.createdAt))
      .limit(limit);
  },

  /** Remove a GLOBAL entry by id (staff only — the predicate pins scope='global' so a tenant/workspace row
   *  can never be removed through this path). Returns rows touched (0 = unknown / not global). withPlatformTx. */
  async removeGlobalById(tx: Tx, id: string): Promise<number> {
    const deleted = await tx
      .delete(suppressionList)
      .where(and(eq(suppressionList.id, id), eq(suppressionList.scope, "global")))
      .returning({ id: suppressionList.id });
    return deleted.length;
  },
};
