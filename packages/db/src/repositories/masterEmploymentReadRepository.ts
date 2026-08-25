// masterEmploymentReadRepository.ts — the READ side of the person↔organization employment edge (plan 33 · A2).
//
// Always called inside withErTx: master_employment is system-owned and leadwolf_app holds no grant. The
// caller passes a master_person_id it has ALREADY proven access to via contactRepository.getMasterPersonBridge.
//
// Kept separate from masterGraphRepository, which owns the WRITE path (resolveForImport and its co-op-safe
// mints). Mixing a customer-facing read into that module would put a hot request-path query beside the
// ingest-critical resolver, and the two have different failure appetites.
//
// ⚠ WHAT THIS DATA ACTUALLY LOOKS LIKE TODAY (read before designing a UI on it). The live import path mints
// a BARE edge — person, company, is_current, is_primary — and nothing more. `title`, `started_on` and
// `ended_on` are nullable and, for import-sourced rows, usually NULL. A timeline UI over this renders a
// column of blank dates and looks broken rather than sparse, which is why plan 33 §A2 specifies the honest
// company-list form until an enrichment provider populates the stint payload.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface EmploymentStintRow {
  /** See COMPANY_GROUP below — an opaque per-response company token, safe to ship. */
  groupKey: string;
  companyName: string | null;
  orgKind: string | null;
  title: string | null;
  department: string | null;
  seniorityLevel: string | null;
  startedOn: string | null;
  endedOn: string | null;
  isCurrent: boolean;
  isPrimary: boolean;
  confidence: string | null;
  sourceCount: number;
}

/**
 * A stable, opaque token identifying the COMPANY a stint belongs to, so a client can group the promotion
 * ("Finance Manager" then "Finance Director" at one employer) under one company block. [S-09]
 *
 * It is a `dense_rank` over the company identity rather than that identity itself, and the difference is the
 * point: `master_company_id` is a Layer-0 identifier that deliberately never crosses the API boundary, and a
 * salted hash of it would still be a per-install-stable handle on a graph node. A rank is an ordinal WITHIN
 * ONE RESPONSE — it carries no information about the company beyond "these rows are the same one", which is
 * exactly and only what grouping needs. Nothing else can be recovered from it.
 *
 * The fallback leg matters as much as the primary: `master_company_id` is nullable (an unresolved employer),
 * and those rows group on `company_name_normalized` — the citext, legal-suffix-stripped name. Grouping on
 * the DISPLAY name instead would merge two distinct companies that share a name and split one company
 * written two ways.
 */
const COMPANY_GROUP = sql`'g' || dense_rank() OVER (
  ORDER BY COALESCE(me.master_company_id::text, 'name:' || me.company_name_normalized)
)`;

/**
 * Every employment stint we hold for one person, current first.
 *
 * `started_on` carries a '-infinity' sentinel meaning "start unknown" (it exists so two unknown-start
 * assertions COLLIDE and dedup rather than accumulate). That sentinel is a storage detail and is normalized
 * to null here — the API must never ship it, and no UI should learn to special-case it.
 */
export async function listPersonEmployment(
  tx: Tx,
  masterPersonId: string,
  limit = 50,
): Promise<EmploymentStintRow[]> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(mc.name, me.company_name_raw) AS company_name,
           ${COMPANY_GROUP} AS group_key,
           mc.org_kind,
           me.title, me.department, me.seniority_level,
           CASE WHEN me.started_on = '-infinity'::date THEN NULL ELSE me.started_on END AS started_on,
           me.ended_on, me.is_current, me.is_primary, me.confidence, me.source_count
      FROM master_employment me
      LEFT JOIN master_companies mc ON mc.id = me.master_company_id
     WHERE me.master_person_id = ${masterPersonId}
     ORDER BY me.is_current DESC, me.is_primary DESC, me.started_on DESC NULLS LAST
     LIMIT ${limit}
  `)) as unknown as Array<{
    company_name: string | null;
    group_key: string;
    org_kind: string | null;
    title: string | null;
    department: string | null;
    seniority_level: string | null;
    started_on: string | null;
    ended_on: string | null;
    is_current: boolean;
    is_primary: boolean;
    confidence: string | null;
    source_count: number;
  }>;

  return rows.map((r) => ({
    groupKey: r.group_key,
    companyName: r.company_name,
    orgKind: r.org_kind,
    title: r.title,
    department: r.department,
    seniorityLevel: r.seniority_level,
    startedOn: r.started_on,
    endedOn: r.ended_on,
    isCurrent: r.is_current,
    isPrimary: r.is_primary,
    confidence: r.confidence,
    sourceCount: r.source_count,
  }));
}

export const masterEmploymentReadRepository = { listPersonEmployment };
