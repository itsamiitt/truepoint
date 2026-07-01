// teamRepository.ts — data access for TEAMS (Part D, decision #6): workspace-scoped groups + their member
// roster. GROUPING ONLY — nothing here restricts record visibility; every method runs under withTenantTx so the
// workspace-isolation RLS (rls/teams.sql) is the boundary. Writes require a workspace scope (workspaceId is
// mandatory here even though TenantScope makes it optional).

import { and, asc, eq, sql } from "drizzle-orm";
import { type TenantScope, withTenantTx } from "../client.ts";
import { users } from "../schema/auth.ts";
import { teamMembers, teams } from "../schema/teams.ts";

type WorkspaceScope = TenantScope & { workspaceId: string };

export interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: Date;
}

export interface TeamMemberRow {
  userId: string;
  email: string;
  fullName: string | null;
}

const TEAM_LIMIT = 500;
const MEMBER_LIMIT = 1000;

export const teamRepository = {
  /** The workspace's teams with a member count, name-ordered. RLS-scoped read. */
  async listTeams(scope: WorkspaceScope): Promise<TeamRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: teams.id,
          name: teams.name,
          description: teams.description,
          createdAt: teams.createdAt,
          memberCount: sql<number>`count(${teamMembers.id})::int`,
        })
        .from(teams)
        .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
        .groupBy(teams.id)
        .orderBy(asc(teams.name))
        .limit(TEAM_LIMIT),
    );
  },

  /** Create a team. Returns the new row, or null when the name already exists in the workspace (→ 409). */
  async createTeam(
    scope: WorkspaceScope,
    input: { name: string; description?: string | null; createdByUserId: string },
  ): Promise<TeamRow | null> {
    return withTenantTx(scope, async (tx) => {
      const [row] = await tx
        .insert(teams)
        .values({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          name: input.name,
          description: input.description ?? null,
          createdByUserId: input.createdByUserId,
        })
        .onConflictDoNothing({ target: [teams.workspaceId, teams.name] })
        .returning({
          id: teams.id,
          name: teams.name,
          description: teams.description,
          createdAt: teams.createdAt,
        });
      return row ? { ...row, memberCount: 0 } : null;
    });
  },

  /** Rename / re-describe a team (RLS-scoped to the workspace). Returns rows touched (0 = unknown/foreign id). */
  async updateTeam(
    scope: WorkspaceScope,
    teamId: string,
    input: { name?: string; description?: string | null },
  ): Promise<number> {
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (Object.keys(set).length === 0) return 0;
    return withTenantTx(scope, async (tx) => {
      const updated = await tx
        .update(teams)
        .set(set)
        .where(eq(teams.id, teamId))
        .returning({ id: teams.id });
      return updated.length;
    });
  },

  /** Delete a team (its memberships cascade). RLS-scoped. Returns rows touched (0 = unknown/foreign id). */
  async deleteTeam(scope: WorkspaceScope, teamId: string): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const deleted = await tx
        .delete(teams)
        .where(eq(teams.id, teamId))
        .returning({ id: teams.id });
      return deleted.length;
    });
  },

  /** The team's member roster (user id + email + name). RLS-scoped. */
  async listMembers(scope: WorkspaceScope, teamId: string): Promise<TeamMemberRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({ userId: users.id, email: users.email, fullName: users.fullName })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(eq(teamMembers.teamId, teamId))
        .orderBy(asc(users.email))
        .limit(MEMBER_LIMIT),
    );
  },

  /** Add a user to a team (idempotent). Verifies the team is in THIS workspace first (RLS-scoped select), so a
   *  foreign team id can't be tagged with the caller's workspace. Returns false when the team isn't found. */
  async addMember(scope: WorkspaceScope, teamId: string, userId: string): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);
      if (!team) return false;
      await tx
        .insert(teamMembers)
        .values({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          teamId,
          userId,
        })
        .onConflictDoNothing({ target: [teamMembers.teamId, teamMembers.userId] });
      return true;
    });
  },

  /** Remove a user from a team. RLS-scoped. Returns rows touched (0 = wasn't a member). */
  async removeMember(scope: WorkspaceScope, teamId: string, userId: string): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const deleted = await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
        .returning({ id: teamMembers.id });
      return deleted.length;
    });
  },
};
