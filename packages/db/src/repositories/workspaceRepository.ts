// workspaceRepository.ts — data access for the workspaces/tenancy-membership domain: workspaces + the
// membership graph (`workspace_members`, `tenant_members`), pending `invitations`, and verified domain→
// tenant/SSO routing. Reads that PRECEDE tenant selection (a user's orgs; the identifier-step domain
// lookup; an invite by email) run on the global client; workspace lists run under withTenantTx (RLS).
// All co-located here because they form one cohesive aggregate that maps to the `workspaces` domain.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db, withTenantTx } from "../client.ts";
import {
  invitations,
  tenantDomains,
  tenantMembers,
  tenantSsoConfigs,
  tenants,
  workspaceMembers,
  workspaces,
} from "../schema/auth.ts";

// ── Workspaces (RLS-scoped) ──────────────────────────────────────────────────────────────────────────
export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

export const workspaceRepository = {
  async listForUser(tenantId: string, userId: string): Promise<WorkspaceSummary[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")));
      return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
    });
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
};

// ── Tenant membership (a global identity's orgs — read pre-tenant by the auth service, ADR-0019) ────────
export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  isTenantOwner: boolean;
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
      .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.status, "active")));
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      isTenantOwner: r.isTenantOwner,
    }));
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
      await tx
        .insert(tenantMembers)
        .values({ tenantId: t!.id, userId: input.ownerUserId, isTenantOwner: true, status: "active" });
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
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: ws!.id, userId: input.ownerUserId, role: "owner", status: "active", joinedAt: new Date() });
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
      ? { id: r.id, tenantId: r.tenantId, workspaceId: r.workspaceId, role: r.role, isTenantOwner: r.isTenantOwner }
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
};
