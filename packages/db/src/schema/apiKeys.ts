// apiKeys.ts — Drizzle schema for machine API credentials (09 §1 "Auth (machine/public)", §4; ADR-0049).
// One row per long-lived bearer key a customer's SERVER presents to the API. This is the machine analogue of
// a user session: there is no login, no cookie and no refresh — the key IS the credential.
//
// The management UI for this table ALREADY SHIPPED and has been dark since M10:
// apps/web/src/features/settings-developer (Settings ▸ Developer ▸ API keys) does create / rotate / revoke and
// the one-time secret reveal, and degrades to a "connect once the developer API ships" state because
// GET /api/v1/tenants/me/api-keys answers 404. This table and its routes are the missing half; the wire
// contract is therefore NOT open for redesign — it is whatever that client already sends and expects.
//
// Modelled on scim_tokens (schema/scim.ts), which solved the same problem for an org's IdP, with two
// differences that matter:
//
//   • BOUND TO A WORKSPACE, not just a tenant. 09 §11 open question 4 asked whether a key should be
//     tenant-wide with an explicit X-Workspace-Id per call, or bound to one workspace. Bound — because
//     tenancy.md's rule is that scope comes from the credential and NEVER from the request, and a
//     tenant-wide key would reintroduce exactly the client-controlled scope that rule forbids.
//   • SCOPED. A key carries an explicit scope list and a route declares the scope it needs, so a key minted
//     for read-only search cannot be replayed against a billable reveal.
//
// SECURITY (mirrors the refresh-token / invitation-token / scim-token posture):
//   • The plaintext key is generated in the API layer, shown to the user EXACTLY ONCE, and never stored.
//     Only its SHA-256 hex hash lands here, and key_hash is globally UNIQUE — which is what lets the
//     pre-tenant auth lookup learn the tenant FROM the matched row rather than from the caller.
//   • key_prefix is a NON-SECRET display fragment ("tp_live_a1b2c3d4"), so a customer can tell two keys
//     apart in a list and in their own logs without us ever echoing the secret. It is deliberately NOT
//     unique and NOT an authentication input — never look a key up by prefix.
//   • The list surface returns a masked projection; the hash never leaves the repository.
//   • Revocation is a soft flip (revoked_at) so the audit trail survives; it takes effect on the next call.

import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";

// Shared column idioms (kept local per the self-contained-schema convention used across this folder).
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * The published scope vocabulary (09 §4). Kept as a text[] rather than a pg enum: the set grows with every
 * endpoint family and an enum would need a migration per addition. Membership is validated in
 * @leadwolf/types at the boundary — the database stores what the API validated, and the API is its only
 * writer.
 *
 * These are the four the shipped picker already offers (settings-developer/types.ts SCOPE_OPTIONS) plus
 * `enrich:write`, which 09 §4 names. A scope whose endpoints are not built yet gates nothing — it is stored
 * because it is part of the published vocabulary, and a route starts honouring it the day it ships.
 */
export const API_KEY_SCOPES = [
  "search:read",
  "reveal:write",
  "enrich:write",
  "outreach:write",
  "export:write",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// ── api_keys — one machine credential per row, tenant- AND workspace-scoped ──────────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // The workspace every call made with this key acts in. NOT NULL: a key with no workspace would have to
    // take one from the request, which is the thing tenancy.md forbids.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(), // human label, e.g. "production backend"
    // SHA-256 hex of the plaintext key. Globally unique — see the header note on the pre-tenant lookup.
    keyHash: varchar("key_hash", { length: 255 }).notNull().unique(),
    // Non-secret display fragment. NOT an authentication input.
    keyPrefix: varchar("key_prefix", { length: 32 }).notNull(),
    scopes: text("scopes").array().notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    // Bumped best-effort on every authenticated call, so the management surface can show last-use and an
    // idle-then-active (possibly stolen) key is detectable. Monitoring, never an auth gate.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // tenant_id leads, per tenancy.md — the management list reads (tenant_id, created_at desc).
    index("api_keys_tenant_created_idx").on(table.tenantId, table.createdAt),
  ],
);
