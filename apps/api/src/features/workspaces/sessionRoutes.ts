// sessionRoutes.ts — HTTP wiring for workspace-admin session management (G-AUTH-2, 17 §5/§10, 09). Lets a
// workspace owner|admin list the active sessions of the workspace's members and revoke one, or force a
// member to re-authenticate. Transport only: authn+tenancy resolve the caller, requireRole gates to
// owner|admin (the core layer re-verifies + writes the session.revoked audit), and the scoped reads/writes
// live in core/db. Mounted under /api/v1/workspaces so it shares the workspaces domain.

import { forceReauthMember, listMemberSessions, revokeMemberSession } from "@leadwolf/core";
import {
  ForbiddenError,
  ValidationError,
  adminSessionListSchema,
  memberIdParamSchema,
  sessionIdParamSchema,
  sessionRevokeResultSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const workspaceSecurityRoutes = new Hono<{ Variables: RoleVariables }>();

workspaceSecurityRoutes.use("*", authn);
workspaceSecurityRoutes.use("*", tenancy);
// Every session-admin action requires an active workspace owner|admin (the core layer re-checks too).
workspaceSecurityRoutes.use("*", requireRole("owner", "admin"));

/** GET /security/sessions — active sessions of this workspace's members (the admin sessions table). */
workspaceSecurityRoutes.get("/security/sessions", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const claims = c.get("claims");

  const sessions = await listMemberSessions({
    tenantId: c.get("tenantId"),
    workspaceId,
    actorUserId: claims.sub,
    currentSessionId: claims.sid,
  });

  return c.json(
    adminSessionListSchema.parse({
      sessions: sessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        userEmail: s.userEmail,
        userName: s.userName,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
        expiresAt: s.expiresAt.toISOString(),
        current: s.current,
      })),
    }),
  );
});

/** POST /security/sessions/:sessionId/revoke — end one member's session (it can no longer authenticate). */
workspaceSecurityRoutes.post("/security/sessions/:sessionId/revoke", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const parsed = sessionIdParamSchema.safeParse({ sessionId: c.req.param("sessionId") });
  if (!parsed.success) throw new ValidationError("Invalid session id.");

  const result = await revokeMemberSession(
    {
      tenantId: c.get("tenantId"),
      workspaceId,
      actorUserId: c.get("claims").sub,
      currentSessionId: c.get("claims").sid,
    },
    parsed.data.sessionId,
  );
  return c.json(sessionRevokeResultSchema.parse(result), 200);
});

/** POST /security/members/:userId/force-reauth — revoke ALL of a member's sessions in this workspace. */
workspaceSecurityRoutes.post("/security/members/:userId/force-reauth", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const parsed = memberIdParamSchema.safeParse({ userId: c.req.param("userId") });
  if (!parsed.success) throw new ValidationError("Invalid member id.");

  const result = await forceReauthMember(
    {
      tenantId: c.get("tenantId"),
      workspaceId,
      actorUserId: c.get("claims").sub,
      currentSessionId: c.get("claims").sid,
    },
    parsed.data.userId,
  );
  return c.json(sessionRevokeResultSchema.parse(result), 200);
});
