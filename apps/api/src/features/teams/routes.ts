// routes.ts — /api/v1/teams (Part D, decision #6): workspace-scoped team CRUD + roster. GROUPING ONLY — an
// org-chart, NOT an access boundary; nothing here changes who can see which records. authn + tenancy (scope
// derived from the VERIFIED claims, never the body); reads are open to the workspace, writes are workspace-admin
// gated (owner|admin). The repo runs under withTenantTx so the workspace-isolation RLS is the boundary.

import { env } from "@leadwolf/config";
import { teamRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  type TeamView,
  ValidationError,
  addTeamMemberSchema,
  createTeamSchema,
  teamMemberViewSchema,
  teamViewSchema,
  updateTeamSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const teamsRoutes = new Hono<{ Variables: TenancyVariables }>();
// DARK behind TEAMS_ENABLED (Part D): every route 404s until enabled, so the web Teams tab degrades cleanly.
teamsRoutes.use("*", async (c, next) => {
  if (!env.TEAMS_ENABLED) return c.json({ available: false }, 404);
  await next();
});
teamsRoutes.use("*", authn);
teamsRoutes.use("*", tenancy);

/** The workspace scope for the repo — teams require a workspace (a tenant with no active workspace can't have
 *  teams). Fail-closed when the claims carry no workspace. */
function scopeOf(c: Context<{ Variables: TenancyVariables }>): {
  tenantId: string;
  workspaceId: string;
} {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to manage teams.");
  return { tenantId: c.get("tenantId"), workspaceId };
}

function toTeamView(t: {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: Date;
}): TeamView {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    memberCount: t.memberCount,
    createdAt: t.createdAt.toISOString(),
  };
}

teamsRoutes.get("/", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const teams = await teamRepository.listTeams(scopeOf(c));
  return c.json({ teams: teamViewSchema.array().parse(teams.map(toTeamView)) });
});

teamsRoutes.post("/", requireRole("owner", "admin"), async (c) => {
  const parsed = createTeamSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const team = await teamRepository.createTeam(scopeOf(c), {
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    createdByUserId: c.get("claims").sub,
  });
  if (!team) throw new ValidationError("A team with that name already exists in this workspace.");
  return c.json({ team: teamViewSchema.parse(toTeamView(team)) }, 201);
});

teamsRoutes.patch("/:id", requireRole("owner", "admin"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = updateTeamSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const n = await teamRepository.updateTeam(scopeOf(c), id, {
    name: parsed.data.name,
    description: parsed.data.description,
  });
  if (n === 0) throw new NotFoundError("Team not found.");
  return c.json({ ok: true });
});

teamsRoutes.delete("/:id", requireRole("owner", "admin"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const n = await teamRepository.deleteTeam(scopeOf(c), id);
  if (n === 0) throw new NotFoundError("Team not found.");
  return c.json({ ok: true });
});

teamsRoutes.get("/:id/members", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const members = await teamRepository.listMembers(scopeOf(c), id);
  return c.json({ members: teamMemberViewSchema.array().parse(members) });
});

teamsRoutes.post("/:id/members", requireRole("owner", "admin"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = addTeamMemberSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const result = await teamRepository.addMember(scopeOf(c), id, parsed.data.email);
  if (result === "no_team") throw new NotFoundError("Team not found.");
  if (result === "not_member")
    throw new ValidationError("That email isn't a member of this organization.");
  return c.json({ ok: true });
});

teamsRoutes.delete("/:id/members/:userId", requireRole("owner", "admin"), async (c) => {
  const id = c.req.param("id");
  const userId = c.req.param("userId");
  if (!UUID_RE.test(id) || !UUID_RE.test(userId)) throw new ValidationError("id must be a UUID");
  await teamRepository.removeMember(scopeOf(c), id, userId);
  return c.json({ ok: true });
});
