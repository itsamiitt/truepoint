// scheduledImportRepository.ts — the ONLY data-access for the `scheduled_imports` table (import-and-data-
// model-redesign 08 §9, P5). Two access shapes, mirroring importJobRepository:
//   • WORKSPACE-scoped CRUD (the api verbs) — run inside withTenantTx; RLS walls the workspace.
//   • SYSTEM-level, non-PII, OWNER-connection reads (the leader-locked sweep's due census) — a raw
//     db.execute mirroring listDeferredWorkspaces / listNonTerminalImportJobs; the sweep then re-scopes into
//     each schedule's workspace via withTenantTx for the fire's writes (submit + audit + the failure/disable
//     mutations). Control-columns only (name/keys/timestamps/counters) — never row values, so no PII crosses
//     the owner-connection boundary.
//
// Every mutation that advances a schedule (advanceAfterFire / recordFailure / autoDisable) is tx-aware so the
// sweep composes the state change with its audit/notify writes in ONE withTenantTx (in-tx discipline).

import { and, eq, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { scheduledImports } from "../schema/scheduledImports.ts";

/** The full row as read back (Drizzle $inferSelect — all non-PII control columns). */
export type ScheduledImportRow = typeof scheduledImports.$inferSelect;

/** The writable columns the create verb computes. tenant/workspace/creator scope the row (from the token). */
export interface ScheduledImportCreateValues {
  tenantId: string;
  workspaceId: string;
  createdByUserId: string;
  name: string;
  sourceName: string;
  sourceObjectKey: string;
  sourceFilename?: string | null;
  mapping: Record<string, unknown>;
  mergeMode?: string | null;
  preservePopulated?: boolean | null;
  targetListId?: string | null;
  options?: Record<string, unknown>;
  cadence: string;
  enabled: boolean;
  nextRunAt: Date;
}

/** Sparse patch for the update verb (undefined keys untouched). `enabled: true` clears the failure state. */
export interface ScheduledImportUpdateValues {
  name?: string;
  mapping?: Record<string, unknown>;
  mergeMode?: string | null;
  preservePopulated?: boolean | null;
  targetListId?: string | null;
  options?: Record<string, unknown>;
  cadence?: string;
  enabled?: boolean;
  disabledReason?: string | null;
  consecutiveFailures?: number;
  nextRunAt?: Date;
}

/** A due schedule as the sweep sees it (owner-connection read; the scope is explicit, not RLS). */
export interface DueSchedule {
  id: string;
  tenantId: string;
  workspaceId: string;
}

function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
}

export const scheduledImportRepository = {
  // ── Workspace-scoped CRUD (compose inside withTenantTx) ────────────────────────────────────────────────

  /** Count schedules in the caller's workspace (the per-workspace cap check on create). RLS-scoped. */
  async countInWorkspace(tx: Tx, workspaceId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(scheduledImports)
      .where(eq(scheduledImports.workspaceId, workspaceId));
    return Number(row?.n ?? 0);
  },

  /** Insert a schedule. The (workspace_id, lower(name)) unique surfaces a duplicate name as a DB error the
   *  route maps to 422 (create is NOT an upsert — a re-create under a taken name must fail, not clobber). */
  async create(tx: Tx, values: ScheduledImportCreateValues): Promise<ScheduledImportRow> {
    const [row] = await tx
      .insert(scheduledImports)
      .values({
        tenantId: values.tenantId,
        workspaceId: values.workspaceId,
        createdByUserId: values.createdByUserId,
        name: values.name,
        sourceName: values.sourceName,
        sourceObjectKey: values.sourceObjectKey,
        sourceFilename: values.sourceFilename ?? null,
        mapping: values.mapping,
        mergeMode: values.mergeMode ?? null,
        preservePopulated: values.preservePopulated ?? null,
        targetListId: values.targetListId ?? null,
        options: values.options ?? {},
        cadence: values.cadence,
        enabled: values.enabled,
        nextRunAt: values.nextRunAt,
      })
      .returning();
    return row!;
  },

  /** List the workspace's schedules, newest-first. RLS-scoped. */
  async listInWorkspace(tx: Tx, workspaceId: string): Promise<ScheduledImportRow[]> {
    return tx
      .select()
      .from(scheduledImports)
      .where(eq(scheduledImports.workspaceId, workspaceId))
      .orderBy(sql`${scheduledImports.createdAt} DESC`);
  },

  /** One schedule by id (RLS-scoped; foreign/absent ⇒ null ⇒ the route 404s without leaking existence). */
  async getById(tx: Tx, id: string): Promise<ScheduledImportRow | null> {
    const rows = await tx
      .select()
      .from(scheduledImports)
      .where(eq(scheduledImports.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  /** FOR UPDATE lock (the sweep re-reads under lock before firing so a concurrent update/delete/disable
   *  serializes; also the api's update/delete read-modify path if it needs it). RLS-scoped. */
  async getByIdForUpdate(tx: Tx, id: string): Promise<ScheduledImportRow | null> {
    const rows = await tx
      .select()
      .from(scheduledImports)
      .where(eq(scheduledImports.id, id))
      .for("update")
      .limit(1);
    return rows[0] ?? null;
  },

  /** Apply a sparse update (undefined keys untouched). Enabling clears the failure state at the route layer
   *  by passing disabledReason:null + consecutiveFailures:0 explicitly. Returns the updated row or null. */
  async update(
    tx: Tx,
    id: string,
    patch: ScheduledImportUpdateValues,
  ): Promise<ScheduledImportRow | null> {
    const set = definedOnly(patch);
    if (Object.keys(set).length === 0) return this.getById(tx, id);
    const rows = await tx
      .update(scheduledImports)
      .set(set)
      .where(eq(scheduledImports.id, id))
      .returning();
    return rows[0] ?? null;
  },

  /** Delete a schedule. Returns true if a row was removed (RLS-scoped; foreign id matches 0 rows ⇒ false). */
  async delete(tx: Tx, id: string): Promise<boolean> {
    const rows = await tx
      .delete(scheduledImports)
      .where(eq(scheduledImports.id, id))
      .returning({ id: scheduledImports.id });
    return rows.length > 0;
  },

  // ── System-level, OWNER-connection reads/writes (the sweep) ───────────────────────────────────────────

  /** Enumerate DUE schedules (enabled && next_run_at <= now), oldest-due-first, bounded — the sweep's census.
   *  System-level owner-connection read (no GUC; the scope is returned explicitly). Non-PII (ids only). */
  async listDueSchedules(now: Date, limit = 500): Promise<DueSchedule[]> {
    const capped = Math.max(1, Math.min(2000, Math.trunc(limit)));
    const rows = (await db.execute(sql`
      SELECT id, tenant_id, workspace_id
      FROM scheduled_imports
      WHERE enabled = true AND next_run_at <= ${now}
      ORDER BY next_run_at ASC
      LIMIT ${capped}
    `)) as unknown as Array<{ id: string; tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  /** Record a SUCCESSFUL fire: advance next_run_at, stamp last_run_at + last_job_id, reset the failure state.
   *  Pinned to the row id under the caller's scoped tx (the sweep locked it first). */
  async advanceAfterFire(
    tx: Tx,
    id: string,
    values: { nextRunAt: Date; lastRunAt: Date; lastJobId: string | null },
  ): Promise<void> {
    await tx
      .update(scheduledImports)
      .set({
        nextRunAt: values.nextRunAt,
        lastRunAt: values.lastRunAt,
        lastJobId: values.lastJobId,
        consecutiveFailures: 0,
        disabledReason: null,
      })
      .where(eq(scheduledImports.id, id));
  },

  /** Record a FIRE-TIME FAILURE: bump consecutive_failures, advance next_run_at (so a broken schedule does
   *  not hot-loop the sweep every tick), and — when the bumped count reaches the threshold — auto-disable
   *  with disabled_reason='max_failures'. Returns the resulting state so the sweep can notify on disable. */
  async recordFailure(
    tx: Tx,
    id: string,
    values: { nextRunAt: Date; maxFailures: number },
  ): Promise<{ consecutiveFailures: number; disabled: boolean }> {
    const rows = await tx
      .update(scheduledImports)
      .set({
        consecutiveFailures: sql`${scheduledImports.consecutiveFailures} + 1`,
        nextRunAt: values.nextRunAt,
        enabled: sql`CASE WHEN ${scheduledImports.consecutiveFailures} + 1 >= ${values.maxFailures} THEN false ELSE ${scheduledImports.enabled} END`,
        disabledReason: sql`CASE WHEN ${scheduledImports.consecutiveFailures} + 1 >= ${values.maxFailures} THEN 'max_failures' ELSE ${scheduledImports.disabledReason} END`,
      })
      .where(eq(scheduledImports.id, id))
      .returning({
        consecutiveFailures: scheduledImports.consecutiveFailures,
        enabled: scheduledImports.enabled,
      });
    const row = rows[0];
    return {
      consecutiveFailures: Number(row?.consecutiveFailures ?? 0),
      disabled: row ? !row.enabled : false,
    };
  },

  /** Hard-disable a schedule for GRANT LOSS (the creator can no longer create imports here, or was deleted).
   *  disabled_reason='grant_lost'; next_run_at untouched (a re-enable resumes from the same cadence anchor). */
  async disableForGrantLoss(tx: Tx, id: string): Promise<void> {
    await tx
      .update(scheduledImports)
      .set({ enabled: false, disabledReason: "grant_lost" })
      .where(and(eq(scheduledImports.id, id), eq(scheduledImports.enabled, true)));
  },
};
