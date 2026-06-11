// salesnav.ts — Drizzle schema for Sales Navigator link capture (05 §5, M7): a human pastes links to
// LinkedIn/Sales-Nav entities (ADR-0009: assisted/HITL — nothing automated against LinkedIn). link_type
// is a closed enum mirroring packages/types activity.ts; (workspace_id, url) dedups re-pastes.

import { sql } from "drizzle-orm";
import { check, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { accounts, contacts } from "./contacts.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── sales_nav_links — captured pointers to Sales Nav entities, optionally pinned to a contact/account ──
export const salesNavLinks = pgTable(
  "sales_nav_links",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    linkType: varchar("link_type", { length: 30 }).notNull(),
    url: varchar("url", { length: 500 }).notNull(),
    externalId: varchar("external_id", { length: 255 }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-workspace dedup: pasting the same link twice conflicts instead of accumulating copies.
    uniqWsUrl: uniqueIndex("uniq_sales_nav_links_ws_url").on(t.workspaceId, t.url),
    typeEnum: check(
      "sales_nav_links_type_enum",
      sql`${t.linkType} IN ('profile','account','saved_search','lead_list','account_list','inmail_thread')`,
    ),
  }),
);
