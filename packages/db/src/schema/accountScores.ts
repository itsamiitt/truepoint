// accountScores.ts — Drizzle schema for account-grain scoring history (migration 0129;
// market-intelligence MI-S4). The `scores` pattern at the account grain: append-per-rescore,
// model-versioned, breakdown-explained; accounts.icp_fit_score is a trigger-kept CACHE of the latest FIT
// (rls/accountScores.sql). Inputs are COMPANY FACTS only — momentum is signal recency, never intent.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";
import { accounts } from "./contacts.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

export const accountScores = pgTable(
  "account_scores",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    modelVersion: varchar("model_version", { length: 20 }).notNull(),
    icpFit: integer("icp_fit").notNull(),
    momentum: integer("momentum").notNull(),
    composite: integer("composite").notNull(),
    breakdown: jsonb("breakdown").notNull().default({}),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsAccountIdx: index("idx_account_scores_ws_account").on(
      t.workspaceId,
      t.accountId,
      t.scoredAt.desc(),
    ),
    ranges: check(
      "account_scores_ranges",
      sql`${t.icpFit} BETWEEN 0 AND 100 AND ${t.momentum} BETWEEN 0 AND 100 AND ${t.composite} BETWEEN 0 AND 100`,
    ),
  }),
);
