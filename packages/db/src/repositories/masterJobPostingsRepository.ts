// masterJobPostingsRepository.ts — Layer-0 data access for the hiring-intelligence evidence table
// (migration 0127; market-intelligence MI-S1). Always called inside withErTx (leadwolf_er): system-owned
// table, isolated by access path. Caller owns the transaction — the masterProfileRepository contract.
//
// The WRITER exists ahead of its producer (D-6 feed procurement) — the master_company_funding posture:
// when the feed lands, ingest is wiring, not schema work. A posting is STATE, not an event: the upsert
// refreshes last_seen_at/closed_at in place on the (company, source, canonical_url) identity; surge
// SIGNALS are the ingest sweep's job (master_signals), never derived here.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface JobPostingInput {
  masterCompanyId: string;
  sourceName: string;
  canonicalUrl: string;
  title: string;
  department?: string | null;
  seniorityLevel?: string | null;
  location?: string | null;
  postedAt?: string | null; // ISO date
  closedAt?: string | null;
  evidenceRef?: string | null;
  observedAt: Date;
}

export interface JobPostingRow {
  title: string;
  department: string | null;
  seniorityLevel: string | null;
  location: string | null;
  postedAt: string | null;
  closedAt: string | null;
}

export const masterJobPostingsRepository = {
  /** Idempotent per (company, source, canonical_url): a re-sync refreshes the living fields in place. */
  async upsertPosting(tx: Tx, input: JobPostingInput): Promise<{ created: boolean }> {
    const rows = (await tx.execute(
      sql`INSERT INTO master_job_postings
            (master_company_id, source_name, canonical_url, title, department, seniority_level,
             location, posted_at, closed_at, evidence_ref, observed_at)
          VALUES
            (${input.masterCompanyId}::uuid, ${input.sourceName}, ${input.canonicalUrl},
             ${input.title}, ${input.department ?? null}, ${input.seniorityLevel ?? null},
             ${input.location ?? null}, ${input.postedAt ?? null}, ${input.closedAt ?? null},
             ${input.evidenceRef ?? null}, ${input.observedAt.toISOString()}::timestamptz)
          ON CONFLICT (master_company_id, source_name, canonical_url)
          DO UPDATE SET title = EXCLUDED.title,
                        department = EXCLUDED.department,
                        seniority_level = EXCLUDED.seniority_level,
                        location = EXCLUDED.location,
                        posted_at = coalesce(EXCLUDED.posted_at, master_job_postings.posted_at),
                        closed_at = EXCLUDED.closed_at,
                        observed_at = EXCLUDED.observed_at,
                        last_seen_at = now()
          RETURNING (first_seen_at = last_seen_at) AS created`,
    )) as unknown as Array<{ created: boolean }>;
    return { created: rows[0]?.created ?? false };
  },

  /** Open postings for one company, newest-first (the /accounts/:id/postings read). */
  async listOpenForCompany(tx: Tx, masterCompanyId: string, limit = 50): Promise<JobPostingRow[]> {
    const rows = (await tx.execute(
      sql`SELECT title, department, seniority_level, location,
                 posted_at::text AS posted_at, closed_at::text AS closed_at
            FROM master_job_postings
           WHERE master_company_id = ${masterCompanyId}::uuid
             AND closed_at IS NULL
           ORDER BY posted_at DESC NULLS LAST
           LIMIT ${Math.min(limit, 200)}`,
    )) as unknown as Array<{
      title: string;
      department: string | null;
      seniority_level: string | null;
      location: string | null;
      posted_at: string | null;
      closed_at: string | null;
    }>;
    return rows.map((r) => ({
      title: r.title,
      department: r.department,
      seniorityLevel: r.seniority_level,
      location: r.location,
      postedAt: r.posted_at,
      closedAt: r.closed_at,
    }));
  },

  /** Open-role counts by department for one company (the summary strip + surge detection input). */
  async countOpenByDepartment(
    tx: Tx,
    masterCompanyId: string,
  ): Promise<Array<{ department: string | null; count: number }>> {
    const rows = (await tx.execute(
      sql`SELECT department, count(*)::int AS n
            FROM master_job_postings
           WHERE master_company_id = ${masterCompanyId}::uuid AND closed_at IS NULL
           GROUP BY department
           ORDER BY n DESC`,
    )) as unknown as Array<{ department: string | null; n: number }>;
    return rows.map((r) => ({ department: r.department, count: r.n }));
  },
};
