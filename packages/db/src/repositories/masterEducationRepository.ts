// masterEducationRepository.ts — Layer-0 data access for the person↔organization EDUCATION edge
// (migration 0108). Always called inside withErTx (the least-privilege leadwolf_er role): these tables are
// system-owned and NOT RLS-scoped, so there are no tenant GUCs and the customer app role holds no grant.
//
// Mirrors masterTechnologyRepository's shape: the caller owns the transaction, every write converges under
// concurrency, and nothing here decides policy — it executes it.
//
// ALUMNUS IS A DATE PREDICATE, NOT A COLUMN. `listAlumni` filters on ended_on rather than reading a stored
// flag, because a stored flag is invalidated by the passage of time alone. See the table header.
//
// ⚠ CONTRACT FOR THE FUTURE PRODUCER (CLAUDE.md rule 5 — read before wiring an ingestion path to this file).
// `recordEducation` writes the EDGE only. It does not append provenance, exactly as masterGraphRepository
// does not: the caller owns the transaction and therefore owns the full write-set. A path that ingests
// education MUST, in the SAME withErTx:
//   1. append the source payload via evidenceRepository.appendSourceRecord (content_hash = idempotency), and
//   2. append field-grain assertions via evidenceRepository.appendProvenanceEvents for the fields it claims
//      (school, degree, fields_of_study, dates), carrying the lawful basis for the source,
// then call recordEducation. An edge written without those two is a fact with no traceable basis, which is
// the one thing this schema exists to prevent — and A-01 is not satisfiable retroactively.
//
// STATUS: no producer exists yet. Education is not carried by any connector, provider adapter, or forge
// parser today (verified by grep across packages/types ingestion, forge-core and the enrichment adapters),
// so this repository is currently read-only in practice: the API/UI render what a future ingest writes.
// Extending the EXTENSION to capture it is not a free choice — hard-constraint 4 and the compliance
// checklist govern what may be captured, and that is a human decision, not an implementation detail.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface RecordEducationInput {
  masterPersonId: string;
  /** NULL until ER resolves the school — the raw name carries the assertion in the meantime. */
  masterCompanyId?: string | null;
  schoolNameRaw?: string | null;
  /** Must be produced by the SAME normalizer that writes master_companies.name_normalized. */
  schoolNameNormalized?: string | null;
  degree?: string | null;
  fieldsOfStudy?: string[] | null;
  /** Month/day precision as the source gave it; omit for "start unknown" (the '-infinity' sentinel). */
  startedOn?: string | null;
  endedOn?: string | null;
  assertingSource?: string | null;
  matchMethod?: string | null;
  confidence?: number | null;
  observedAt?: Date | null;
}

export interface EducationRow {
  id: string;
  masterCompanyId: string | null;
  schoolName: string | null;
  orgKind: string | null;
  degree: string | null;
  fieldsOfStudy: string[] | null;
  startedOn: string | null;
  endedOn: string | null;
  confidence: string | null;
  sourceCount: number;
}

/**
 * Record (or converge on) one education stint.
 *
 * Concurrency: ON CONFLICT DO UPDATE against uniq_education_stint — two ingests of the same stint converge on
 * one row and bump source_count rather than one of them failing or duplicating. Unresolved stints (no
 * master_company_id) take the parallel uniq_education_unresolved_stint path, which is why the conflict target
 * is chosen by whether the school resolved.
 */
export async function recordEducation(tx: Tx, input: RecordEducationInput): Promise<string | null> {
  const startedOn = input.startedOn ?? "-infinity";

  // The conflict target must match whichever partial unique applies, so the two cases are written out
  // rather than unified behind a clever COALESCE — a wrong target silently degrades to "always insert".
  // `sql.param(...)::text[]` on the fields_of_study binds below is REQUIRED, not defensive. Drizzle's sql
  // template SPREADS a plain JS array into one bind per element, so `${"${['Computer Science']}"}` arrives as
  // the bare string "Computer Science" and Postgres rejects it with 22P02 ("Array value must start with {").
  // sql.param binds the whole array as ONE parameter; the cast then types it. Verified against the dialect
  // offline. sql.param(null) still binds a single null, so the unset case is unaffected.
  if (input.masterCompanyId) {
    const rows = (await tx.execute(sql`
      INSERT INTO master_education (
        master_person_id, master_company_id, school_name_raw, school_name_normalized,
        degree, fields_of_study, started_on, ended_on,
        asserting_source, match_method, confidence, observed_at
      ) VALUES (
        ${input.masterPersonId}, ${input.masterCompanyId}, ${input.schoolNameRaw ?? null},
        ${input.schoolNameNormalized ?? null}, ${input.degree ?? null},
        ${sql.param(input.fieldsOfStudy ?? null)}::text[], ${startedOn}, ${input.endedOn ?? null},
        ${input.assertingSource ?? null}, ${input.matchMethod ?? null},
        ${input.confidence ?? null}, ${input.observedAt ?? null}
      )
      ON CONFLICT (master_person_id, master_company_id, started_on)
        WHERE master_company_id IS NOT NULL
      DO UPDATE SET
        degree           = COALESCE(EXCLUDED.degree, master_education.degree),
        fields_of_study  = COALESCE(EXCLUDED.fields_of_study, master_education.fields_of_study),
        ended_on         = COALESCE(EXCLUDED.ended_on, master_education.ended_on),
        source_count     = master_education.source_count + 1,
        confidence       = GREATEST(COALESCE(EXCLUDED.confidence, 0), COALESCE(master_education.confidence, 0)),
        updated_at       = now()
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  }

  if (!input.schoolNameNormalized) return null; // no institution at all — the CHECK would reject it anyway

  const rows = (await tx.execute(sql`
    INSERT INTO master_education (
      master_person_id, school_name_raw, school_name_normalized,
      degree, fields_of_study, started_on, ended_on,
      asserting_source, match_method, confidence, observed_at
    ) VALUES (
      ${input.masterPersonId}, ${input.schoolNameRaw ?? null}, ${input.schoolNameNormalized},
      ${input.degree ?? null}, ${sql.param(input.fieldsOfStudy ?? null)}::text[], ${startedOn}, ${input.endedOn ?? null},
      ${input.assertingSource ?? null}, ${input.matchMethod ?? null},
      ${input.confidence ?? null}, ${input.observedAt ?? null}
    )
    ON CONFLICT (master_person_id, school_name_normalized, started_on)
      WHERE master_company_id IS NULL AND school_name_normalized IS NOT NULL
    DO UPDATE SET
      source_count = master_education.source_count + 1,
      updated_at   = now()
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** "Where did this person study" — the person-profile read. */
export async function listPersonEducation(
  tx: Tx,
  masterPersonId: string,
  limit = 50,
): Promise<EducationRow[]> {
  const rows = (await tx.execute(sql`
    SELECT e.id, e.master_company_id, e.degree, e.fields_of_study,
           e.started_on, e.ended_on, e.confidence, e.source_count,
           COALESCE(c.name, e.school_name_raw) AS school_name,
           c.org_kind
      FROM master_education e
      LEFT JOIN master_companies c ON c.id = e.master_company_id
     WHERE e.master_person_id = ${masterPersonId}
     ORDER BY e.ended_on DESC NULLS FIRST
     LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    master_company_id: string | null;
    school_name: string | null;
    org_kind: string | null;
    degree: string | null;
    fields_of_study: string[] | null;
    started_on: string | null;
    ended_on: string | null;
    confidence: string | null;
    source_count: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    masterCompanyId: r.master_company_id,
    schoolName: r.school_name,
    orgKind: r.org_kind,
    degree: r.degree,
    fieldsOfStudy: r.fields_of_study,
    startedOn: r.started_on,
    endedOn: r.ended_on,
    confidence: r.confidence,
    sourceCount: r.source_count,
  }));
}

/**
 * "Who are the alumni of this school" — the reverse traversal.
 *
 * `status` is a DATE PREDICATE, not a column read: 'completed' means ended_on is in the past (alumnus),
 * 'current' means it is null or still ahead. Nothing about a person changes on graduation day except the
 * calendar, which is exactly why this is not stored.
 */
export async function listAlumni(
  tx: Tx,
  masterCompanyId: string,
  opts: { status?: "completed" | "current" | "all"; limit?: number } = {},
): Promise<Array<{ masterPersonId: string; degree: string | null; endedOn: string | null }>> {
  const status = opts.status ?? "completed";
  const statusFilter =
    status === "completed"
      ? sql`AND e.ended_on IS NOT NULL AND e.ended_on <= CURRENT_DATE`
      : status === "current"
        ? sql`AND (e.ended_on IS NULL OR e.ended_on > CURRENT_DATE)`
        : sql``;

  const rows = (await tx.execute(sql`
    SELECT e.master_person_id, e.degree, e.ended_on
      FROM master_education e
     WHERE e.master_company_id = ${masterCompanyId} ${statusFilter}
     ORDER BY e.ended_on DESC NULLS LAST
     LIMIT ${Math.min(opts.limit ?? 100, 500)}
  `)) as unknown as Array<{
    master_person_id: string;
    degree: string | null;
    ended_on: string | null;
  }>;

  return rows.map((r) => ({
    masterPersonId: r.master_person_id,
    degree: r.degree,
    endedOn: r.ended_on,
  }));
}

export const masterEducationRepository = {
  recordEducation,
  listPersonEducation,
  listAlumni,
};
