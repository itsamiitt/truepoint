// platformOps.ts — Drizzle schema for PLATFORM operations data that is cross-tenant STAFF data, not a
// customer-owned record. This phase adds `impersonation_sessions`: the audit-of-record for staff
// impersonation-with-consent (ADR-0011 / 13 §11). A session is time-boxed (expires_at) and carries a
// `reason` (the consent/justification captured at start); start + end each also write a platform_audit_log
// row via withPlatformTx. PLATFORM-owned: written ONLY by the owner connection (no tenant_id scoping column
// — it spans tenants), and deny-all to the customer app role (rls/platformOps.sql). It deliberately mirrors
// the auth.ts schema helpers (id(), uuid, text, timestamptz) so it reads like its siblings.
//
// NOTE: the actual "login-as" token mint is OUT OF SCOPE here — this table only records the session +
// its banner/justification metadata; the scoped, time-boxed impersonation access token is WIRE-deferred.

import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

// One staff impersonation session. target_* identify who/what is being impersonated (a tenant always; a
// workspace and/or a specific user optionally). started_at + expires_at bound the consent window; ended_at
// is set on an explicit end (else the session simply expires). ip is the staff actor's request IP at start.
export const impersonationSessions = pgTable("impersonation_sessions", {
  id: id(),
  staffUserId: uuid("staff_user_id").notNull(), // the platform staff member doing the impersonation
  targetTenantId: uuid("target_tenant_id").notNull(), // the tenant whose context is entered
  targetWorkspaceId: uuid("target_workspace_id"), // optional narrower workspace scope
  targetUserId: uuid("target_user_id"), // optional specific user being impersonated
  reason: text("reason").notNull(), // consent / justification captured at start (audited)
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // hard time-box for the session
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }), // set on explicit end (null = still active/expired)
  ip: text("ip"), // staff actor's request IP at start (audit context)
});

// jit_elevations — just-in-time elevation grants (ADR-0011 / 13 §2, 13a F1). A staff member mints a
// short-lived, reason-bearing, tenant-scoped grant for a sensitive `action` CLASS; the gated action (credit
// move, org suspend) CONSUMES it in the SAME tx as the action + its audit row, so a rejected action releases
// the grant. status flows active → consumed (expiry is derived from expires_at, never a stored 'expired').
// approved_by_user_id is null in the self-service v1 and is the seam for peer-approval (13a open decision #2).
// PLATFORM-owned staff data: written ONLY by the owner connection (withPlatformTx), deny-all to leadwolf_app
// (rls/platformOps.sql + the applyMigrations REVOKE). MUTABLE (status flips), so — like impersonation_sessions
// — there is no append-only trigger; the separate `elevation.grant` platform_audit_log row is the trail.
export const jitElevations = pgTable(
  "jit_elevations",
  {
    id: id(),
    staffUserId: uuid("staff_user_id").notNull(), // the staff member the elevation is granted to
    action: text("action").notNull(), // the sensitive action CLASS (the closed jitAction vocabulary)
    reason: text("reason").notNull(), // justification captured at request (audited)
    targetTenantId: uuid("target_tenant_id"), // the org the elevation is scoped to (null = unscoped, future)
    status: text("status").notNull().default("active"), // active | consumed
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // hard time-box
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }), // set when spent on an action (null = unspent)
    approvedByUserId: uuid("approved_by_user_id"), // future peer-approval (null = self-service)
    ip: text("ip"), // staff actor's request IP at grant (audit context)
  },
  // The consume path matches on (staff, action, target, status) and orders by expires_at — index it.
  (t) => ({
    lookup: index("jit_elevations_staff_action_status_idx").on(t.staffUserId, t.action, t.status),
  }),
);
