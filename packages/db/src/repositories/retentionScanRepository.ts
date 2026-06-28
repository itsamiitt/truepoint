// retentionScanRepository.ts — the COUNT + (double-gated) PURGE layer for the per-data-class RETENTION engine
// (data-management backlog #6; design 16-retention-engine-design.md §3/§5). Phase 2 added the safe COUNT per class
// ("how many rows for THIS tenant are older than the cutoff?" — the candidate volume the sweep records as
// evidence); phase 3 adds the batched DELETE (`deleteExpired`) for the SAME v1 classes. CRITICAL SAFETY: the
// deleters here are INERT by default — a class is purged ONLY when its policy.mode === 'enforce' AND the per-tenant
// `retention_engine_enabled` flag is on. BOTH gates live UPSTREAM in the sweep (core/retention/runRetentionSweep.ts);
// with the shipped defaults (every class `shadow`, the flag false) NOTHING in this file ever deletes a row.
//
// ACCESS MODEL: a retention sweep is a CROSS-TENANT SYSTEM operation, so BOTH the count and the delete run on the
// OWNER connection (the base `db`, RLS-exempt — or a passed owner Tx). They must therefore NEVER rely on RLS for
// isolation; EVERY count AND EVERY delete carries an EXPLICIT tenant predicate (a direct `tenant_id = $t`, or —
// for the high-volume *_rows ledgers that carry only a denormalized workspace_id — `workspace_id IN (SELECT id
// FROM workspaces WHERE tenant_id = $t)`). A delete with no tenant predicate would purge across tenants, so the
// predicate is baked into each per-class closure, never optional.
//
// LOCKSTEP INVARIANT: for each class the delete WHERE MUST match the count WHERE EXACTLY (same aging predicate +
// same tenant scope) so the purge targets EXACTLY the rows the count counted. Both closures live in the SINGLE
// per-class `retentionClassMeta` mapping so they cannot drift; the table/column identifiers come ONLY from the
// typed Drizzle schema (never caller input) and every value (cutoff, tenantId, batchSize) is BOUND, never
// string-interpolated. The delete is BATCHED (≤ batchSize per statement, drained in a loop — mirrors
// idempotencyRepository.deleteExpired) so a large purge never long-locks the table.

import type { RetentionDataClass } from "@leadwolf/types";
import { and, count, eq, inArray, lt, sql } from "drizzle-orm";
import { type Db, type Tx, db } from "../client.ts";
import { workspaces } from "../schema/auth.ts";
import { dataQualitySnapshots } from "../schema/dataQualitySnapshots.ts";
import { emailEvent } from "../schema/email.ts";
import { enrichmentJobRows } from "../schema/enrichmentJobs.ts";
import { importJobRows } from "../schema/importJobs.ts";
import { providerCalls } from "../schema/intel.ts";
import { verificationJobs } from "../schema/verificationJobs.ts";

/** An OWNER-connection reader: the base `db` (RLS-exempt) or a passed owner Tx. Both expose the same query
 *  builder; the count carries its OWN explicit tenant predicate and never relies on RLS for isolation. */
export type OwnerReader = Db | Tx;

/** How a class reaches its tenant: a direct `tenant_id` column, or a join workspace_id → workspaces.tenant_id
 *  (the high-volume *_rows ledgers carry only a denormalized workspace_id, no tenant_id of their own). */
export type RetentionTenantScope = "tenant_column" | "workspace_join";

/** The v1 classes this phase counts (low-risk, no contact cascade, clean created_at/occurred_at aging — design
 *  §3). The v2 contact-cascade / higher-PII classes are intentionally absent: their deleters are not wired yet. */
export const RETENTION_V1_CLASSES = [
  "email_event",
  "provider_calls",
  "enrichment_job_rows",
  "import_job_rows",
  "data_quality_snapshots",
  "verification_jobs",
] as const;
export type RetentionV1Class = (typeof RETENTION_V1_CLASSES)[number];

/** The fixed per-class mapping the COUNT + PURGE layers are driven by. `table`/`agingColumn`/`tenantScope` are the
 *  physical description; `countExpired` is the safe, explicit, tenant-scoped count, and `deleteExpired` is its
 *  LOCKSTEP batched purge (same aging + same tenant scope). Keeping both in one entry is what makes drift
 *  impossible — the delete targets exactly the rows the count counts. */
export interface RetentionClassMeta {
  /** The physical table the class lives in (documentation + the deleter target). */
  readonly table: string;
  /** The physical aging column the cutoff compares against — rows with `agingColumn < cutoff` are candidates. */
  readonly agingColumn: string;
  /** How the explicit tenant predicate is carried (a direct tenant_id, or a workspaces join). */
  readonly tenantScope: RetentionTenantScope;
  /** COUNT the rows OLDER than `cutoff` for `tenantId` on the OWNER connection, ALWAYS carrying an explicit
   *  tenant predicate. Counting only — there is NO delete/update anywhere in this closure. */
  readonly countExpired: (reader: OwnerReader, tenantId: string, cutoff: Date) => Promise<number>;
  /** DELETE one BATCH (≤ `batchSize`) of the rows OLDER than `cutoff` for `tenantId` on the OWNER connection,
   *  ALWAYS carrying the SAME explicit tenant predicate + SAME aging predicate as `countExpired` (LOCKSTEP — the
   *  purge targets exactly the counted rows). Returns the count deleted in THIS batch; `deleteExpiredByClass`
   *  drains the loop. INERT unless the sweep is in enforce mode on a flag-enabled tenant (both gated UPSTREAM). */
  readonly deleteExpired: (
    reader: OwnerReader,
    tenantId: string,
    cutoff: Date,
    batchSize: number,
  ) => Promise<number>;
}

/** Run a `count(*)`-style scalar select and coalesce the single row to a number. */
async function scalarCount(rows: Promise<Array<{ value: number }>>): Promise<number> {
  const [row] = await rows;
  return row?.value ?? 0;
}

/**
 * The single fixed v1 mapping. Each `countExpired` uses TYPED Drizzle columns (identifiers can't be injected) and
 * BINDS every value; the explicit tenant predicate is part of every WHERE — `tenant_column` classes add
 * `tenant_id = $t`; `workspace_join` classes inner-join `workspaces` and filter `workspaces.tenant_id = $t`.
 */
export const retentionClassMeta: Record<RetentionV1Class, RetentionClassMeta> = {
  // Direct tenant_id; age on occurred_at (the tracking-event firehose; schema/email.ts).
  email_event: {
    table: "email_event",
    agingColumn: "occurred_at",
    tenantScope: "tenant_column",
    countExpired: (reader, tenantId, cutoff) =>
      scalarCount(
        reader
          .select({ value: count() })
          .from(emailEvent)
          .where(and(lt(emailEvent.occurredAt, cutoff), eq(emailEvent.tenantId, tenantId))),
      ),
    // LOCKSTEP with countExpired above — IDENTICAL WHERE: occurred_at < cutoff AND tenant_id = $t.
    deleteExpired: async (reader, tenantId, cutoff, batchSize) => {
      const expired = reader
        .select({ id: emailEvent.id })
        .from(emailEvent)
        .where(and(lt(emailEvent.occurredAt, cutoff), eq(emailEvent.tenantId, tenantId)))
        .limit(batchSize);
      const deleted = await reader
        .delete(emailEvent)
        .where(inArray(emailEvent.id, expired))
        .returning({ id: emailEvent.id });
      return deleted.length;
    },
  },
  // Direct tenant_id; age on called_at (the enrichment cache/cost ledger; schema/intel.ts).
  provider_calls: {
    table: "provider_calls",
    agingColumn: "called_at",
    tenantScope: "tenant_column",
    countExpired: (reader, tenantId, cutoff) =>
      scalarCount(
        reader
          .select({ value: count() })
          .from(providerCalls)
          .where(and(lt(providerCalls.calledAt, cutoff), eq(providerCalls.tenantId, tenantId))),
      ),
    // LOCKSTEP with countExpired above — IDENTICAL WHERE: called_at < cutoff AND tenant_id = $t.
    deleteExpired: async (reader, tenantId, cutoff, batchSize) => {
      const expired = reader
        .select({ id: providerCalls.id })
        .from(providerCalls)
        .where(and(lt(providerCalls.calledAt, cutoff), eq(providerCalls.tenantId, tenantId)))
        .limit(batchSize);
      const deleted = await reader
        .delete(providerCalls)
        .where(inArray(providerCalls.id, expired))
        .returning({ id: providerCalls.id });
      return deleted.length;
    },
  },
  // NO tenant_id on the high-volume rows ledger — only a denormalized workspace_id; reach the tenant via the
  // workspaces join. Age on created_at (schema/enrichmentJobs.ts).
  enrichment_job_rows: {
    table: "enrichment_job_rows",
    agingColumn: "created_at",
    tenantScope: "workspace_join",
    countExpired: (reader, tenantId, cutoff) =>
      scalarCount(
        reader
          .select({ value: count() })
          .from(enrichmentJobRows)
          .innerJoin(workspaces, eq(workspaces.id, enrichmentJobRows.workspaceId))
          .where(and(lt(enrichmentJobRows.createdAt, cutoff), eq(workspaces.tenantId, tenantId))),
      ),
    // LOCKSTEP with countExpired above. The count reaches the tenant via an inner join to workspaces
    // (workspaces.tenant_id = $t); a DELETE can't JOIN, so the IDENTICAL set is expressed as
    // `workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = $t)` — equivalent because workspaces.id is the
    // unique PK (the join is 1:1, no row multiplication). Same aging predicate: created_at < cutoff.
    deleteExpired: async (reader, tenantId, cutoff, batchSize) => {
      const tenantWorkspaceIds = reader
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.tenantId, tenantId));
      const expired = reader
        .select({ id: enrichmentJobRows.id })
        .from(enrichmentJobRows)
        .where(
          and(
            lt(enrichmentJobRows.createdAt, cutoff),
            inArray(enrichmentJobRows.workspaceId, tenantWorkspaceIds),
          ),
        )
        .limit(batchSize);
      const deleted = await reader
        .delete(enrichmentJobRows)
        .where(inArray(enrichmentJobRows.id, expired))
        .returning({ id: enrichmentJobRows.id });
      return deleted.length;
    },
  },
  // NO tenant_id — only a denormalized workspace_id; reach the tenant via the workspaces join. Age on created_at
  // (schema/importJobs.ts).
  import_job_rows: {
    table: "import_job_rows",
    agingColumn: "created_at",
    tenantScope: "workspace_join",
    countExpired: (reader, tenantId, cutoff) =>
      scalarCount(
        reader
          .select({ value: count() })
          .from(importJobRows)
          .innerJoin(workspaces, eq(workspaces.id, importJobRows.workspaceId))
          .where(and(lt(importJobRows.createdAt, cutoff), eq(workspaces.tenantId, tenantId))),
      ),
    // LOCKSTEP with countExpired above. Same as enrichment_job_rows: the count's inner join (workspaces.tenant_id
    // = $t) becomes `workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = $t)` for the DELETE (equivalent —
    // workspaces.id is the unique PK). Same aging predicate: created_at < cutoff.
    deleteExpired: async (reader, tenantId, cutoff, batchSize) => {
      const tenantWorkspaceIds = reader
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.tenantId, tenantId));
      const expired = reader
        .select({ id: importJobRows.id })
        .from(importJobRows)
        .where(
          and(
            lt(importJobRows.createdAt, cutoff),
            inArray(importJobRows.workspaceId, tenantWorkspaceIds),
          ),
        )
        .limit(batchSize);
      const deleted = await reader
        .delete(importJobRows)
        .where(inArray(importJobRows.id, expired))
        .returning({ id: importJobRows.id });
      return deleted.length;
    },
  },
  // Direct tenant_id; age on created_at (the Data Health trend store; schema/dataQualitySnapshots.ts).
  data_quality_snapshots: {
    table: "data_quality_snapshots",
    agingColumn: "created_at",
    tenantScope: "tenant_column",
    countExpired: (reader, tenantId, cutoff) =>
      scalarCount(
        reader
          .select({ value: count() })
          .from(dataQualitySnapshots)
          .where(
            and(
              lt(dataQualitySnapshots.createdAt, cutoff),
              eq(dataQualitySnapshots.tenantId, tenantId),
            ),
          ),
      ),
    // LOCKSTEP with countExpired above — IDENTICAL WHERE: created_at < cutoff AND tenant_id = $t.
    deleteExpired: async (reader, tenantId, cutoff, batchSize) => {
      const expired = reader
        .select({ id: dataQualitySnapshots.id })
        .from(dataQualitySnapshots)
        .where(
          and(
            lt(dataQualitySnapshots.createdAt, cutoff),
            eq(dataQualitySnapshots.tenantId, tenantId),
          ),
        )
        .limit(batchSize);
      const deleted = await reader
        .delete(dataQualitySnapshots)
        .where(inArray(dataQualitySnapshots.id, expired))
        .returning({ id: dataQualitySnapshots.id });
      return deleted.length;
    },
  },
  // Direct tenant_id; age on created_at (the re-verification audit ledger; schema/verificationJobs.ts).
  verification_jobs: {
    table: "verification_jobs",
    agingColumn: "created_at",
    tenantScope: "tenant_column",
    countExpired: (reader, tenantId, cutoff) =>
      scalarCount(
        reader
          .select({ value: count() })
          .from(verificationJobs)
          .where(
            and(lt(verificationJobs.createdAt, cutoff), eq(verificationJobs.tenantId, tenantId)),
          ),
      ),
    // LOCKSTEP with countExpired above — IDENTICAL WHERE: created_at < cutoff AND tenant_id = $t.
    deleteExpired: async (reader, tenantId, cutoff, batchSize) => {
      const expired = reader
        .select({ id: verificationJobs.id })
        .from(verificationJobs)
        .where(and(lt(verificationJobs.createdAt, cutoff), eq(verificationJobs.tenantId, tenantId)))
        .limit(batchSize);
      const deleted = await reader
        .delete(verificationJobs)
        .where(inArray(verificationJobs.id, expired))
        .returning({ id: verificationJobs.id });
      return deleted.length;
    },
  },
};

/** Type guard: is `dataClass` one of the v1 classes this phase counts (i.e. has a wired count)? */
export function isRetentionV1Class(dataClass: RetentionDataClass): dataClass is RetentionV1Class {
  return Object.hasOwn(retentionClassMeta, dataClass);
}

export const retentionScanRepository = {
  /** The fixed per-class table/aging/scope mapping (re-exported on the repo for convenience; phase 3 reuse). */
  classMeta: retentionClassMeta,

  /**
   * Count THIS tenant's rows older than `cutoff` for one v1 data class — the SHADOW sweep's candidate volume.
   * Runs on the OWNER connection (`db` by default, or a passed owner `reader`/Tx) and ALWAYS carries an explicit
   * tenant predicate (never relies on RLS for this cross-tenant system read). COUNT only — no delete/update.
   * Throws for a non-v1 class (no count wired) or a missing tenantId (guards against an accidental cross-tenant
   * count).
   */
  async countExpiredByClass(
    input: { dataClass: RetentionDataClass; tenantId: string; cutoff: Date },
    reader: OwnerReader = db,
  ): Promise<number> {
    if (!input.tenantId) {
      throw new Error(
        "retentionScanRepository.countExpiredByClass: tenantId is required (never count across tenants)",
      );
    }
    if (!isRetentionV1Class(input.dataClass)) {
      throw new Error(
        `retentionScanRepository.countExpiredByClass: ${input.dataClass} is not a v1 retention class (no count wired)`,
      );
    }
    return retentionClassMeta[input.dataClass].countExpired(reader, input.tenantId, input.cutoff);
  },

  /**
   * DELETE this tenant's rows older than `cutoff` for one v1 data class — the ENFORCE-mode purge. Mirrors
   * idempotencyRepository.deleteExpired: a batched `DELETE … WHERE id IN (SELECT id … LIMIT batchSize) RETURNING
   * id`, drained in a loop (≤ `batchSize` per statement) until a sub-batch comes back short — so a large purge
   * never long-locks the table. Runs on the OWNER connection (`db` by default, or a passed owner `reader`/Tx) and
   * ALWAYS carries the SAME explicit tenant predicate + SAME aging predicate as `countExpiredByClass` (LOCKSTEP —
   * the delete targets exactly the counted rows). Returns the TOTAL rows deleted across all batches.
   *
   * THIS METHOD IS NOT ITSELF A GATE: the double-gate (per-tenant `retention_engine_enabled` flag + per-class
   * `enforce` mode) is enforced UPSTREAM in the sweep (core/retention/runRetentionSweep.ts) — the sweep only calls
   * this for an enforce-mode class on a flag-enabled tenant. Throws for a non-v1 class (no deleter wired) or a
   * missing tenantId (guards against an accidental cross-tenant purge).
   */
  async deleteExpiredByClass(
    input: { dataClass: RetentionDataClass; tenantId: string; cutoff: Date },
    reader: OwnerReader = db,
    batchSize = 5000,
  ): Promise<number> {
    if (!input.tenantId) {
      throw new Error(
        "retentionScanRepository.deleteExpiredByClass: tenantId is required (never delete across tenants)",
      );
    }
    if (!isRetentionV1Class(input.dataClass)) {
      throw new Error(
        `retentionScanRepository.deleteExpiredByClass: ${input.dataClass} is not a v1 retention class (no deleter wired)`,
      );
    }
    const { deleteExpired } = retentionClassMeta[input.dataClass];
    let total = 0;
    // Drain in batches (idempotencyRepository.deleteExpired pattern): each pass deletes ≤ batchSize rows; stop
    // when a sub-batch returns fewer than batchSize (nothing older than the cutoff is left for this tenant).
    for (;;) {
      const deleted = await deleteExpired(reader, input.tenantId, input.cutoff, batchSize);
      total += deleted;
      if (deleted < batchSize) break;
    }
    return total;
  },

  /**
   * Enumerate ACTIVE tenants for the fleet sweep — a system-level, non-PII, OWNER-connection read mirroring the
   * contactRepository.listWorkspacesWith* enumerations (the retention sweep fans out per TENANT, since the engine
   * flag + the run audit are tenant-scoped). Capped by `limit`; the per-tenant flag gate INSIDE the sweep skips
   * any tenant that hasn't enabled the engine, so listing every active tenant here is harmless.
   */
  async listActiveTenants(limit = 1000): Promise<string[]> {
    const rows = (await db.execute(
      sql`SELECT id FROM tenants WHERE status = 'active' ORDER BY id LIMIT ${limit}`,
    )) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  },
};
