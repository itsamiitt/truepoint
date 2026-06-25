// scimService.ts — the provision / deprovision / read logic behind /scim/v2/Users (enterprise IAM, 17 /
// ADR-0018; 09 "SCIM deprovisioning race & token abuse"). This lives in apps/api (not packages/core) because
// it is the layer that legitimately bridges @leadwolf/auth (the session-revocation + JIT-provision primitives)
// and @leadwolf/db (the tenant-membership repositories) — packages/core deliberately does NOT depend on
// @leadwolf/auth (it would create a cycle / cross a boundary), so the orchestration belongs here, the same way
// compliance/routes.ts composes core + db + a scoped audit tx.
//
// GLOBAL-IDENTITY ↔ SCIM MAPPING (ADR-0019): a "SCIM User in tenant T" = a global `users` row (keyed by email)
// PLUS a `tenant_members(T)` row. The SCIM resource id is the userId. `active` is whether that membership is
// active. Provision ensures both (idempotent on (tenant, email)); deprovision flips the membership to
// 'deactivated' AND revokes the user's live sessions.
//
// DEPROVISION → ACCESS REVOCATION + the documented STALE WINDOW (09 ship-gate AC):
//   active:false / DELETE does two things in order:
//     1. set tenant_members(T).status = 'deactivated' — the durable source of truth. The user's next refresh
//        in T resolves no active membership, so they cannot mint a fresh access token (the session line dies).
//     2. revokeAllSessionsForUser(userId) — revokes EVERY durable session of the user AND deny-lists each
//        session id so its still-unexpired (≤15 min) access token is rejected by authn's isRevoked check
//        within seconds, not only at natural expiry.
//   RESIDUAL STALE-ACCESS WINDOW (bounded, not zero — anchored to the existing token model):
//     • isRevoked() FAILS OPEN on a Redis error (packages/auth/src/revocation.ts → authn.ts:24): if the
//       deny-list is unreachable, a deny-listed access token is NOT rejected, so it keeps working until it
//       expires naturally — worst case the full ACCESS-TOKEN TTL (≤15 min).
//     • The refresh-reuse path carries a 30 s rotation grace (REUSE_GRACE_MS), so a refresh in flight at the
//       instant of deprovision may rotate once within ~30 s; the rotated session is still a session of a now-
//       deactivated member, so the NEXT scope/membership resolution denies it.
//     • revokeAllSessionsForUser is GLOBAL (all of the user's orgs). A user who is a member of OTHER tenants is
//       logged out of those too and simply re-authenticates there — the safe (fail-closed) direction. The
//       membership deactivation itself is tenant-T-scoped.
//   ⇒ Net: a healthy deployment cuts T's access within seconds; the worst case (deny-list down) is bounded by
//     the ≤15-min access-token TTL. There is no path to indefinite access — the durable membership is gone.
//
// TENANT ISOLATION: `tenantId` is the one the bearer token resolved to (scimAuth), never a body/path value.
// Every repository call is scoped to it (RLS under withTenantTx); a userId from another tenant matches no
// membership row → 404. The SCIM token can only ever read/write ITS tenant's members.
//
// AUDIT: provision → member.add, re/de-activate → member.update / member.remove, written via the in-tx
// writeAudit in the SAME withTenantTx as the status mutation (atomic). The actor is the IdP (a system actor,
// actorUserId: null); the scim token id is recorded in metadata so a change is attributable to a credential.

import { provisionSsoIdentity, revokeAllSessionsForUser } from "@leadwolf/auth";
import { writeAudit } from "@leadwolf/core";
import {
  type ScimMemberRow,
  tenantMemberRepository,
  tenantSsoConfigRepository,
  userRepository,
  withTenantTx,
} from "@leadwolf/db";
import type { ScimCreateUser } from "@leadwolf/types";
import { scimNotFound } from "./scimError.ts";

/** The fully-resolved SCIM operation context: the token's tenant + the authenticating token id (for audit). */
export interface ScimScope {
  tenantId: string;
  scimTokenId: string;
}

export interface ScimListResult {
  total: number;
  members: ScimMemberRow[];
}

/** A page of this tenant's SCIM members + the total count (for the ListResponse envelope). */
export async function listScimUsers(
  scope: ScimScope,
  page: { offset: number; limit: number },
): Promise<ScimListResult> {
  const [total, members] = await Promise.all([
    tenantMemberRepository.countScimMembers(scope.tenantId),
    page.limit > 0
      ? tenantMemberRepository.listScimMembers(scope.tenantId, page)
      : Promise.resolve<ScimMemberRow[]>([]),
  ]);
  return { total, members };
}

/** One SCIM member of this tenant by resource id (= userId). Throws 404 when not a member of THIS tenant. */
export async function getScimUser(scope: ScimScope, userId: string): Promise<ScimMemberRow> {
  const row = await tenantMemberRepository.findScimMemberByUserId(scope.tenantId, userId);
  if (!row) throw scimNotFound("User not found.");
  return row;
}

/** Find a SCIM member of this tenant by email (the idempotency probe), or null. */
export async function findScimUserByEmail(
  scope: ScimScope,
  email: string,
): Promise<ScimMemberRow | null> {
  return tenantMemberRepository.findScimMemberByEmail(scope.tenantId, email.trim().toLowerCase());
}

/** Find a SCIM member of this tenant by IdP externalId (the externalId filter probe), or null. */
export async function findScimUserByExternalId(
  scope: ScimScope,
  externalId: string,
): Promise<ScimMemberRow | null> {
  return tenantMemberRepository.findScimMemberByExternalId(scope.tenantId, externalId);
}

/** The tenant's configured SSO/SCIM default workspace role (the role a JIT/SCIM member joins at), or 'member'. */
async function defaultRoleFor(tenantId: string): Promise<string> {
  const sso = await tenantSsoConfigRepository.findByTenant(tenantId);
  return sso?.defaultRole ?? "member";
}

/**
 * Provision a SCIM user: ensure the global identity (by email) + an ACTIVE tenant membership at the SSO/SCIM
 * default role. Idempotent on (tenant, email): a returning user re-resolves to the same identity + membership;
 * a previously-DEPROVISIONED member is REACTIVATED (status → active). The IdP's externalId (if supplied) is
 * mirrored onto the identity. Returns the resulting SCIM member row + whether it was newly created (for 201 vs
 * 200). NEVER trusts a client-supplied role/tenant — provisioning always joins at the server-chosen role in
 * the token's tenant.
 */
export async function provisionScimUser(
  scope: ScimScope,
  body: ScimCreateUser,
): Promise<{ row: ScimMemberRow; created: boolean }> {
  const email = (body.emails?.find((e) => e.primary)?.value ?? body.userName).trim().toLowerCase();
  const fullName = body.name?.formatted ?? body.displayName ?? email;
  const wantActive = body.active ?? true;

  const existing = await tenantMemberRepository.findScimMemberByEmail(scope.tenantId, email);

  // Ensure the identity + an (active) tenant membership at the default role. provisionSsoIdentity is the
  // canonical JIT join (create user if missing → joinOrg into the default workspace at the default role); we
  // reuse it with jitEnabled forced on (a SCIM IdP IS the authoritative provisioning source). joinOrg is
  // onConflictDoNothing, so it does NOT by itself flip a previously-deactivated membership back to active —
  // the reactivate below (a status UPDATE in an audited tx) handles that case explicitly.
  const { userId } = await provisionSsoIdentity({
    assertion: { email, fullName, attributes: {} },
    config: {
      tenantId: scope.tenantId,
      protocol: "oidc",
      provider: "scim",
      attributeMapping: {},
      jitEnabled: true,
      defaultRole: await defaultRoleFor(scope.tenantId),
      enforced: false,
    },
  });

  if (body.externalId) {
    await userRepository.setScimExternalId(userId, body.externalId);
  }

  // Reconcile the membership status to the requested `active` (default true), auditing the change. A fresh
  // provision lands active (member.add); a re-provision of a deactivated member reactivates it (member.update);
  // a provision with active:false lands deactivated (and revokes any live sessions — defensive, the user is new
  // so usually none).
  if (wantActive) {
    if (!existing || existing.status !== "active") {
      await withTenantTx({ tenantId: scope.tenantId }, async (tx) => {
        await tenantMemberRepository.setMembershipStatusInTx(tx, scope.tenantId, userId, "active");
        await writeAudit(tx, {
          tenantId: scope.tenantId,
          workspaceId: null,
          actorUserId: null, // the IdP (system actor)
          action: existing ? "member.update" : "member.add",
          entityType: "tenant_member",
          entityId: userId,
          metadata: {
            via: "scim",
            scimTokenId: scope.scimTokenId,
            event: existing ? "reactivate" : "provision",
            email,
          },
        });
      });
    }
  } else {
    await deprovisionScimUser(scope, userId, email);
  }

  const row = await tenantMemberRepository.findScimMemberByUserId(scope.tenantId, userId);
  // findScimMemberByUserId can only be null if the membership was concurrently removed; treat as 404.
  if (!row) throw scimNotFound("User not found.");
  return { row, created: !existing };
}

/**
 * DEPROVISION (the security-critical path): deactivate the user's membership in THIS tenant AND revoke all of
 * their live sessions so access is cut promptly (see the file-header window analysis). Idempotent: a no-op if
 * the membership is already inactive (still revokes sessions defensively). Audited as member.remove.
 */
export async function deprovisionScimUser(
  scope: ScimScope,
  userId: string,
  email?: string,
): Promise<void> {
  await withTenantTx({ tenantId: scope.tenantId }, async (tx) => {
    await tenantMemberRepository.setMembershipStatusInTx(tx, scope.tenantId, userId, "deactivated");
    await writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: null,
      actorUserId: null, // the IdP (system actor)
      action: "member.remove",
      entityType: "tenant_member",
      entityId: userId,
      metadata: { via: "scim", scimTokenId: scope.scimTokenId, event: "deprovision", email },
    });
  });

  // Kill live access OUTSIDE the membership tx: revokeAllSessionsForUser revokes the durable sessions AND
  // deny-lists their access tokens (the second half of the cut — see the file header). Done after the
  // membership flip so the source of truth is already gone even if this step is interrupted.
  await revokeAllSessionsForUser(userId);
}

/** Reactivate a previously-deprovisioned member (active:true via PATCH/PUT). Audited as member.update. */
export async function reactivateScimUser(scope: ScimScope, userId: string): Promise<void> {
  await withTenantTx({ tenantId: scope.tenantId }, async (tx) => {
    await tenantMemberRepository.setMembershipStatusInTx(tx, scope.tenantId, userId, "active");
    await writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: null,
      actorUserId: null,
      action: "member.update",
      entityType: "tenant_member",
      entityId: userId,
      metadata: { via: "scim", scimTokenId: scope.scimTokenId, event: "reactivate" },
    });
  });
}
