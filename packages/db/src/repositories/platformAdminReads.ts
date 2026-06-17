// platformAdminReads.ts — read-only cross-tenant data access for the platform super-admin surface
// (ADR-0032 / 13 §3). Every function here takes the transaction handed to it by withPlatformTx (the audited
// owner-role path), so the audit row + the reads share one transaction and NO unaudited privileged query can
// reach these tables. All lists are bounded by PLATFORM_READ_LIMIT — no unbounded cross-tenant scans
// (ADR-0032). Read-only: never writes (staff mutations go through their own audited endpoints later).

import { and, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { tenantMembers, tenants, users, workspaces } from "../schema/auth.ts";
import { enrichmentJobs } from "../schema/enrichmentJobs.ts";

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
