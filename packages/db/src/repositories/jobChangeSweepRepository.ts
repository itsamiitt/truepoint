// jobChangeSweepRepository.ts — data access for the S-13 job-change fan-out sweep (intelligence-platform
// 07 §4 slice 7.1). The DISTRIBUTION step of the contribution lifecycle: a fact learned once in the shared
// graph (master_employment) reaching every tenant that holds the affected person.
//
// TWO CONNECTION CLASSES, and the split is a C-02 boundary rather than a convenience:
//   • the CENSUS is cross-tenant by construction ("which workspaces hold this person"), which no tenant role
//     may ask. It runs on the OWNER connection, returns ONLY non-PII ids, is limit-capped, and is reachable
//     from the sweep worker alone — never from a request. Mirrors listWorkspacesWithChannelDrift.
//   • the CANDIDATE READ runs inside the caller's withTenantTx with RLS enforcing, like every other
//     tenant-scoped read. The sweep never writes on the owner connection.
//
// Layer-0 (master_employment) is REVOKE'd from leadwolf_app, so the candidate read joins it on the owner
// connection is NOT an option — instead the observed claim is carried INTO the tenant tx by the caller, which
// is why loadJobChangeCandidates takes the master ids it was censused with rather than re-deriving them.

import { sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";

/** One workspace with at least one contact whose Layer-0 employment moved since the watermark. */
export interface JobChangeWorkspace {
  tenantId: string;
  workspaceId: string;
}

/** The Layer-0 side of the comparison: what the shared graph now says about this person's primary stint. */
export interface ObservedEmployment {
  masterPersonId: string;
  masterCompanyId: string | null;
  title: string | null;
  /** master_employment.match_method — feeds METHOD_PRIOR. */
  matchMethod: string | null;
  /** Whole days since observed_at (VALID time), or null when the source never dated its claim. */
  ageDays: number | null;
  /** master_employment.source_count — independent corroboration, not raw event count. */
  sourceCount: number;
  /** Resolved employer display name, for alert copy. Null when ER has not resolved the employer yet. */
  companyName: string | null;
}

/** The Layer-1 side: what this tenant currently believes, plus the label the alert needs. */
export interface JobChangeCandidate {
  contactId: string;
  masterPersonId: string;
  /** The believed employer, as a Layer-0 id, read from the contact's ACCOUNT — `contacts` carries only
   *  master_person_id; master_company_id lives on `accounts`. Null when the contact has no account. */
  masterCompanyId: string | null;
  jobTitle: string | null;
  /** Days since the contact was last verified; the prior claim's age. Null = never verified. */
  priorAgeDays: number | null;
  /** Display name for the alert. Name only — never an email or phone. */
  label: string;
}

export const jobChangeSweepRepository = {
  /**
   * SYSTEM census: workspaces holding a live contact whose linked master person has a primary employment
   * edge updated since `since`. OWNER connection, non-PII ids only, limit-capped — the
   * listWorkspacesWithChannelDrift twin. NOT reachable from a tenant request.
   *
   * Watermarked on master_employment.updated_at (transaction time), NOT on a drift predicate: the sweep
   * writes a signal without mutating the contact, so a predicate would never drain and would re-fire every
   * tick. Time-bounding it is what makes steady-state work proportional to CHANGES rather than to corpus size.
   */
  async listWorkspacesWithEmploymentChanges(
    since: Date,
    limit = 1000,
  ): Promise<JobChangeWorkspace[]> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT c.tenant_id, c.workspace_id
            FROM contacts c
            JOIN master_employment me ON me.master_person_id = c.master_person_id
           WHERE c.deleted_at IS NULL
             AND c.master_person_id IS NOT NULL
             AND me.is_primary
             AND me.is_current
             AND me.updated_at > ${since}::timestamptz
           LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  /**
   * SYSTEM read of the Layer-0 side, scoped to ONE workspace's people. OWNER connection because
   * master_employment is Layer 0 (REVOKE'd from leadwolf_app by design) — but it returns employment FACTS
   * only: no contact points, no contributor_ref, nothing tenant-scoped. The employer NAME is included solely
   * so the alert can say where they went.
   *
   * Scoped per workspace rather than globally so one tenant's people can never enter another tenant's read
   * set. The workspace predicate here is EXPLICIT, not RLS — this is the owner connection, so the filter is
   * the boundary and must not be dropped.
   *
   * ageDays is computed in SQL against now() so the caller never has to reconcile clock skew between the
   * database and the worker — the same reason badgeV1 takes an injected `now`.
   */
  async loadObservedEmploymentForWorkspace(
    scope: JobChangeWorkspace,
    since: Date,
    limit = 500,
  ): Promise<Map<string, ObservedEmployment>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT ON (me.master_person_id)
                 me.master_person_id,
                 me.master_company_id,
                 me.title,
                 me.match_method,
                 me.source_count,
                 mc.name AS company_name,
                 CASE WHEN me.observed_at IS NULL THEN NULL
                      ELSE floor(extract(epoch FROM (now() - me.observed_at)) / 86400)::int
                 END AS age_days
            FROM master_employment me
            JOIN contacts c
              ON c.master_person_id = me.master_person_id
             AND c.workspace_id = ${scope.workspaceId}::uuid
             AND c.deleted_at IS NULL
            LEFT JOIN master_companies mc ON mc.id = me.master_company_id
           WHERE me.is_primary
             AND me.is_current
             AND me.updated_at > ${since}::timestamptz
           ORDER BY me.master_person_id, me.updated_at DESC
           LIMIT ${limit}`,
    )) as unknown as Array<{
      master_person_id: string;
      master_company_id: string | null;
      title: string | null;
      match_method: string | null;
      source_count: number;
      company_name: string | null;
      age_days: number | null;
    }>;
    const out = new Map<string, ObservedEmployment>();
    for (const r of rows) {
      out.set(r.master_person_id, {
        masterPersonId: r.master_person_id,
        masterCompanyId: r.master_company_id,
        title: r.title,
        matchMethod: r.match_method,
        ageDays: r.age_days,
        sourceCount: Number(r.source_count),
        companyName: r.company_name,
      });
    }
    return out;
  },

  /**
   * The tenant side, inside the caller's withTenantTx with RLS ENFORCING. Returns the live contacts in this
   * workspace whose master person is in `masterPersonIds`, with what the tenant currently believes.
   *
   * Keyset-paged on contact id so a whale workspace drains across ticks rather than blocking one.
   */
  async loadJobChangeCandidates(
    tx: Tx,
    masterPersonIds: readonly string[],
    opts: { afterId?: string | null; limit: number },
  ): Promise<JobChangeCandidate[]> {
    if (masterPersonIds.length === 0) return [];
    // PER-ELEMENT params (ARRAY[$1,$2]::uuid[]), not a bare JS array. Drizzle's sql template does NOT
    // parameterize a JS array as a SQL array — it reaches the wire as a scalar and Postgres raises
    // "malformed array literal". Both existing precedents say so: searchRepository's technology/owner
    // clauses use this exact sql.join form, and dsarRepository builds a '{a,b}' literal instead. This picks
    // the sql.join form because every id stays a BOUND parameter; the literal form interpolates ids into
    // the statement text, which is safe only as long as they are database-issued UUIDs.
    const idParams = sql.join(
      masterPersonIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const after = opts.afterId ? sql`AND c.id > ${opts.afterId}::uuid` : sql``;
    // The believed employer comes from the contact's ACCOUNT, not the contact. `contacts` carries only
    // master_person_id (migration 0017); master_company_id lives on `accounts` (idx_accounts_master). Both
    // are declared in schema/contacts.ts, which defines BOTH tables — reading that file and assuming one
    // table carried both bridges is what produced the first version of this query, and CI caught it with
    // `column "master_company_id" of relation "contacts" does not exist`.
    //
    // LEFT JOIN, not INNER: a contact with no account still has employment worth evaluating. Its prior
    // company reads NULL, which detectJobChange treats as an unknown employer rather than as a match.
    const rows = (await tx.execute(
      sql`SELECT c.id,
                 c.master_person_id,
                 a.master_company_id,
                 c.job_title,
                 trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) AS label,
                 CASE WHEN c.last_verified_at IS NULL THEN NULL
                      ELSE floor(extract(epoch FROM (now() - c.last_verified_at)) / 86400)::int
                 END AS prior_age_days
            FROM contacts c
            LEFT JOIN accounts a ON a.id = c.account_id
           WHERE c.deleted_at IS NULL
             AND c.master_person_id = ANY(ARRAY[${idParams}]::uuid[])
             ${after}
           ORDER BY c.id
           LIMIT ${opts.limit}`,
    )) as unknown as Array<{
      id: string;
      master_person_id: string;
      master_company_id: string | null;
      job_title: string | null;
      label: string;
      prior_age_days: number | null;
    }>;
    return rows.map((r) => ({
      contactId: r.id,
      masterPersonId: r.master_person_id,
      masterCompanyId: r.master_company_id,
      jobTitle: r.job_title,
      priorAgeDays: r.prior_age_days,
      // An unnamed contact still deserves an alert; "This contact" beats an empty string in the copy.
      label: r.label.trim() === "" ? "This contact" : r.label,
    }));
  },
};
