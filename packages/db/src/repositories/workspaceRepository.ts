// workspaceRepository.ts — data access for the workspaces/tenancy-membership domain: workspaces + the
// membership graph (`workspace_members`, `tenant_members`), pending `invitations`, and verified domain→
// tenant/SSO routing. Reads that PRECEDE tenant selection (a user's orgs; the identifier-step domain
// lookup; an invite by email) run on the global client; workspace lists run under withTenantTx (RLS).
// All co-located here because they form one cohesive aggregate that maps to the `workspaces` domain.

import type { OrgRole, WorkspaceRole } from "@leadwolf/types";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { type Tx, db, withTenantTx } from "../client.ts";
import {
  invitations,
  tenantDomains,
  tenantMembers,
  tenantSsoConfigs,
  tenants,
  users,
  workspaceMembers,
  workspaces,
} from "../schema/auth.ts";

// ── Workspaces (RLS-scoped) ──────────────────────────────────────────────────────────────────────────
export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

/** A row in the Workspace ▸ Members table (P1-03): an ACTIVE membership joined to its user, or a pending
 * INVITE (no user yet). `id` is the membership row id (active) or the invitation id (invited); the role/
 * email/name come from the respective source. `joinedAt` is null for a pending invite. */
export interface WorkspaceMemberRecord {
  id: string;
  userId: string | null; // null for a pending invite (no identity yet)
  email: string;
  name: string | null;
  role: string;
  status: "active" | "invited";
  joinedAt: Date | null;
}

export const workspaceRepository = {
  async listForUser(tenantId: string, userId: string): Promise<WorkspaceSummary[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")))
        // DETERMINISTIC order (creation order, id tiebreak). Without it Postgres returns rows in an
        // unstable order, so the `[0]` single-workspace auto-select (flow.ts) and the picker default could
        // change between logins → "logged into the wrong workspace" (Issue 2c).
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
      return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
    });
  },

  // The active workspace role for a member (owner|admin|member|viewer), or null if not an active member.
  // RLS-scoped: read under the tenant+workspace GUCs the caller is operating in.
  async getRoleForUser(
    tenantId: string,
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null> {
    return withTenantTx({ tenantId, workspaceId }, async (tx) => {
      const rows = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.status, "active"),
          ),
        )
        .limit(1);
      return rows[0] ? (rows[0].role as WorkspaceRole) : null;
    });
  },

  // ── Workspace members management (P1-03) ───────────────────────────────────────────────────────────
  // The list shown in Workspace ▸ Members: ACTIVE memberships (joined to their user for email/name) PLUS
  // pending INVITES (workspace-scoped, not yet accepted — expiry is not filtered; an admin sees a stale invite
  // so they can revoke/re-invite it). RLS-scoped: both reads run under the
  // tenant+workspace GUCs, so a foreign workspaceId returns nothing. Active first, then invites, each in a
  // deterministic order. Bounded — a workspace's member count is small, but the cap is a safety belt.

  /** List the active members + pending invites of `workspaceId` (the members table). RLS-scoped read. */
  async listMembers(
    tenantId: string,
    workspaceId: string,
    limit = 500,
  ): Promise<WorkspaceMemberRecord[]> {
    return withTenantTx({ tenantId, workspaceId }, async (tx) => {
      const active = await tx
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          email: users.email,
          name: users.fullName,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.status, "active"),
          ),
        )
        .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id))
        .limit(limit);

      const invited = await tx
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(
          and(eq(invitations.workspaceId, workspaceId), isNull(invitations.acceptedAt)),
        )
        .orderBy(asc(invitations.createdAt), asc(invitations.id))
        .limit(limit);

      return [
        ...active.map(
          (r): WorkspaceMemberRecord => ({
            id: r.id,
            userId: r.userId,
            email: r.email,
            name: r.name,
            role: r.role,
            status: "active",
            joinedAt: r.joinedAt,
          }),
        ),
        ...invited.map(
          (r): WorkspaceMemberRecord => ({
            id: r.id,
            userId: null,
            email: r.email,
            name: null,
            role: r.role,
            status: "invited",
            joinedAt: null,
          }),
        ),
      ];
    });
  },

  /** The active membership row for `(workspaceId, memberId)` — the authz target for a role-change/remove.
   * Returns the owning user + current role, or null when the id is not an active member of THIS workspace
   * (RLS-scoped read; a foreign id reveals nothing). Run inside a caller tx so the check + mutation + audit
   * are atomic. */
  async findActiveMember(
    tx: Tx,
    workspaceId: string,
    memberId: string,
  ): Promise<{ userId: string; role: string } | null> {
    const rows = await tx
      .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.status, "active"),
        ),
      )
      .limit(1);
    return rows[0] ? { userId: rows[0].userId, role: rows[0].role } : null;
  },

  /** Update an active member's role inside a caller tx (commits with its audit row). Scoped to the
   * workspace + the active membership id so it can never touch another workspace's row. */
  async updateMemberRoleInTx(
    tx: Tx,
    workspaceId: string,
    memberId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    await tx
      .update(workspaceMembers)
      .set({ role })
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.status, "active"),
        ),
      );
  },

  /** Soft-remove an active member (status → removed) inside a caller tx (commits with its audit row).
   * Scoped to the workspace + the active membership id. Returns the count removed (0 if already gone). */
  async removeMemberInTx(tx: Tx, workspaceId: string, memberId: string): Promise<number> {
    const removed = await tx
      .update(workspaceMembers)
      .set({ status: "removed" })
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.status, "active"),
        ),
      )
      .returning({ id: workspaceMembers.id });
    return removed.length;
  },

  // The org's landing workspace for auto-join/invite placement. Read PRE-membership by the auth service
  // (the joining user is not yet a member), so it runs on the privileged global client, not withTenantTx.
  async findDefault(tenantId: string): Promise<{ id: string } | null> {
    const rows = await db
      .select({ id: workspaces.id, isDefault: workspaces.isDefault })
      .from(workspaces)
      .where(eq(workspaces.tenantId, tenantId))
      .orderBy(desc(workspaces.isDefault), asc(workspaces.createdAt))
      .limit(1);
    return rows[0] ? { id: rows[0].id } : null;
  },

  /**
   * The workspace a user should LAND on in `tenantId`, in priority order (ADR-0019, Issue 2c/2b):
   *   1. their remembered last workspace in this org, if it is still an active membership;
   *   2. the org's default workspace, if they are a member of it;
   *   3. otherwise the first workspace they belong to (deterministic order).
   * Returns null only when the user is a member of the org but of NO workspace in it. Used by the login flow
   * (auto-select / fallback) and the org switch, so a multi-workspace user returns where they left off.
   */
  async resolveLandingWorkspace(tenantId: string, userId: string): Promise<string | null> {
    const last = await tenantMemberRepository.getLastWorkspace(tenantId, userId);
    if (last && (await workspaceRepository.getRoleForUser(tenantId, last, userId))) return last;
    const def = await workspaceRepository.findDefault(tenantId);
    if (def && (await workspaceRepository.getRoleForUser(tenantId, def.id, userId))) return def.id;
    const all = await workspaceRepository.listForUser(tenantId, userId);
    return all[0]?.id ?? null;
  },
};

// ── Tenant membership (a global identity's orgs — read pre-tenant by the auth service, ADR-0019) ────────
export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  isTenantOwner: boolean;
}

/** A tenant member projected for the SCIM /Users surface: the global identity joined to its tenant membership.
 * `active` is whether the `tenant_members` row is active (deprovision flips it to deactivated). `externalId`
 * is the IdP's own id mirrored onto users.scim_external_id. The SCIM resource id is the userId. */
export interface ScimMemberRow {
  userId: string;
  email: string;
  fullName: string | null;
  externalId: string | null;
  active: boolean;
  createdAt: Date;
  // The tenant-membership status string verbatim (active | invited | removed | deactivated) so the SCIM layer
  // can map it to the boolean `active` and decide whether a deprovision is a no-op.
  status: string;
}

export const tenantMemberRepository = {
  async listForUser(userId: string): Promise<TenantMembership[]> {
    const rows = await db
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        isTenantOwner: tenantMembers.isTenantOwner,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.status, "active")))
      // DETERMINISTIC order (join/creation order, id tiebreak) so the single-org `[0]` auto-select and the org
      // picker default are stable across logins (Issue 2c).
      .orderBy(asc(tenantMembers.createdAt), asc(tenants.id));
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      isTenantOwner: r.isTenantOwner,
    }));
  },

  // The active org role (owner|billing_admin|security_admin|compliance_admin|member) for a member, or null
  // if not an active member of the tenant (ADR-0030). RLS-scoped: read under the caller's tenant GUC, so a
  // user in another tenant simply has no membership row here. Enforced by requireOrgRole.
  async getOrgRole(tenantId: string, userId: string): Promise<OrgRole | null> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({ orgRole: tenantMembers.orgRole })
        .from(tenantMembers)
        .where(
          and(
            eq(tenantMembers.tenantId, tenantId),
            eq(tenantMembers.userId, userId),
            eq(tenantMembers.status, "active"),
          ),
        )
        .limit(1);
      return rows[0] ? (rows[0].orgRole as OrgRole) : null;
    });
  },

  // Read/persist the user's last active workspace in an org (the default selector — Issue 2c). Global client,
  // like listForUser: this is a pre-tenant read/write the auth service makes about the membership graph.
  async getLastWorkspace(tenantId: string, userId: string): Promise<string | null> {
    const rows = await db
      .select({ lastWorkspaceId: tenantMembers.lastWorkspaceId })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
      .limit(1);
    return rows[0]?.lastWorkspaceId ?? null;
  },

  async setLastWorkspace(tenantId: string, userId: string, workspaceId: string): Promise<void> {
    await db
      .update(tenantMembers)
      .set({ lastWorkspaceId: workspaceId })
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));
  },

  async create(input: {
    tenantId: string;
    userId: string;
    isTenantOwner?: boolean;
    invitedByUserId?: string;
  }): Promise<void> {
    await db
      .insert(tenantMembers)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        isTenantOwner: input.isTenantOwner ?? false,
        status: "active",
        invitedByUserId: input.invitedByUserId,
      })
      .onConflictDoNothing();
  },

  // Add an existing identity to an org via auto-join (verified domain) or an accepted invite (ADR-0020):
  // the tenant membership + (when scoped) the workspace membership land atomically. Idempotent on re-entry.
  async joinOrg(input: {
    tenantId: string;
    userId: string;
    workspaceId?: string;
    role?: string;
    isTenantOwner?: boolean;
    invitedByUserId?: string;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .insert(tenantMembers)
        .values({
          tenantId: input.tenantId,
          userId: input.userId,
          isTenantOwner: input.isTenantOwner ?? false,
          status: "active",
          invitedByUserId: input.invitedByUserId,
        })
        .onConflictDoNothing();
      if (input.workspaceId) {
        await tx
          .insert(workspaceMembers)
          .values({
            workspaceId: input.workspaceId,
            userId: input.userId,
            role: input.role ?? "member",
            status: "active",
            joinedAt: new Date(),
            invitedByUserId: input.invitedByUserId,
          })
          .onConflictDoNothing();
      }
    });
  },

  // ── SCIM 2.0 /Users surface (enterprise IAM, 17 / ADR-0018, 09 "SCIM deprovisioning") ──────────────────
  // A "SCIM user in tenant T" is a global `users` identity that holds a `tenant_members(T)` row. These reads
  // run under withTenantTx (leadwolf_app, RLS): the tenant_members policy is USING tenant_id = GUC, so a token
  // scoped to tenant T can ONLY ever see / touch T's membership rows — a userId from another tenant matches no
  // row and 404s. The SCIM tenant is the one the bearer token resolved to (never a body/path value), so this is
  // the load-bearing tenant isolation. Provisioning (the membership/identity WRITE) reuses joinOrg above on the
  // owner connection (tenant_members is ENABLE, owner-exempt); the deactivate/reactivate UPDATEs run under the
  // app role (USING-only policy permits the in-tenant UPDATE) inside the caller's audited tx.

  /** Count this tenant's SCIM-visible members (all tenant_members rows), for the ListResponse totalResults. */
  async countScimMembers(tenantId: string): Promise<number> {
    return withTenantTx({ tenantId }, async (tx) => {
      const [row] = await tx
        .select({ value: count() })
        .from(tenantMembers)
        .where(eq(tenantMembers.tenantId, tenantId));
      return row?.value ?? 0;
    });
  },

  /** A page of this tenant's members as SCIM rows (identity joined to membership), oldest first (stable). */
  async listScimMembers(
    tenantId: string,
    opts: { offset: number; limit: number },
  ): Promise<ScimMemberRow[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({
          userId: tenantMembers.userId,
          email: users.email,
          fullName: users.fullName,
          externalId: users.scimExternalId,
          status: tenantMembers.status,
          createdAt: tenantMembers.createdAt,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(eq(tenantMembers.tenantId, tenantId))
        .orderBy(asc(tenantMembers.createdAt), asc(tenantMembers.userId))
        .limit(opts.limit)
        .offset(opts.offset);
      return rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        fullName: r.fullName,
        externalId: r.externalId,
        active: r.status === "active",
        createdAt: r.createdAt,
        status: r.status,
      }));
    });
  },

  /** One SCIM member of this tenant by user id (the resource id), or null when not a member here (→ 404). */
  async findScimMemberByUserId(tenantId: string, userId: string): Promise<ScimMemberRow | null> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({
          userId: tenantMembers.userId,
          email: users.email,
          fullName: users.fullName,
          externalId: users.scimExternalId,
          status: tenantMembers.status,
          createdAt: tenantMembers.createdAt,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
        .limit(1);
      const r = rows[0];
      return r
        ? {
            userId: r.userId,
            email: r.email,
            fullName: r.fullName,
            externalId: r.externalId,
            active: r.status === "active",
            createdAt: r.createdAt,
            status: r.status,
          }
        : null;
    });
  },

  /** The SCIM member of this tenant whose identity has IdP `externalId` (the externalId filter probe), or null.
   * Tenant-scoped exactly like the by-email/by-id reads: the `tenant_members` join runs under withTenantTx (RLS),
   * so an externalId belonging to another tenant's user matches no row here (→ an empty ListResponse, never a
   * cross-tenant leak). `users.scim_external_id` is global, but the membership join restricts to THIS tenant. */
  async findScimMemberByExternalId(
    tenantId: string,
    externalId: string,
  ): Promise<ScimMemberRow | null> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({
          userId: tenantMembers.userId,
          email: users.email,
          fullName: users.fullName,
          externalId: users.scimExternalId,
          status: tenantMembers.status,
          createdAt: tenantMembers.createdAt,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(users.scimExternalId, externalId)))
        .limit(1);
      const r = rows[0];
      return r
        ? {
            userId: r.userId,
            email: r.email,
            fullName: r.fullName,
            externalId: r.externalId,
            active: r.status === "active",
            createdAt: r.createdAt,
            status: r.status,
          }
        : null;
    });
  },

  /** The SCIM member of this tenant whose identity has `email` (the provisioning idempotency probe), or null. */
  async findScimMemberByEmail(tenantId: string, email: string): Promise<ScimMemberRow | null> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({
          userId: tenantMembers.userId,
          email: users.email,
          fullName: users.fullName,
          externalId: users.scimExternalId,
          status: tenantMembers.status,
          createdAt: tenantMembers.createdAt,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(users.email, email)))
        .limit(1);
      const r = rows[0];
      return r
        ? {
            userId: r.userId,
            email: r.email,
            fullName: r.fullName,
            externalId: r.externalId,
            active: r.status === "active",
            createdAt: r.createdAt,
            status: r.status,
          }
        : null;
    });
  },

  /** Set a member's tenant-membership status inside a caller tx (so it commits with its audit row). Scoped to
   * (tenantId, userId); a foreign userId matches no row (RLS + the WHERE). Returns the count updated. Used for
   * deprovision (status → 'deactivated') and re-provision (status → 'active'). */
  async setMembershipStatusInTx(
    tx: Tx,
    tenantId: string,
    userId: string,
    status: "active" | "deactivated",
  ): Promise<number> {
    const updated = await tx
      .update(tenantMembers)
      .set({ status })
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
      .returning({ userId: tenantMembers.userId });
    return updated.length;
  },
};

// ── New-org provisioning (a fresh signup with no domain/invite match — ADR-0020) ────────────────────────
// Runs on the privileged global client (the tenant does not exist yet, so RLS/withTenantTx cannot apply).
// One transaction creates the tenant, its owner membership, the default workspace, and the owner's
// workspace membership — the same shape db:seed builds for the seeded orgs.
export const tenantRepository = {
  async provisionNewOrg(input: {
    tenantName: string;
    tenantSlug: string;
    ownerUserId: string;
    workspaceName: string;
    workspaceSlug: string;
  }): Promise<{ tenantId: string; workspaceId: string }> {
    return db.transaction(async (tx) => {
      const [t] = await tx
        .insert(tenants)
        .values({ name: input.tenantName, slug: input.tenantSlug })
        .returning({ id: tenants.id });
      await tx.insert(tenantMembers).values({
        tenantId: t!.id,
        userId: input.ownerUserId,
        isTenantOwner: true,
        status: "active",
      });
      const [ws] = await tx
        .insert(workspaces)
        .values({
          tenantId: t!.id,
          name: input.workspaceName,
          slug: input.workspaceSlug,
          isDefault: true,
          createdByUserId: input.ownerUserId,
        })
        .returning({ id: workspaces.id });
      await tx.insert(workspaceMembers).values({
        workspaceId: ws!.id,
        userId: input.ownerUserId,
        role: "owner",
        status: "active",
        joinedAt: new Date(),
      });
      return { tenantId: t!.id, workspaceId: ws!.id };
    });
  },
};

// ── Domain → tenant/SSO routing (identifier-step lookup; global, pre-tenant — ADR-0017/0020) ────────────
export interface DomainResolution {
  tenantId: string;
  tenantName: string;
  joinPolicy: string; // sso_only | auto_join | request_access
  ssoEnforced: boolean;
  ssoProtocol: string | null; // saml | oidc
}

export const tenantDomainRepository = {
  async findVerifiedByDomain(domain: string): Promise<DomainResolution | null> {
    const rows = await db
      .select({
        tenantId: tenantDomains.tenantId,
        tenantName: tenants.name,
        joinPolicy: tenantDomains.joinPolicy,
        ssoEnabled: tenantSsoConfigs.enabled,
        ssoEnforced: tenantSsoConfigs.enforced,
        ssoProtocol: tenantSsoConfigs.protocol,
      })
      .from(tenantDomains)
      .innerJoin(tenants, eq(tenantDomains.tenantId, tenants.id))
      .leftJoin(tenantSsoConfigs, eq(tenantSsoConfigs.tenantId, tenantDomains.tenantId))
      .where(and(eq(tenantDomains.domain, domain), eq(tenantDomains.status, "verified")))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      joinPolicy: r.joinPolicy,
      ssoEnforced: Boolean(r.ssoEnabled) && Boolean(r.ssoEnforced),
      ssoProtocol: r.ssoProtocol ?? null,
    };
  },
};

// ── Tenant SSO config (read pre-tenant by the auth service to initiate/validate SSO — 17 §7) ────────────
export interface SsoConfigRecord {
  tenantId: string;
  protocol: "oidc" | "saml";
  provider: string;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecretEnc: Uint8Array | null;
  metadataUrl: string | null;
  metadataXml: string | null;
  attributeMapping: Record<string, string>;
  jitEnabled: boolean;
  defaultRole: string;
  enabled: boolean;
  enforced: boolean;
}

export const tenantSsoConfigRepository = {
  async findByTenant(tenantId: string): Promise<SsoConfigRecord | null> {
    const rows = await db
      .select()
      .from(tenantSsoConfigs)
      .where(eq(tenantSsoConfigs.tenantId, tenantId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      tenantId: r.tenantId,
      protocol: r.protocol === "oidc" ? "oidc" : "saml",
      provider: r.provider,
      oidcIssuer: r.oidcIssuer,
      oidcClientId: r.oidcClientId,
      oidcClientSecretEnc: r.oidcClientSecretEnc,
      metadataUrl: r.metadataUrl,
      metadataXml: r.metadataXml,
      attributeMapping: (r.attributeMapping ?? {}) as Record<string, string>,
      jitEnabled: r.jitEnabled,
      defaultRole: r.defaultRole,
      enabled: r.enabled,
      enforced: r.enforced,
    };
  },
};

// ── Invitations (sent by an admin; accepted at registration or via a token link — ADR-0020) ─────────────
export interface PendingInvitation {
  id: string;
  tenantId: string;
  workspaceId: string | null;
  role: string;
  isTenantOwner: boolean;
}

// The token-link view also carries the bound email + expiry so the accept path can validate them.
export interface InvitationByToken extends PendingInvitation {
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
}

export interface CreateInvitationInput {
  tenantId: string;
  workspaceId?: string;
  email: string;
  role?: string;
  isTenantOwner?: boolean;
  tokenHash: string;
  invitedByUserId?: string;
  expiresAt: Date;
}

export const invitationRepository = {
  async findPendingByEmail(email: string): Promise<PendingInvitation | null> {
    const rows = await db
      .select({
        id: invitations.id,
        tenantId: invitations.tenantId,
        workspaceId: invitations.workspaceId,
        role: invitations.role,
        isTenantOwner: invitations.isTenantOwner,
      })
      .from(invitations)
      .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt)))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          id: r.id,
          tenantId: r.tenantId,
          workspaceId: r.workspaceId,
          role: r.role,
          isTenantOwner: r.isTenantOwner,
        }
      : null;
  },

  async findByTokenHash(tokenHash: string): Promise<InvitationByToken | null> {
    const rows = await db
      .select({
        id: invitations.id,
        tenantId: invitations.tenantId,
        workspaceId: invitations.workspaceId,
        role: invitations.role,
        isTenantOwner: invitations.isTenantOwner,
        email: invitations.email,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          id: r.id,
          tenantId: r.tenantId,
          workspaceId: r.workspaceId,
          role: r.role,
          isTenantOwner: r.isTenantOwner,
          email: r.email,
          expiresAt: r.expiresAt,
          acceptedAt: r.acceptedAt,
        }
      : null;
  },

  async create(input: CreateInvitationInput): Promise<{ id: string }> {
    const [row] = await db
      .insert(invitations)
      .values({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        email: input.email,
        role: input.role ?? "member",
        isTenantOwner: input.isTenantOwner ?? false,
        tokenHash: input.tokenHash,
        invitedByUserId: input.invitedByUserId,
        expiresAt: input.expiresAt,
      })
      .returning({ id: invitations.id });
    return { id: row!.id };
  },

  async markAccepted(id: string): Promise<void> {
    await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, id));
  },

  // ── Workspace-scoped invite management (P1-03) ─────────────────────────────────────────────────────
  // The members "invite teammates" flow writes/refreshes pending invites idempotently on (workspace, email)
  // and revokes them by id. These run on the GLOBAL (owner) connection like the rest of invitationRepository:
  // the `invitations` RLS policy is USING-only (no WITH CHECK), so an INSERT under the leadwolf_app role
  // (withTenantTx) is denied — invite WRITES are an owner-connection boundary by design (ADR-0020). Every
  // method still constrains by tenantId + workspaceId in the WHERE, so it can only ever touch the caller's
  // workspace (the core layer has already verified the caller is an admin OF that workspace).

  /** The pending (unaccepted) invite for `(tenantId, workspaceId, email)`, or null — the idempotency probe. */
  async findPendingInWorkspaceByEmail(
    tenantId: string,
    workspaceId: string,
    email: string,
  ): Promise<{ id: string } | null> {
    const rows = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.workspaceId, workspaceId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
        ),
      )
      .limit(1);
    return rows[0] ? { id: rows[0].id } : null;
  },

  /** Refresh an existing pending invite's token + role + expiry (re-invite — no duplicate row, ADR-0020). */
  async refreshPending(input: {
    id: string;
    role: string;
    tokenHash: string;
    invitedByUserId?: string;
    expiresAt: Date;
  }): Promise<void> {
    await db
      .update(invitations)
      .set({
        role: input.role,
        tokenHash: input.tokenHash,
        invitedByUserId: input.invitedByUserId,
        expiresAt: input.expiresAt,
      })
      .where(and(eq(invitations.id, input.id), isNull(invitations.acceptedAt)));
  },

  /** A pending invite by id, scoped to `(tenantId, workspaceId)` — the remove/role-change authz target. */
  async findPendingInWorkspaceById(
    tenantId: string,
    workspaceId: string,
    invitationId: string,
  ): Promise<{ id: string; email: string; role: string } | null> {
    const rows = await db
      .select({ id: invitations.id, email: invitations.email, role: invitations.role })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenantId),
          eq(invitations.workspaceId, workspaceId),
          isNull(invitations.acceptedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Re-role a pending invite by id, scoped to `(tenantId, workspaceId)`. Returns the count updated (0 if the
   * id is not a pending invite of this workspace). The panel offers the role control on invited rows too, so a
   * role-change on an invite id refreshes the role the invitee will join at (token/expiry untouched). */
  async updatePendingRoleInWorkspace(
    tenantId: string,
    workspaceId: string,
    invitationId: string,
    role: string,
  ): Promise<number> {
    const updated = await db
      .update(invitations)
      .set({ role })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenantId),
          eq(invitations.workspaceId, workspaceId),
          isNull(invitations.acceptedAt),
        ),
      )
      .returning({ id: invitations.id });
    return updated.length;
  },

  /** Revoke (delete) a pending invite by id, scoped to `(tenantId, workspaceId)`. Returns the count removed. */
  async revokePendingInWorkspace(
    tenantId: string,
    workspaceId: string,
    invitationId: string,
  ): Promise<number> {
    const removed = await db
      .delete(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenantId),
          eq(invitations.workspaceId, workspaceId),
          isNull(invitations.acceptedAt),
        ),
      )
      .returning({ id: invitations.id });
    return removed.length;
  },
};
