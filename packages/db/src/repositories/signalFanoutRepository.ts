// signalFanoutRepository.ts — the OWNER-connection census side of the signal fan-out sweep
// (market-intelligence MI-S6; docs/planning/market-intelligence/06-architecture.md §2). Outcomes:
// [S-13][S-09]. The jobChangeSweepRepository twin, for company-subject signals.
//
// Two reads, both SYSTEM-only (never reachable from a tenant request), both non-PII by construction:
// a company signal describes an organization, and the census returns tenancy ids only — enumerating
// which tenants hold a given company is a cross-tenant read no tenant role may perform (the C-02
// boundary). The tenant-side WRITE lives in tenantSignalsRepository and runs under RLS.

import { sql } from "drizzle-orm";
import { db } from "../client.ts";

export interface FanoutSignal {
  id: string;
  /** The Layer-0 company the signal is about. */
  masterCompanyId: string;
  typeCode: string;
  family: string;
  headline: string | null;
  amountMinor: number | null;
  currency: string | null;
  observedAt: Date;
}

export interface FanoutWorkspace {
  tenantId: string;
  workspaceId: string;
}

export const signalFanoutRepository = {
  /**
   * Company-subject signals RECORDED since the watermark, oldest first. Watermarked on recorded_at
   * (transaction time), not observed_at: a late-arriving backfill of an old event must still fan out,
   * and recorded_at is monotonic per the append-only write path.
   */
  async listNewCompanySignals(since: Date, limit = 500): Promise<FanoutSignal[]> {
    const rows = (await db.execute(
      sql`SELECT s.id, s.subject_id, s.type_code, t.family, s.headline,
                 s.amount_minor, s.currency, s.observed_at
            FROM master_signals s
            JOIN master_signal_types t ON t.code = s.type_code
           WHERE s.subject_type = 'company'
             AND s.recorded_at > ${since.toISOString()}::timestamptz
           ORDER BY s.recorded_at ASC
           LIMIT ${limit}`,
    )) as unknown as Array<{
      id: string;
      subject_id: string;
      type_code: string;
      family: string;
      headline: string | null;
      amount_minor: number | null;
      currency: string | null;
      observed_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      masterCompanyId: r.subject_id,
      typeCode: r.type_code,
      family: r.family,
      headline: r.headline,
      amountMinor: r.amount_minor,
      currency: r.currency,
      observedAt: new Date(r.observed_at),
    }));
  },

  /**
   * Workspaces holding a live account bridged to any of these companies. Ids only, capped — the census
   * pattern. The per-workspace account resolution happens tenant-side under RLS, so this list is a
   * routing table, never a data payload.
   */
  async listWorkspacesForCompanies(
    masterCompanyIds: readonly string[],
    limit = 1000,
  ): Promise<FanoutWorkspace[]> {
    if (masterCompanyIds.length === 0) return [];
    const idParams = sql.join(
      masterCompanyIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = (await db.execute(
      sql`SELECT DISTINCT a.tenant_id, a.workspace_id
            FROM accounts a
           WHERE a.master_company_id = ANY(ARRAY[${idParams}]::uuid[])
             AND a.deleted_at IS NULL
           LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },
};
