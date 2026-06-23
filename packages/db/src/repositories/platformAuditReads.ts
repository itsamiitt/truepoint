// platformAuditReads.ts — read-only access to the platform audit log (ADR-0032 / 13 §9). The
// `platform_audit_log` table is a RAW table (it is NOT in the Drizzle schema — it is created/owned by the
// rls/migration layer and every withPlatformTx call appends a row to it), so it is read here with a hand-
// written `sql` SELECT rather than a typed query builder. The transaction handed in is the audited owner-role
// path from withPlatformTx, which bypasses RLS, so this cross-tenant read sees every tenant's entries.
//
// Bounded by PLATFORM_READ_LIMIT — no unbounded cross-tenant scans (ADR-0032). The `metadata` jsonb column is
// deliberately OMITTED from the projection: it can carry arbitrary per-action detail, so the staff list view
// surfaces only the structured envelope (who/what/where/when), never the free-form payload.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { PLATFORM_READ_LIMIT } from "./platformAdminReads.ts";

export interface PlatformAuditRow {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  tenantId: string | null;
  workspaceId: string | null;
  ip: string | null;
  occurredAt: Date;
}

// The raw row shape postgres.js returns for the SELECT below (snake_case columns, untyped). Mapped to the
// camelCase PlatformAuditRow before it leaves this repository.
interface RawAuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  tenant_id: string | null;
  workspace_id: string | null;
  ip: string | null;
  occurred_at: Date;
}

export const platformAuditReadRepository = {
  /** The most recent platform audit entries, newest first, bounded (ADR-0032). `metadata` is not selected —
   *  the list view never exposes the free-form jsonb payload. Must run inside a withPlatformTx transaction. */
  async listRecent(tx: Tx, limit = PLATFORM_READ_LIMIT): Promise<PlatformAuditRow[]> {
    // Raw SELECT (platform_audit_log is not in the Drizzle schema). postgres.js via tx.execute returns the
    // rows directly as an array — mirrors the dsarRepository raw-read pattern in this package.
    const rows = (await tx.execute(sql`
      SELECT id, actor_user_id, action, target_type, target_id, tenant_id, workspace_id, ip, occurred_at
      FROM platform_audit_log
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `)) as unknown as RawAuditRow[];
    return rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      ip: r.ip,
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at),
    }));
  },
};
