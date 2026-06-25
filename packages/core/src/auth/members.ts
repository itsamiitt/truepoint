// members.ts — workspace members management (P1-03, 12 §3, 17 §5). A workspace admin (owner|admin) can
// (a) list the members + pending invites of their workspace, (b) invite an email at a non-owner role,
// (c) change an active member's role, and (d) remove an active member or revoke a pending invite. The
// sibling of adminSessions.ts and built the same way.
//
// SECURITY: every entry point re-verifies the caller is an active owner|admin of the target workspace via
// the RLS-scoped membership read — defense-in-depth on top of the route's requireRole guard. Roles come from
// the closed workspaceRole enum and `owner` is NEVER assignable here (only the non-owner roles), so a member
// can never escalate to owner or set tenant_id/user_id (mass-assignment — 09). The workspace OWNER can be
// neither demoted nor removed. Role-change / remove mutate workspace_members (RLS-writable) and commit their
// member.update / member.remove audit row in the SAME withTenantTx (like session.revoked).
//
// Invite is the one split write: the `invitations` RLS policy is USING-only (no INSERT WITH CHECK), so an
// invite row can only be written on the owner connection (invitationRepository, ADR-0020), NOT inside the
// withTenantTx app-role transaction. We therefore upsert the invite on the owner connection (idempotent on
// (workspace, email)) and then write the member.add audit row in a scoped tx. The two are sequenced, not
// atomic; an invite without its audit row is the benign failure direction (the row is harmless and re-invite
// is idempotent), and it matches the boundary the invitation aggregate already uses.

import { createHash, randomBytes } from "node:crypto";
import {
  type Tx,
  type WorkspaceMemberRecord,
  invitationRepository,
  withTenantTx,
  workspaceRepository,
} from "@leadwolf/db";
import {
  type AssignableWorkspaceRole,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type WorkspaceRole,
} from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";

/** A fully-resolved member-admin context: the tenant + workspace the action runs in, and who is acting. */
export interface MemberAdminScope {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
}

// Workspace roles that may manage members. Typed as WorkspaceRole[] so adding a new privileged role surfaces
// here at compile time (no type-laundering cast on the membership check).
const ADMIN_ROLES: WorkspaceRole[] = ["owner", "admin"];

const INVITE_TTL_HOURS = 168; // 7 days (mirrors packages/auth/src/invitations.ts DEFAULT_TTL_HOURS)
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The acting admin's role, or throw 403 if they are not an active owner|admin of the workspace. */
async function assertWorkspaceAdmin(scope: MemberAdminScope): Promise<WorkspaceRole> {
  const role = await workspaceRepository.getRoleForUser(
    scope.tenantId,
    scope.workspaceId,
    scope.actorUserId,
  );
  if (!role || !ADMIN_ROLES.includes(role)) {
    throw new ForbiddenError("insufficient_role", "Workspace admin access is required.");
  }
  return role;
}

/** List the active members + pending invites of the workspace (the members table). Admin-gated. */
export async function listWorkspaceMembers(
  scope: MemberAdminScope,
): Promise<WorkspaceMemberRecord[]> {
  await assertWorkspaceAdmin(scope);
  return workspaceRepository.listMembers(scope.tenantId, scope.workspaceId);
}

export interface InviteMemberInput {
  email: string;
  role: AssignableWorkspaceRole;
}

/**
 * Invite an email to the workspace at a non-owner role. Idempotent on (workspace, email): a re-invite
 * refreshes the existing pending invite's token + role + expiry rather than duplicating it. Returns the raw
 * link token (handed to the mailer by the transport) — never persisted in clear (only its hash is stored).
 */
export async function inviteMember(
  scope: MemberAdminScope,
  input: InviteMemberInput,
): Promise<{ id: string; token: string }> {
  await assertWorkspaceAdmin(scope);
  const email = input.email.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000);

  // Owner-connection write (the invitations RLS policy has no INSERT WITH CHECK — see file header). Both the
  // probe and the upsert are scoped to (tenant, workspace); the admin check above already bound the caller
  // to THIS workspace, so the invite can only ever land here.
  const existing = await invitationRepository.findPendingInWorkspaceByEmail(
    scope.tenantId,
    scope.workspaceId,
    email,
  );
  let id: string;
  if (existing) {
    await invitationRepository.refreshPending({
      id: existing.id,
      role: input.role,
      tokenHash,
      invitedByUserId: scope.actorUserId,
      expiresAt,
    });
    id = existing.id;
  } else {
    const created = await invitationRepository.create({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      email,
      role: input.role,
      tokenHash,
      invitedByUserId: scope.actorUserId,
      expiresAt,
    });
    id = created.id;
  }

  // Audit the membership change. Sequenced after the owner-connection write (not in the same tx — see header).
  await withTenantTx({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }, (tx) =>
    writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      action: "member.add",
      entityType: "invitation",
      entityId: id,
      metadata: { email, role: input.role, mode: existing ? "reinvite" : "invite" },
    }),
  );
  return { id, token };
}

/**
 * Change a member's role. The workspace OWNER cannot be re-roled here (transfer-of-ownership is its own flow).
 * The id is either a membership row id (active member) or an invitation id (pending invite) — the panel offers
 * the role control on invited rows too. We try the active membership first (role check + update + audit commit
 * atomically in one withTenantTx); if it is not an active member, we fall back to re-rolling a pending invite
 * of THIS workspace (owner-connection write — same boundary as inviteMember). A 404 if it is neither.
 */
export async function changeMemberRole(
  scope: MemberAdminScope,
  memberId: string,
  role: AssignableWorkspaceRole,
): Promise<{ updated: number }> {
  await assertWorkspaceAdmin(scope);
  const handledActive = await withTenantTx(
    { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    async (tx: Tx): Promise<{ updated: number } | null> => {
      const member = await workspaceRepository.findActiveMember(tx, scope.workspaceId, memberId);
      if (!member) return null; // not an active member — maybe a pending invite (handled below)
      // The owner's role is immutable here — never demote the workspace owner.
      if (member.role === "owner") {
        throw new ValidationError("The workspace owner's role cannot be changed.");
      }
      await workspaceRepository.updateMemberRoleInTx(tx, scope.workspaceId, memberId, role);
      await writeAudit(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        action: "member.update",
        entityType: "workspace_member",
        entityId: member.userId,
        metadata: { memberId, from: member.role, to: role },
      });
      return { updated: 1 };
    },
  );
  if (handledActive) return handledActive;

  // Fall back to a pending invite (owner-connection write — same boundary as inviteMember).
  const invite = await invitationRepository.findPendingInWorkspaceById(
    scope.tenantId,
    scope.workspaceId,
    memberId,
  );
  if (!invite) throw new NotFoundError("Member not found.");
  const updated = await invitationRepository.updatePendingRoleInWorkspace(
    scope.tenantId,
    scope.workspaceId,
    memberId,
    role,
  );
  await withTenantTx({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }, (tx) =>
    writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      action: "member.update",
      entityType: "invitation",
      entityId: invite.id,
      metadata: { memberId, from: invite.role, to: role, mode: "invite" },
    }),
  );
  return { updated };
}

/**
 * Remove a member: soft-remove an active membership (status → removed) OR revoke a pending invite. The
 * workspace OWNER can NEVER be removed. The id is either a membership row id (active) or an invitation id
 * (pending) — we try the active membership first (atomic mutate + audit in one tx); if it is not an active
 * member, we fall back to revoking a pending invite of THIS workspace. A 404 if it is neither.
 */
export async function removeMember(
  scope: MemberAdminScope,
  memberId: string,
): Promise<{ removed: number }> {
  await assertWorkspaceAdmin(scope);

  const handledActive = await withTenantTx(
    { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    async (tx: Tx): Promise<{ removed: number } | null> => {
      const member = await workspaceRepository.findActiveMember(tx, scope.workspaceId, memberId);
      if (!member) return null; // not an active member — maybe a pending invite (handled below)
      if (member.role === "owner") {
        throw new ValidationError("The workspace owner cannot be removed.");
      }
      const removed = await workspaceRepository.removeMemberInTx(tx, scope.workspaceId, memberId);
      await writeAudit(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        action: "member.remove",
        entityType: "workspace_member",
        entityId: member.userId,
        metadata: { memberId, role: member.role, mode: "member" },
      });
      return { removed };
    },
  );
  if (handledActive) return handledActive;

  // Fall back to a pending invite (owner-connection write — same boundary as inviteMember).
  const invite = await invitationRepository.findPendingInWorkspaceById(
    scope.tenantId,
    scope.workspaceId,
    memberId,
  );
  if (!invite) throw new NotFoundError("Member not found.");
  const removed = await invitationRepository.revokePendingInWorkspace(
    scope.tenantId,
    scope.workspaceId,
    memberId,
  );
  await withTenantTx({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }, (tx) =>
    writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      action: "member.remove",
      entityType: "invitation",
      entityId: invite.id,
      metadata: { memberId, email: invite.email, role: invite.role, mode: "invite" },
    }),
  );
  return { removed };
}
