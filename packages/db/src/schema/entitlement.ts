// entitlement.ts — Drizzle table object for `entitlement`, the resolved per-tenant feature caps
// (06-roadmap Phase 1: "usage events + tier-entitlement stub (Free caps enforced)").
//
// NOT re-exported from schema/index.ts. Migration 0093 is hand-authored, and drizzle.config.ts points at that
// barrel — so staying out of it is what stops `drizzle-kit generate` emitting a second, conflicting CREATE
// TABLE for a table that already exists. Repositories import this module directly.
//
// A CAP LAYER ABOVE CREDITS, NOT A REPLACEMENT (decision D2). The shipped reveal-credit ledger is untouched:
// credits remain the internal settlement unit, entitlements answer "is this tenant ALLOWED to do this, this
// period". The two are deliberately never reconciled in code — doing so would touch the money loop, the ledger
// recon worker, Stripe webhooks and the subscription grant worker, none of it flag-reversible.
//
// RLS: tenant-scoped, ENABLE + FORCE, SELECT-only for the app role (rls/entitlement.sql). A role that can grant
// itself an entitlement has no cap at all, so the absence of a write policy is the actual enforcement.

import { sql } from "drizzle-orm";
import { index, integer, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants } from "./auth.ts";

export const entitlement = pgTable(
  "entitlement",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 50 }).notNull(), // reveal_month | export_month | alerts | seats
    // NULL = unlimited. Distinct from 0, which is a real cap meaning the feature is off for this tenant —
    // conflating the two is how an "unlimited" plan silently becomes a blocked one.
    cap: integer("cap"),
    period: varchar("period", { length: 20 }),
    source: varchar("source", { length: 20 }).notNull(), // plan | community | grant | staff
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    // `source` is IN the key on purpose. Phase 3's Community tier grants expanded caps for keeping a
    // contribution channel active; those must coexist with the plan's own row for the same key rather than
    // overwrite it, so Community access can be withdrawn by expiring one row without touching what was paid for.
    pk: primaryKey({ columns: [t.tenantId, t.key, t.source] }),
    // Serves the expiry sweep; the resolver's per-tenant read is already served by the PK's leading column.
    expiringIdx: index("idx_entitlement_expiring")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
  }),
);
