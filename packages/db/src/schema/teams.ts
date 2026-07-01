// teams.ts — Drizzle schema for TEAMS (Part D, owner decision #6): a grouping/label for the members of a
// workspace — an org-chart, NOT a record-access boundary. GROUPING ONLY: team membership NEVER restricts
// contact/list/search visibility; RLS still isolates only the WORKSPACE (rls/teams.sql), exactly like lists.
// `teams` is a named group; `team_members` is the user↔team join (one membership per (team, user)). A future
// home for per-team credit budgets (M12 / a later ADR) — but today it is purely presentational.

import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const teams = pgTable(
  "teams",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    // Creator, for attribution; SET NULL on user delete (a removed user shouldn't drop a shared team).
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // One team name per workspace.
    uniqWsName: uniqueIndex("uniq_teams_ws_name").on(t.workspaceId, t.name),
  }),
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => ({
    // Membership idempotency: at most one (team, user) row.
    uniqTeamUser: uniqueIndex("uniq_team_members_team_user").on(t.teamId, t.userId),
    byWorkspace: index("idx_team_members_ws").on(t.workspaceId),
  }),
);
