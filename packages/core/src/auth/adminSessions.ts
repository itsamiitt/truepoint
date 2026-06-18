// adminSessions.ts — workspace-admin session management (G-AUTH-2, 17 §5/§10, ADR-0031). A workspace admin
// (owner|admin) can (a) list the active sessions of the members of their workspace and (b) revoke one
// session or force a member to re-authenticate (revoke all of that member's sessions in the workspace). A
// revoked session can no longer refresh (refresh.ts rejects revokedAt), so it can no longer authenticate
// once its 15-min access token expires.
//
// SECURITY: every entry point re-verifies the caller is an active owner|admin of the target workspace via
// the RLS-scoped membership read — defense-in-depth on top of the route's requireRole guard. Mutations and
// their audit row commit in ONE withTenantTx so an action is never recorded without happening (and vice
// versa). `session.revoked` is a declared audit action (08 §5 / 17 §9); per ADR-0031 it was previously
// "no flow yet" — this unit is that flow. The audit-coverage bookkeeping (auditCoverage.test.ts) still
// lists it PENDING; moving it to WRITTEN is an intentionally separate follow-up (this unit must not touch
// that test). writeAudit only accepts declared actions, so the write itself is type-safe today.

import {
  type AdminSessionRecord,
  type TenantScope,
  sessionRepository,
  withTenantTx,
  workspaceRepository,
} from "@leadwolf/db";
import { ForbiddenError, NotFoundError, type WorkspaceRole } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";

/** A fully-resolved admin context: the tenant + workspace the action runs in, and who is acting. */
export interface AdminSessionScope {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
  /** The acting admin's own current session id (JWT `sid`), so the list/revoke can mark/guard it. */
  currentSessionId?: string;
}

// Workspace roles that may manage member sessions. Typed as WorkspaceRole[] so adding a new privileged role
// surfaces here at compile time (no type-laundering cast on the membership check).
const ADMIN_ROLES: WorkspaceRole[] = ["owner", "admin"];

/** Throw 403 unless the actor is an active owner|admin of the workspace (RLS-scoped membership read). */
async function assertWorkspaceAdmin(scope: AdminSessionScope): Promise<void> {
  const role = await workspaceRepository.getRoleForUser(
    scope.tenantId,
    scope.workspaceId,
    scope.actorUserId,
  );
  if (!role || !ADMIN_ROLES.includes(role)) {
    throw new ForbiddenError("insufficient_role", "Workspace admin access is required.");
  }
}

const tenantScope = (s: AdminSessionScope): Required<TenantScope> => ({
  tenantId: s.tenantId,
  workspaceId: s.workspaceId,
});

export interface AdminSessionView extends AdminSessionRecord {
  /** True if this is the acting admin's own current session. */
  current: boolean;
}

/** List the active sessions of the workspace's members, marking the caller's own current session. */
export async function listMemberSessions(scope: AdminSessionScope): Promise<AdminSessionView[]> {
  await assertWorkspaceAdmin(scope);
  const rows = await sessionRepository.listForWorkspace(tenantScope(scope));
  return rows.map((r) => ({ ...r, current: r.id === scope.currentSessionId }));
}

/**
 * Revoke a single in-scope session. The admin check runs first; then — atomically in one tx — the scope
 * check (the session belongs to a member of this workspace and is active), the revoke, and the audit commit
 * or roll back together. A session id that is not an active session of a workspace member is a 404 (it
 * reveals nothing about other tenants/workspaces). The admin-role read is a separate snapshot (same TOCTOU
 * window as the route's requireRole guard), which is the accepted trade for re-using the RLS-scoped read.
 */
export async function revokeMemberSession(
  scope: AdminSessionScope,
  sessionId: string,
): Promise<{ revoked: number }> {
  await assertWorkspaceAdmin(scope);
  return withTenantTx(tenantScope(scope), async (tx) => {
    const owner = await sessionRepository.findActiveInWorkspace(tx, scope.workspaceId, sessionId);
    if (!owner) throw new NotFoundError("Session not found.");
    await sessionRepository.revokeInTx(tx, sessionId);
    await writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      action: "session.revoked",
      entityType: "user_session",
      entityId: owner.userId, // the member whose session was revoked (entityId is uuid-typed)
      metadata: {
        sessionId,
        mode: "single",
        self: owner.userId === scope.actorUserId,
      },
    });
    return { revoked: 1 };
  });
}

/**
 * Force a member to re-authenticate: revoke ALL of their active sessions in this workspace. The target must
 * be an active member of the workspace (else 404 — no cross-scope leak). The revoke + audit commit in one tx;
 * the audit row is written ONLY when at least one session was actually ended, so a no-op (the member has no
 * session pinned to this workspace) does not fabricate a "revoked" audit record. Returns the count ended.
 */
export async function forceReauthMember(
  scope: AdminSessionScope,
  targetUserId: string,
): Promise<{ revoked: number }> {
  await assertWorkspaceAdmin(scope);
  // The target must be an active member of THIS workspace (RLS-scoped read), or it is out of scope.
  const targetRole = await workspaceRepository.getRoleForUser(
    scope.tenantId,
    scope.workspaceId,
    targetUserId,
  );
  if (!targetRole) throw new NotFoundError("Member not found.");

  return withTenantTx(tenantScope(scope), async (tx) => {
    const revoked = await sessionRepository.revokeAllForMemberInTx(
      tx,
      scope.workspaceId,
      targetUserId,
    );
    if (revoked > 0) {
      await writeAudit(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        action: "session.revoked",
        entityType: "user_session",
        entityId: targetUserId,
        metadata: {
          mode: "force_reauth",
          count: revoked,
          self: targetUserId === scope.actorUserId,
        },
      });
    }
    return { revoked };
  });
}
