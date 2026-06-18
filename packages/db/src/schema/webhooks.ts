// webhooks.ts — Drizzle schema for outbound webhooks (09 §10, 26 §4, G-INT-5: replay/self-test; M10).
// `webhook_subscriptions` (one per registered endpoint, workspace-scoped) + `webhook_deliveries` (the
// per-attempt log that backs the UI delivery table and the replay-from-log action). Closed enums use the
// varchar + CHECK idiom every schema unit here uses; the event set mirrors packages/types/src/webhooks.ts
// (that file is the source of truth). The signing secret is stored ENCRYPTED at rest (AES-256-GCM, bytea) —
// not plaintext, not a one-way hash: replay/self-test must recompute a VALID HMAC signature, which needs the
// recoverable secret. The plaintext is shown to the user only once (at create).

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

// Shared column idioms (kept local per the self-contained-schema convention used across this folder).
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── webhook_subscriptions — a registered outbound endpoint (workspace-scoped) ───────────────────────────
export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    url: varchar("url", { length: 2000 }).notNull(),
    // Closed event vocabulary stored as a text[] (mirrors packages/types webhookEvent). Subscribing to an
    // event the dispatcher doesn't emit is harmless; the api narrows the array to the enum at the edge.
    events: jsonb("events").notNull().default([]),
    // Signing secret, ENCRYPTED at rest (iv|tag|ciphertext) — recoverable to re-sign on replay/self-test.
    signingSecretEnc: bytea("signing_secret_enc").notNull(),
    // Non-secret display prefix (e.g. "whsec_a1b2…") shown in the subscriptions list.
    secretPrefix: varchar("secret_prefix", { length: 32 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Dashboard read path: a workspace's subscriptions newest-first.
    byWs: index("idx_webhook_subscriptions_ws").on(t.workspaceId, t.createdAt),
  }),
);

// ── webhook_deliveries — one row per dispatch attempt (incl. self-tests + replays); the delivery log ────
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(), // denormalized for direct RLS on this higher-volume table
    // The subscription this attempt targeted. SET NULL so deleting a subscription preserves its delivery
    // history (the log outlives the endpoint), without leaking it to another workspace (RLS still gates).
    webhookId: uuid("webhook_id").references(() => webhookSubscriptions.id, {
      onDelete: "set null",
    }),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    responseCode: integer("response_code"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Read path: a workspace's recent deliveries newest-first; and all attempts for one subscription.
    byWs: index("idx_webhook_deliveries_ws").on(t.workspaceId, t.attemptedAt),
    byWebhook: index("idx_webhook_deliveries_webhook").on(t.webhookId),
    statusEnum: check(
      "webhook_deliveries_status_enum",
      sql`${t.status} IN ('succeeded','failed','pending')`,
    ),
  }),
);
