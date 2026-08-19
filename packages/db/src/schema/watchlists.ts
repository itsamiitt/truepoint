// watchlists.ts — account watchlists + per-user signal subscriptions (market-intelligence MI-S5;
// docs/planning/market-intelligence/04-capability-blueprint.md MI-3). Outcomes: [S-13] fast detection of
// changes on watched accounts · [S-14].
//
// Three workspace-scoped tables (RLS in rls/watchlists.sql):
//   watchlists            — a named set of accounts, owned by the workspace (not the creator: a rep who
//                           leaves must not take the team's territory list with them).
//   watchlist_members     — account membership. Cascade from both sides: deleting the list or the
//                           account removes the row; signal history in tenant_signals is untouched.
//   signal_subscriptions  — one row per (watchlist, user): which signal FAMILIES this user wants
//                           notified about. The tenant_signals feed is browseable by everyone in the
//                           workspace; a NOTIFICATION is strictly opt-in — alert hygiene is the product
//                           (an alert users learn to ignore has negative value).
//
// Families are a text[] validated against the same closed vocabulary as master_signal_types/0103 by a
// CHECK (array containment — <@), so the no-'intent' hole is enforced here too, not just app-side.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { accounts } from "./contacts.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const watchlists = pgTable(
  "watchlists",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    name: varchar("name", { length: 120 }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqName: uniqueIndex("uniq_watchlists_ws_name").on(t.workspaceId, t.name),
  }),
);

export const watchlistMembers = pgTable(
  "watchlist_members",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqMember: uniqueIndex("uniq_watchlist_members").on(t.watchlistId, t.accountId),
    // The dispatch join: "which watchlists contain this account" inside one workspace.
    byAccount: index("idx_watchlist_members_ws_account").on(t.workspaceId, t.accountId),
  }),
);

export const signalSubscriptions = pgTable(
  "signal_subscriptions",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Signal families this user wants notifications for. Empty array = paused, row kept. */
    families: text("families").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqSub: uniqueIndex("uniq_signal_subscriptions").on(t.watchlistId, t.userId),
    // Same closed vocabulary as master_signal_types/tenant_signals — and the same deliberate no-'intent'.
    familiesEnum: check(
      "signal_subscriptions_families_enum",
      sql`${t.families} <@ ARRAY['hiring','funding','tech_change','leadership','filing','other']::text[]`,
    ),
  }),
);
