// memberRoutes.ts — HTTP wiring for workspace members management (P1-03, 12 §3, 17 §5). Lets a workspace
// owner|admin list the workspace's members + pending invites and invite / change-role / remove them.
// Transport only: authn+tenancy resolve the caller, requireRole gates to owner|admin (the core layer
// re-verifies + writes the member.add/update/remove audit), and the scoped reads/writes live in core/db.
// Mounted under /api/v1/workspaces so it shares the workspaces domain; the paths (/current/members*) match
// the apps/web settings-workspace contract exactly so the already-built MembersPanel works unchanged.

import { changeMemberRole, inviteMember, listWorkspaceMembers, removeMember } from "@leadwolf/core";
import {
  ForbiddenError,
  ValidationError,
  changeMemberRoleSchema,
  inviteMemberSchema,
  workspaceMemberIdParamSchema,
  workspaceMemberListSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const workspaceMembersRoutes = new Hono<{ Variables: RoleVariables }>();

workspaceMembersRoutes.use("*", authn);
workspaceMembersRoutes.use("*", tenancy);
// Every member-admin action requires an active workspace owner|admin (the core layer re-checks too).
workspaceMembersRoutes.use("*", requireRole("owner", "admin"));

/** GET /current/members — the active members + pending invites of this workspace (the members table). */
workspaceMembersRoutes.get("/current/members", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");

  const members = await listWorkspaceMembers({
    tenantId: c.get("tenantId"),
    workspaceId,
    actorUserId: c.get("claims").sub,
  });

  return c.json(
    workspaceMemberListSchema.parse({
      members: members.map((m) => ({
        id: m.id,
        email: m.email,
        name: m.name,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
      })),
    }),
  );
});

/** POST /current/members — invite an email at a non-owner role (idempotent on (workspace, email)). */
workspaceMembersRoutes.post("/current/members", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const parsed = inviteMemberSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid invite.");

  await inviteMember(
    {
      tenantId: c.get("tenantId"),
      workspaceId,
      actorUserId: c.get("claims").sub,
    },
    parsed.data,
  );
  // The raw link token is minted + stored (hash-only) by the core; emailing it is the auth-origin mailer's
  // job (apps/auth), which is not reachable from apps/api — the panel only needs the 200. See route notes.
  return c.json({ ok: true }, 200);
});

/** PATCH /current/members/:memberId — change an active member's role (never to owner). */
workspaceMembersRoutes.patch("/current/members/:memberId", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const id = workspaceMemberIdParamSchema.safeParse({ memberId: c.req.param("memberId") });
  if (!id.success) throw new ValidationError("Invalid member id.");
  const body = changeMemberRoleSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ValidationError("Invalid role.");

  await changeMemberRole(
    {
      tenantId: c.get("tenantId"),
      workspaceId,
      actorUserId: c.get("claims").sub,
    },
    id.data.memberId,
    body.data.role,
  );
  return c.json({ ok: true }, 200);
});

/** DELETE /current/members/:memberId — remove an active member or revoke a pending invite (not the owner). */
workspaceMembersRoutes.delete("/current/members/:memberId", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const id = workspaceMemberIdParamSchema.safeParse({ memberId: c.req.param("memberId") });
  if (!id.success) throw new ValidationError("Invalid member id.");

  await removeMember(
    {
      tenantId: c.get("tenantId"),
      workspaceId,
      actorUserId: c.get("claims").sub,
    },
    id.data.memberId,
  );
  return c.json({ ok: true }, 200);
});
