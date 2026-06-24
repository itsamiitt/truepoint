// platformAdminReads.ts — read-only cross-tenant data access for the platform super-admin surface
// (ADR-0032 / 13 §3). Every function here takes the transaction handed to it by withPlatformTx (the audited
// owner-role path), so the audit row + the reads share one transaction and NO unaudited privileged query can
// reach these tables. All lists are bounded by PLATFORM_READ_LIMIT — no unbounded cross-tenant scans
// (ADR-0032). Read-only: never writes (staff mutations go through their own audited endpoints later).

import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { tenantMembers, tenants, users, workspaces } from "../schema/auth.ts";
import { enrichmentJobs } from "../schema/enrichmentJobs.ts";
import { listMembers, lists } from "../schema/lists.ts";

/** The cross-tenant read cap — mirrors the bound the api admin routes already enforce (ADR-0032). */
export const PLATFORM_READ_LIMIT = 500;

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

export interface PlatformWorkspaceListRow {
  id: string;
  name: string;
  slug: string;
  tenantId: string;
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

  /** All users (cross-tenant), bounded. */
  async listUsers(tx: Tx): Promise<PlatformUserRow[]> {
    return tx
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(users)
      .limit(PLATFORM_READ_LIMIT);
  },

  /** The tenants directory — plan/status/seats/credits per org (13 §3.1), bounded. */
  async listTenants(tx: Tx): Promise<PlatformTenantRow[]> {
    return tx.select(tenantCols).from(tenants).limit(PLATFORM_READ_LIMIT);
  },

  /** A tenant plus its workspaces and members (13 §3.1). Returns null if the id is unknown. */
  async getTenantDetail(tx: Tx, tenantId: string): Promise<PlatformTenantDetail | null> {
    const [tenant] = await tx
      .select(tenantCols)
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) return null;

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

    return { tenant, workspaces: tenantWorkspaces, members };
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
};
