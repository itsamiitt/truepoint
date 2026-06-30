// platformDataQualityReads.ts — read-only cross-tenant Data-Quality observability for the platform-admin DQ
// cockpit (10 §5 Data Health, PLAN_06 re-verification). Runs inside the audited withPlatformTx (owner connection,
// bypasses RLS) so it sees every tenant. Aggregates the per-workspace data_quality_snapshots (the LATEST snapshot
// per workspace) + the verification_jobs re-verification ledger. SUM/COUNT only — NON-PII (counts, never contact
// rows). Mirrors platformBillingReads (the sibling cross-tenant read repo + its typecheck-safe raw-query shape).

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Platform-wide rollup of the LATEST data-quality snapshot per workspace (counts; the api derives the fill /
 *  validity / freshness RATES). */
export interface DataQualityRollup {
  workspaces: number;
  latestAt: Date | null;
  total: number;
  withEmail: number;
  withPhone: number;
  emailValid: number;
  fresh: number;
  stale: number;
  neverVerified: number;
}

/** One recent re-verification run (non-PII counts), joined to the tenant name. */
export interface VerificationRunRow {
  tenantId: string;
  tenantName: string;
  finishedAt: Date;
  scanned: number;
  reverified: number;
  errored: number;
}

/** Windowed totals across the re-verification ledger. */
export interface VerificationTotals {
  runs: number;
  scanned: number;
  reverified: number;
  errored: number;
}

export const platformDataQualityReadRepository = {
  /** SUM the LATEST snapshot per workspace across all tenants. DISTINCT ON keeps one (newest) row per workspace,
   *  then the outer aggregate sums the JSONB count fields. Bounded by snapshot cardinality (one row per ws). */
  async rollup(tx: Tx): Promise<DataQualityRollup> {
    const [r] = (await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (workspace_id) workspace_id, metrics, created_at
        FROM data_quality_snapshots
        ORDER BY workspace_id, created_at DESC
      )
      SELECT
        count(*)::bigint                                               AS workspaces,
        max(created_at)                                                AS latest_at,
        coalesce(sum((metrics->>'total')::bigint), 0)::bigint         AS total,
        coalesce(sum((metrics->>'withEmail')::bigint), 0)::bigint     AS with_email,
        coalesce(sum((metrics->>'withPhone')::bigint), 0)::bigint     AS with_phone,
        coalesce(sum((metrics->>'emailValid')::bigint), 0)::bigint    AS email_valid,
        coalesce(sum((metrics->>'fresh')::bigint), 0)::bigint         AS fresh,
        coalesce(sum((metrics->>'stale')::bigint), 0)::bigint         AS stale,
        coalesce(sum((metrics->>'neverVerified')::bigint), 0)::bigint AS never_verified
      FROM latest
    `)) as unknown as Array<{
      workspaces: number;
      latest_at: string | null;
      total: number;
      with_email: number;
      with_phone: number;
      email_valid: number;
      fresh: number;
      stale: number;
      never_verified: number;
    }>;
    return {
      workspaces: Number(r?.workspaces ?? 0),
      latestAt: r?.latest_at ? new Date(r.latest_at) : null,
      total: Number(r?.total ?? 0),
      withEmail: Number(r?.with_email ?? 0),
      withPhone: Number(r?.with_phone ?? 0),
      emailValid: Number(r?.email_valid ?? 0),
      fresh: Number(r?.fresh ?? 0),
      stale: Number(r?.stale ?? 0),
      neverVerified: Number(r?.never_verified ?? 0),
    };
  },

  /** Recent re-verification runs across all tenants, joined to the tenant name, newest first, bounded. */
  async recentVerificationRuns(tx: Tx, limit: number): Promise<VerificationRunRow[]> {
    const rows = (await tx.execute(sql`
      SELECT
        v.tenant_id::text AS tenant_id,
        t.name            AS tenant_name,
        v.finished_at     AS finished_at,
        v.scanned         AS scanned,
        v.reverified      AS reverified,
        v.errored         AS errored
      FROM verification_jobs v
      LEFT JOIN tenants t ON t.id = v.tenant_id
      ORDER BY v.created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      tenant_id: string;
      tenant_name: string | null;
      finished_at: string;
      scanned: number;
      reverified: number;
      errored: number;
    }>;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name ?? "—",
      finishedAt: new Date(r.finished_at),
      scanned: Number(r.scanned),
      reverified: Number(r.reverified),
      errored: Number(r.errored),
    }));
  },

  /** Windowed totals over the re-verification ledger (run count + scanned/reverified/errored sums). */
  async verificationTotals(tx: Tx, since: Date): Promise<VerificationTotals> {
    const iso = since.toISOString();
    const [r] = (await tx.execute(sql`
      SELECT
        count(*)::bigint                     AS runs,
        coalesce(sum(scanned), 0)::bigint    AS scanned,
        coalesce(sum(reverified), 0)::bigint AS reverified,
        coalesce(sum(errored), 0)::bigint    AS errored
      FROM verification_jobs
      WHERE created_at >= ${iso}::timestamptz
    `)) as unknown as Array<{ runs: number; scanned: number; reverified: number; errored: number }>;
    return {
      runs: Number(r?.runs ?? 0),
      scanned: Number(r?.scanned ?? 0),
      reverified: Number(r?.reverified ?? 0),
      errored: Number(r?.errored ?? 0),
    };
  },
};
