// crmSyncConflictRepository.ts — the human conflict-review queue (crm-sync 00 §4.7).
// WORKSPACE-scoped under FORCE RLS; every call runs inside withTenantTx.
//
// A conflict is a SUCCESSFUL sync that needs arbitration — distinct from an error, which goes to the DLQ.
// It is raised when the CRM wants to change a field a human pinned: the live value is left untouched and
// the disagreement is staged for review (00 §6.1, staging-not-clobber).
//
// THE PII RULE (§4.7) IS ENFORCED HERE, NOT LEFT TO CALLERS. A review queue must not quietly become a
// second cleartext-PII store: this table is read by staff on a health surface, and an email or phone
// written into tp_value/crm_value would be a copy of regulated data outside the encrypted columns, with
// its own retention and access story. So `maskIfPii` is applied on the write path — a caller cannot forget
// it, and there is no overload that skips it.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { crmSyncConflicts } from "../schema/crm.ts";

/**
 * Fields whose values are PII and must never be stored in clear here.
 *
 * Deliberately a denylist of the known-sensitive fields rather than an allowlist of safe ones: the safe set
 * is the large, open one (every firmographic and profile scalar), and a new scalar field appearing should
 * not silently become unreviewable. A new PII field is a deliberate addition to this list, and the
 * `cf:`-prefixed custom fields are treated as PII by default because their contents are tenant-defined and
 * unknowable from here.
 */
const PII_FIELDS = new Set(["email", "phone", "mobilePhone", "personalEmail", "workEmail"]);

function isPiiField(field: string): boolean {
  return PII_FIELDS.has(field) || field.startsWith("cf:");
}

/**
 * Render a value for the review queue.
 *
 * Non-PII scalars are stored in clear so a reviewer can actually arbitrate. PII is reduced to a shape that
 * says "these differ, and here is just enough to recognise which record" — last four characters only, which
 * is enough for a human holding the record in front of them and useless as a leaked dataset.
 */
export function maskIfPii(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!isPiiField(field)) return text.slice(0, 500);
  if (text.length === 0) return "";
  return `•••${text.slice(-4)}`;
}

export interface CrmConflictInsert {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  recordLinkId?: string | null;
  objectType: string;
  field: string;
  tpValue: unknown;
  crmValue: unknown;
}

export const crmSyncConflictRepository = {
  /**
   * Stage conflicts for review. Values are masked per field on the way in — see the header.
   *
   * Inserts nothing for an empty list so a caller can pass a planner's `conflicts` array unconditionally.
   */
  async recordMany(tx: Tx, rows: CrmConflictInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await tx
      .insert(crmSyncConflicts)
      .values(
        rows.map((r) => ({
          tenantId: r.tenantId,
          workspaceId: r.workspaceId,
          connectionId: r.connectionId,
          recordLinkId: r.recordLinkId ?? null,
          objectType: r.objectType,
          field: r.field,
          status: "open",
          tpValue: maskIfPii(r.field, r.tpValue),
          crmValue: maskIfPii(r.field, r.crmValue),
        })),
      )
      .returning({ id: crmSyncConflicts.id });
    return inserted.length;
  },

  /** The open review queue for a workspace, newest first (index-backed by workspace+status+created_at). */
  async listOpen(tx: Tx, limit: number) {
    return tx
      .select({
        id: crmSyncConflicts.id,
        connectionId: crmSyncConflicts.connectionId,
        recordLinkId: crmSyncConflicts.recordLinkId,
        objectType: crmSyncConflicts.objectType,
        field: crmSyncConflicts.field,
        tpValue: crmSyncConflicts.tpValue,
        crmValue: crmSyncConflicts.crmValue,
        createdAt: crmSyncConflicts.createdAt,
      })
      .from(crmSyncConflicts)
      .where(eq(crmSyncConflicts.status, "open"))
      .orderBy(desc(crmSyncConflicts.createdAt))
      .limit(limit);
  },

  /**
   * Close a conflict. Records WHO resolved it — arbitration is a human decision and the audit trail should
   * say whose. Only an `open` row transitions, so a double-submit from a stale UI cannot overwrite the
   * first reviewer's outcome.
   */
  async resolve(
    tx: Tx,
    conflictId: string,
    status: "resolved" | "ignored",
    resolvedByUserId: string,
  ): Promise<boolean> {
    const updated = await tx
      .update(crmSyncConflicts)
      .set({ status, resolvedByUserId, resolvedAt: sql`now()` })
      .where(and(eq(crmSyncConflicts.id, conflictId), eq(crmSyncConflicts.status, "open")))
      .returning({ id: crmSyncConflicts.id });
    return updated.length === 1;
  },

  /** Open-conflict count for a connection — the sync-health badge. */
  async countOpenForConnection(tx: Tx, connectionId: string): Promise<number> {
    const rows = await tx
      .select({ id: crmSyncConflicts.id })
      .from(crmSyncConflicts)
      .where(
        and(eq(crmSyncConflicts.connectionId, connectionId), eq(crmSyncConflicts.status, "open")),
      );
    return rows.length;
  },
};
