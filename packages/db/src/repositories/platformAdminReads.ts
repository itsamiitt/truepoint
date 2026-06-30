// platformAdminReads.ts — read-only cross-tenant data access for the platform super-admin surface
// (ADR-0032 / 13 §3). Every function here takes the transaction handed to it by withPlatformTx (the audited
// owner-role path), so the audit row + the reads share one transaction and NO unaudited privileged query can
// reach these tables. All lists are bounded by PLATFORM_READ_LIMIT — no unbounded cross-tenant scans
// (ADR-0032). Read-only: never writes (staff mutations go through their own audited endpoints later).

import type { PlatformListQuery } from "@leadwolf/types";
import { type SQL, and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { tenantAuthPolicies, tenantMembers, tenants, users, workspaces } from "../schema/auth.ts";
import { enrichmentJobs } from "../schema/enrichmentJobs.ts";
import { importJobs } from "../schema/importJobs.ts";
import { listMembers, lists } from "../schema/lists.ts";
import { retentionRuns } from "../schema/retention.ts";

/** The cross-tenant read cap — mirrors the bound the api admin routes already enforce (ADR-0032). */
export const PLATFORM_READ_LIMIT = 500;

/** A keyset directory page: the rows plus the cursor for the next page (null at the end). */
export interface PlatformPage<T> {
  rows: T[];
  nextCursor: string | null;
}

// Opaque keyset cursor over the time-ordered v7 `id` (uuid_generate_v7 sorts by creation time, so `id DESC`
// is newest-first and `id < cursor` is the next older page). base64url, never an offset.
function encodeIdCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
function decodeIdCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

/** Slice the limit+1 probe into a page + the next cursor (built from the last row's id). */
function toPage<T extends { id: string }>(rows: T[], limit: number): PlatformPage<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { rows: page, nextCursor: hasMore && last ? encodeIdCursor(last.id) : null };
}

export interface PlatformTenantRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  seatLimit: number;
  workspaceLimit: number | null;
  revealCreditBalance: number;
  regionDefault: string;
  createdAt: Date;
}

export interface PlatformWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  createdAt: Date;
}

export interface PlatformMemberRow {
  userId: string;
  email: string;
  fullName: string | null;
  isTenantOwner: boolean;
  status: string;
}

export interface PlatformTenantDetail {
  tenant: PlatformTenantRow;
  // The per-tenant P1-01 enforcement master switch (tenant_auth_policies.enforcement_enabled). STAFF-ONLY:
  // flipped only via the audited admin POST /tenants/:id/auth-enforcement (authPolicyRepository.setEnforcement).
  // Surfaced here read-only so the staff console can show + toggle current state. Defaults false when the
  // tenant has no policy row yet (an unconfigured tenant is never enforced).
  enforcementEnabled: boolean;
  workspaces: PlatformWorkspaceRow[];
  members: PlatformMemberRow[];
}

export interface PlatformUserRow {
  id: string;
  email: string;
  fullName: string | null;
  status: string;
  isPlatformAdmin: boolean;
}

/** The customer-360 usage/health aggregate for one tenant (13a Area 3) — reveal activity + active holds. */
export interface PlatformTenantOverview {
  reveals30d: number;
  burn30d: number;
  revealsTotal: number;
  lastRevealAt: Date | null;
  activeHolds: number;
}

export interface PlatformWorkspaceListRow {
  id: string;
  name: string;
  slug: string;
  tenantId: string;
}

/**
 * One recent bulk-import job as seen by STAFF (data-management A4) — the cross-tenant rollout-monitoring shape
 * for the COPY-staging import pipeline (15-bulk-import-design). METADATA + outcome TALLIES only: status /
 * av-scan / row counts / failure reason describe the JOB, never an `import_job_rows` row, so no imported
 * contact PII rides this surface. The owning tenant is identified by id AND name (the org name is the
 * customer's, not a person's PII — same join the tenants directory already makes).
 */
export interface PlatformImportJobRow {
  jobId: string;
  tenantId: string;
  tenantName: string;
  status: string;
  sourceName: string;
  avScanStatus: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsMatched: number;
  rowsRejected: number;
  createdAt: Date;
  completedAt: Date | null;
  failedReason: string | null;
}

/**
 * One recent retention-engine RUN as seen by STAFF (data-management A5) — the cross-tenant view of the SHADOW
 * evidence: what the daily sweep found it WOULD delete for each data class, BEFORE a class is flipped to
 * `enforce` (design 16-retention-engine-design.md). COUNTS + class + window only: candidate/deleted tallies,
 * the disabled|shadow|enforce mode, and the age cutoff describe the RUN — retention_runs carries NO contact
 * PII (no row references, no emails/phones), so none can ride this surface. The owning tenant is identified by
 * id AND name (the org name is the customer's, not a person's PII — the same join the tenants directory makes).
 */
export interface PlatformRetentionRunRow {
  tenantId: string;
  tenantName: string;
  dataClass: string;
  mode: string;
  candidateCount: number;
  deletedCount: number;
  cutoff: Date | null;
  runStartedAt: Date;
  runFinishedAt: Date;
}

/**
 * One list as seen by STAFF — the privacy-first "list container" shape (list-plan/07 §3.1, D2). This is
 * METADATA + an AGGREGATE member COUNT only: name / owner-id / counts / timestamps describe the container,
 * NOT its contents. It deliberately carries NO `list_members` rows and NO contact-PII column (no email/phone/
 * name) — record-level access is reachable ONLY via break-glass impersonation under the workspace GUC (D2).
 *
 * The owner is identified by `ownerUserId` only — NOT the owner's EMAIL. The owner is a customer employee and
 * their email is their PII; the privacy-first staff surface does not leak it. Staff that genuinely need to
 * resolve the user go through the (separately audited) users directory.
 *
 * NOTE: list-plan Phase 0 (`list_kind`/`source`/`archived_at`/`deleted_at`) is NOT yet on this branch; when
 * it lands, add those metadata fields here and exclude soft-deleted lists in the query (see the WHERE below).
 */
export interface PlatformListOverviewRow {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const tenantCols = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  plan: tenants.plan,
  status: tenants.status,
  seatLimit: tenants.seatLimit,
  workspaceLimit: tenants.workspaceLimit,
  revealCreditBalance: tenants.revealCreditBalance,
  regionDefault: tenants.regionDefault,
  createdAt: tenants.createdAt,
};

export const platformAdminRepository = {
  /** All workspaces (cross-tenant directory feed), bounded. */
  async listWorkspaces(tx: Tx): Promise<PlatformWorkspaceListRow[]> {
    return tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        tenantId: workspaces.tenantId,
      })
      .from(workspaces)
      .limit(PLATFORM_READ_LIMIT);
  },

  /** The users directory (cross-tenant) — searchable (email / name) + keyset-paginated (13a F5). */
  async listUsers(
    tx: Tx,
    q: PlatformListQuery = { limit: 50 },
  ): Promise<PlatformPage<PlatformUserRow>> {
    const limit = Math.min(q.limit, PLATFORM_READ_LIMIT);
    const conds: SQL[] = [];
    if (q.search) {
      const like = `%${q.search}%`;
      const pred = or(ilike(users.email, like), ilike(users.fullName, like));
      if (pred) conds.push(pred);
    }
    if (q.status) {
      conds.push(eq(users.status, q.status));
    }
    if (q.cursor) {
      const id = decodeIdCursor(q.cursor);
      if (id) conds.push(lt(users.id, id));
    }
    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(users)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(users.id))
      .limit(limit + 1);
    return toPage(rows, limit);
  },

  /** The tenants directory — plan/status/seats/credits per org (13 §3.1), searchable (name / slug) +
   *  keyset-paginated (13a F5). */
  async listTenants(
    tx: Tx,
    q: PlatformListQuery = { limit: 50 },
  ): Promise<PlatformPage<PlatformTenantRow>> {
    const limit = Math.min(q.limit, PLATFORM_READ_LIMIT);
    const conds: SQL[] = [];
    if (q.search) {
      const like = `%${q.search}%`;
      const pred = or(ilike(tenants.name, like), ilike(tenants.slug, like));
      if (pred) conds.push(pred);
    }
    if (q.status) {
      conds.push(eq(tenants.status, q.status));
    }
    if (q.cursor) {
      const id = decodeIdCursor(q.cursor);
      if (id) conds.push(lt(tenants.id, id));
    }
    const rows = await tx
      .select(tenantCols)
      .from(tenants)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(tenants.id))
      .limit(limit + 1);
    return toPage(rows, limit);
  },

  /**
   * The customer-360 usage/health overview for one tenant (13a Area 3): reveal activity over the last 30 days
   * and all-time, the last reveal, and the count of active abuse holds. Cross-tenant owner read (filtered by
   * tenant_id); each query is a single aggregate over an indexed column. No record-level PII.
   */
  async getTenantOverview(tx: Tx, tenantId: string): Promise<PlatformTenantOverview> {
    const [r] = (await tx.execute(sql`
      SELECT
        (count(*) FILTER (WHERE revealed_at >= now() - interval '30 days'))::int                       AS reveals_30d,
        coalesce(sum(credits_consumed) FILTER (WHERE revealed_at >= now() - interval '30 days'), 0)::int AS burn_30d,
        count(*)::int                                                                                   AS reveals_total,
        max(revealed_at)                                                                                AS last_reveal_at
      FROM contact_reveals
      WHERE tenant_id = ${tenantId}::uuid
    `)) as unknown as Array<{
      reveals_30d: number;
      burn_30d: number;
      reveals_total: number;
      last_reveal_at: Date | string | null;
    }>;
    const [h] = (await tx.execute(sql`
      SELECT (count(*) FILTER (WHERE lifted_at IS NULL))::int AS active_holds
      FROM account_holds
      WHERE tenant_id = ${tenantId}::uuid
    `)) as unknown as Array<{ active_holds: number }>;

    const lastRaw = r?.last_reveal_at ?? null;
    return {
      reveals30d: Number(r?.reveals_30d ?? 0),
      burn30d: Number(r?.burn_30d ?? 0),
      revealsTotal: Number(r?.reveals_total ?? 0),
      lastRevealAt: lastRaw == null ? null : lastRaw instanceof Date ? lastRaw : new Date(lastRaw),
      activeHolds: Number(h?.active_holds ?? 0),
    };
  },

  /** A tenant plus its workspaces and members (13 §3.1). Returns null if the id is unknown. */
  async getTenantDetail(tx: Tx, tenantId: string): Promise<PlatformTenantDetail | null> {
    const [tenant] = await tx
      .select(tenantCols)
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) return null;

    // The per-tenant enforcement master switch lives on tenant_auth_policies (1:1 with the tenant), not on
    // tenants — so it is read separately. A tenant with no policy row yet is never enforced (default false).
    const [policy] = await tx
      .select({ enforcementEnabled: tenantAuthPolicies.enforcementEnabled })
      .from(tenantAuthPolicies)
      .where(eq(tenantAuthPolicies.tenantId, tenantId))
      .limit(1);
    const enforcementEnabled = policy?.enforcementEnabled ?? false;

    const tenantWorkspaces = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        isDefault: workspaces.isDefault,
        createdAt: workspaces.createdAt,
      })
      .from(workspaces)
      .where(eq(workspaces.tenantId, tenantId))
      .limit(PLATFORM_READ_LIMIT);

    // Active members only — 'removed' rows are tombstones (mirrors how workspace/tenant member reads filter
    // status='active'); including them would overstate the org's member/seat count in the staff directory.
    const members = await tx
      .select({
        userId: tenantMembers.userId,
        email: users.email,
        fullName: users.fullName,
        isTenantOwner: tenantMembers.isTenantOwner,
        status: tenantMembers.status,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.status, "active")))
      .limit(PLATFORM_READ_LIMIT);

    return { tenant, enforcementEnabled, workspaces: tenantWorkspaces, members };
  },

  /**
   * STAFF lists-overview for ONE tenant (list-plan/07 §3.1, D2) — the privacy-first staff surface over a
   * customer's lists. Returns per-list METADATA + an AGGREGATE member COUNT only; it NEVER selects a
   * `list_members` row or a contact-PII column, so no member PII can leave the boundary. The owner is the
   * `owner_user_id` only — NOT the owner's email (a customer employee's PII). Filtered to `tenantId` and
   * bounded by PLATFORM_READ_LIMIT — no unbounded "all lists across tenants" scan. Runs inside a
   * withPlatformTx transaction (owner connection, no workspace GUC), so the read is audited and the
   * membership tables stay behind FORCE-RLS for any non-aggregate access.
   *
   * NOTE: this is intentionally an aggregate `count(list_members.id)`, the same shape the CUSTOMER list view
   * uses — counting rows is not reading their PII. Member identities remain unreachable without a workspace
   * scope (customer) or an impersonation session.
   */
  async listTenantListsOverview(tx: Tx, tenantId: string): Promise<PlatformListOverviewRow[]> {
    return (
      tx
        .select({
          id: lists.id,
          name: lists.name,
          description: lists.description,
          ownerUserId: lists.ownerUserId,
          // count() over the leftJoin returns 0 (never NULL) for an empty list, so no JS-side coalesce is needed.
          memberCount: sql<number>`count(${listMembers.id})::int`,
          createdAt: lists.createdAt,
          updatedAt: lists.updatedAt,
        })
        .from(lists)
        .leftJoin(listMembers, eq(listMembers.listId, lists.id))
        // Tenant filter is explicit: the owner connection bypasses RLS, so the cross-tenant read is bounded to
        // the targeted tenant. (When Phase 0 lands, also exclude soft-deleted lists: `lists.deletedAt IS NULL`.)
        .where(eq(lists.tenantId, tenantId))
        .groupBy(lists.id)
        .orderBy(asc(lists.name))
        .limit(PLATFORM_READ_LIMIT)
    );
  },

  /** Bulk-enrichment job statuses (a bounded sample) — the queue-depth / DLQ proxy for system health
   *  (13 §9) until a dedicated worker-metrics surface exists. Tallying is left to the caller. */
  async sampleJobStatuses(tx: Tx): Promise<string[]> {
    const rows = await tx
      .select({ status: enrichmentJobs.status })
      .from(enrichmentJobs)
      .limit(PLATFORM_READ_LIMIT);
    return rows.map((r) => r.status);
  },

  /**
   * Recent bulk-import jobs ACROSS all tenants (data-management A4) — the staff rollout-monitoring feed for the
   * COPY-staging import pipeline (15-bulk-import-design, ADR-0036). Each control row is joined to its tenant
   * NAME and returns the genuinely useful monitoring columns (status / av-scan / row tallies / failure
   * reason), newest-first. BOUNDED: `limit` is clamped to PLATFORM_READ_LIMIT so a caller can never widen it
   * into an unbounded cross-tenant scan (ADR-0032). Runs inside withPlatformTx (owner connection, RLS bypass),
   * so the read is audited; it selects from `import_jobs` only — NEVER an `import_job_rows` row — so no
   * imported contact PII leaves the boundary (mirrors the privacy-first lists-overview aggregate idiom).
   */
  async recentImportJobs(tx: Tx, limit = PLATFORM_READ_LIMIT): Promise<PlatformImportJobRow[]> {
    return tx
      .select({
        jobId: importJobs.id,
        tenantId: importJobs.tenantId,
        tenantName: tenants.name,
        status: importJobs.status,
        sourceName: importJobs.sourceName,
        avScanStatus: importJobs.avScanStatus,
        rowsTotal: importJobs.rowsTotal,
        rowsCreated: importJobs.rowsCreated,
        rowsMatched: importJobs.rowsMatched,
        rowsRejected: importJobs.rowsRejected,
        createdAt: importJobs.createdAt,
        completedAt: importJobs.completedAt,
        failedReason: importJobs.failedReason,
      })
      .from(importJobs)
      .innerJoin(tenants, eq(tenants.id, importJobs.tenantId))
      .orderBy(desc(importJobs.createdAt))
      .limit(Math.min(limit, PLATFORM_READ_LIMIT));
  },

  /**
   * Recent retention-engine RUNS ACROSS all tenants (data-management A5) — the staff view of the SHADOW
   * evidence operators review BEFORE flipping a class to `enforce` (design 16-retention-engine-design.md). Each
   * run row is joined to its tenant NAME and returns the genuinely useful monitoring columns (class / mode /
   * candidate ["would delete"] + deleted tallies / cutoff window / run timestamps), newest-first. BOUNDED:
   * `limit` is clamped to PLATFORM_READ_LIMIT so a caller can never widen it into an unbounded cross-tenant scan
   * (ADR-0032). Runs inside withPlatformTx (owner connection, RLS bypass), so the read is audited. retention_runs
   * is COUNTS-only — it references no contact rows and carries no PII — so nothing sensitive leaves the boundary
   * (mirrors the privacy-first import-jobs/lists-overview idioms). The customer-facing recentRuns
   * (retentionRunRepository) stays TENANT-scoped via RLS; this is the SEPARATE cross-tenant platform read.
   */
  async recentRetentionRuns(
    tx: Tx,
    limit = PLATFORM_READ_LIMIT,
  ): Promise<PlatformRetentionRunRow[]> {
    return tx
      .select({
        tenantId: retentionRuns.tenantId,
        tenantName: tenants.name,
        dataClass: retentionRuns.dataClass,
        mode: retentionRuns.mode,
        candidateCount: retentionRuns.candidateCount,
        deletedCount: retentionRuns.deletedCount,
        cutoff: retentionRuns.cutoff,
        runStartedAt: retentionRuns.runStartedAt,
        runFinishedAt: retentionRuns.runFinishedAt,
      })
      .from(retentionRuns)
      .innerJoin(tenants, eq(tenants.id, retentionRuns.tenantId))
      .orderBy(desc(retentionRuns.createdAt))
      .limit(Math.min(limit, PLATFORM_READ_LIMIT));
  },
};
