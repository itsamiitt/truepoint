// retentionScanRepository.ts — the COUNT layer for the per-data-class RETENTION engine (data-management backlog
// #6, phase 2; design 16-retention-engine-design.md §3/§5). It answers ONE safe question per class: "how many rows
// for THIS tenant are older than the cutoff?" — the candidate volume the SHADOW sweep records as evidence BEFORE
// any class is ever flipped to `enforce`. CRITICAL SAFETY: this layer COUNTS ONLY. There is NO DELETE/UPDATE here
// against any data-class table (enforce-mode deleters are phase 3) — `countExpired` only ever issues
// `SELECT count(*) … WHERE <aging> < cutoff AND <tenant scope>`.
//
// ACCESS MODEL: a retention sweep is a CROSS-TENANT SYSTEM read, so the count runs on the OWNER connection (the
// base `db`, RLS-exempt — or a passed owner Tx). It must therefore NEVER rely on RLS for isolation; EVERY count
// carries an EXPLICIT tenant predicate (a direct `tenant_id = $t`, or a join to workspaces where `tenant_id = $t`
// for the high-volume *_rows ledgers that carry only a denormalized workspace_id). A count with no tenant
// predicate would count across tenants — so the predicate is baked into each per-class closure, never optional.
//
// The per-class META (table, aging column, tenant-scope path, count closure) is the single fixed mapping; the
// table/column identifiers come ONLY from the typed Drizzle schema (never caller input), and every value (cutoff,
// tenantId) is BOUND, never string-interpolated. `retentionClassMeta` is exported so phase 3 reuses the same
// table/aging/scope mapping for the batched deleters.

import type { RetentionDataClass } from "@leadwolf/types";
import { and, count, eq, lt, sql } from "drizzle-orm";
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

/** The fixed per-class mapping the COUNT layer is driven by. `table`/`agingColumn`/`tenantScope` are the physical
 *  description phase 3's deleters reuse; `countExpired` is the safe, explicit, tenant-scoped count (no delete). */
export interface RetentionClassMeta {
  /** The physical table the class lives in (documentation + the phase-3 deleter target). */
  readonly table: string;
  /** The physical aging column the cutoff compares against — rows with `agingColumn < cutoff` are candidates. */
  readonly agingColumn: string;
  /** How the explicit tenant predicate is carried (a direct tenant_id, or a workspaces join). */
  readonly tenantScope: RetentionTenantScope;
  /** COUNT the rows OLDER than `cutoff` for `tenantId` on the OWNER connection, ALWAYS carrying an explicit
   *  tenant predicate. Counting only — there is NO delete/update anywhere in this closure. */
  readonly countExpired: (reader: OwnerReader, tenantId: string, cutoff: Date) => Promise<number>;
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
