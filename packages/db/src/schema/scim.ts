// scim.ts — Drizzle schema for SCIM provisioning tokens (enterprise IAM, 17 / ADR-0018). One row per
// long-lived bearer token an org's identity provider uses to call the SCIM 2.0 endpoints. TENANT-scoped
// (RLS USING tenant_id = GUC, rls/scim.sql) — a security_admin/owner only ever touches their OWN org's
// tokens. SECURITY: the plaintext token is shown to the user ONCE at creation and NEVER stored; only its
// SHA-256 hash lands here (token_hash, mirrors the refresh-token / invitation-token hashing posture). The
// list surface never returns the hash — only id/name/timestamps. Revocation is a soft flip (revoked_at).

import { sql } from "drizzle-orm";
import { pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants } from "./auth.ts";

// Shared column idioms (kept local per the self-contained-schema convention used across this folder).
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ── scim_tokens — one SCIM bearer token per row, tenant-scoped ──────────────────────────────────────────
export const scimTokens = pgTable("scim_tokens", {
  id: id(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(), // human label (e.g. "Okta production")
  // SHA-256 hex of the plaintext token — the plaintext is shown once at creation and never persisted.
  // Unique so a (vanishingly unlikely) hash collision or a duplicate insert is rejected at the DB layer.
  tokenHash: varchar("token_hash", { length: 255 }).notNull().unique(),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }), // bumped by the SCIM auth path (WIRE-deferred)
  revokedAt: timestamp("revoked_at", { withTimezone: true }), // soft revoke — a revoked token is rejected at use
});
