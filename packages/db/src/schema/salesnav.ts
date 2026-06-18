// salesnav.ts — Drizzle schema for Sales Navigator link capture (05 §5, M7): a human pastes links to
// LinkedIn/Sales-Nav entities (ADR-0009: assisted/HITL — nothing automated against LinkedIn). link_type
// is a closed enum mirroring packages/types activity.ts; (workspace_id, url) dedups re-pastes.

import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
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
    // The Sales Nav lead id parsed from a /sales/lead/<id> URL (or supplied by the human) — a SECOND dedup
    // facet alongside (workspace_id, url), mirroring the import keying (05 §3/§5). NULL when not parseable.
    salesNavLeadId: varchar("sales_nav_lead_id", { length: 255 }),
    note: text("note"),
    // Free-text labels/tags. A jsonb array (not a Postgres text[]) keeps the Drizzle column portable and the
    // repo mapping trivial; the closed shape (string[]) is enforced in @leadwolf/types at the api edge.
    labels: text("labels"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    // When the human captured the link (defaults to insert time) — distinct from created_at so a backfilled
    // capture can carry its real moment without lying about the row's creation.
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-workspace dedup: pasting the same link twice conflicts instead of accumulating copies.
    uniqWsUrl: uniqueIndex("uniq_sales_nav_links_ws_url").on(t.workspaceId, t.url),
    // Second dedup facet: the same lead captured via two different URL forms still collapses to one row.
    // Partial — only rows that actually carry a parsed lead id participate (NULLs never conflict).
    uniqWsLeadId: uniqueIndex("uniq_sales_nav_links_ws_lead_id")
      .on(t.workspaceId, t.salesNavLeadId)
      .where(sql`${t.salesNavLeadId} IS NOT NULL`),
    typeEnum: check(
      "sales_nav_links_type_enum",
      sql`${t.linkType} IN ('profile','account','saved_search','lead_list','account_list','inmail_thread')`,
    ),
  }),
);
