// platformAuditReads.ts — read-only access to the platform audit log (ADR-0032 / 13 §9). The
// `platform_audit_log` table is a RAW table (it is NOT in the Drizzle schema — it is created/owned by the
// rls/migration layer and every withPlatformTx call appends a row to it), so it is read here with a hand-
// written `sql` SELECT rather than a typed query builder. The transaction handed in is the audited owner-role
// path from withPlatformTx, which bypasses RLS, so this cross-tenant read sees every tenant's entries.
//
// Bounded by PLATFORM_READ_LIMIT — no unbounded cross-tenant scans (ADR-0032). The `metadata` jsonb column is
// deliberately OMITTED from the projection: it can carry arbitrary per-action detail, so the staff list view
// surfaces only the structured envelope (who/what/where/when), never the free-form payload.

import { TENANT_VISIBLE_STAFF_ACTIONS } from "@leadwolf/types";
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

/**
 * A staff-access row as surfaced to the CUSTOMER's tenant-admin (list-plan/07 §5 — "the customer can see
 * staff looking"). It is the transparency projection of `platform_audit_log` filtered to THIS tenant: who
 * (the staff actor), what action, which list, when. The staff actor's request `ip` is deliberately OMITTED
 * — that is internal staff context, not something to surface to the customer. `metadata` (free-form, may
 * carry impersonation reasons / internal detail) is also never selected.
 */
export interface TenantStaffAccessRow {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  occurredAt: Date;
}

interface RawTenantStaffAccessRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
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

  /**
   * The CUSTOMER-visible staff-access log for ONE tenant (list-plan/07 §5, D2): staff record-/data-level
   * accesses to THIS tenant's list data, newest first, bounded. This is the trust-transparency surface — the
   * customer can see staff looking. It is tenant-FILTERED (`tenant_id = $1`) AND action-allow-listed
   * (`TENANT_VISIBLE_STAFF_ACTIONS`) so it never leaks unrelated cross-tenant platform actions; `ip` and
   * `metadata` are not projected (internal staff context). MUST run inside a withPlatformTx transaction — the
   * owner connection is the ONLY path that may read `platform_audit_log` (it is REVOKEd + RLS deny-all to
   * leadwolf_app; we never grant the customer app role access to the table). The tenantId MUST come from the
   * caller's VERIFIED session, never from the request body.
   */
  async listTenantStaffAccess(
    tx: Tx,
    tenantId: string,
    limit = PLATFORM_READ_LIMIT,
  ): Promise<TenantStaffAccessRow[]> {
    // Pass the allow-list as a Postgres text-array LITERAL ('{a,b}') bound as one parameter — drizzle's sql
    // template does not parameterize a JS array as a SQL array, and the values are a fixed compile-time
    // constant (no user input). tenantId is bound + cast to uuid (a malformed id is a clean error, not a leak).
    const actionList = `{${TENANT_VISIBLE_STAFF_ACTIONS.join(",")}}`;
    const rows = (await tx.execute(sql`
      SELECT id, actor_user_id, action, target_type, target_id, occurred_at
      FROM platform_audit_log
      WHERE tenant_id = ${tenantId}::uuid
        AND action = ANY(${actionList}::text[])
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `)) as unknown as RawTenantStaffAccessRow[];
    return rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at),
    }));
  },
};
