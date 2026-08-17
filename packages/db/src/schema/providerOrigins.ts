// providerOrigins.ts — the data-source ORIGIN fleet for external providers (migration 0117;
// docs/planning/linkedin-source-ingestion/ §origins). One provider (today: 'linkedin_api') is served by
// MANY interchangeable origins — data.truepoint.in, expo.truepoint.in, … — each exposing the SAME POST
// contract (/api/linkedin/profile, /api/linkedin/company). The fetch layer walks these as a FAILOVER
// CHAIN in priority order (recorded user decision 2026-08-16).
//
// WHY A NEW TABLE and not provider_configs: that table is PK=provider — exactly one row per provider, no
// url, and DELIBERATELY no secret column. Origins are the axis that grows per deployment, and each carries
// its own API key. The key is stored AES-GCM-encrypted (the crm oauth_token_enc precedent — DB-stored
// encrypted secrets with a masked hint in every view, never the secret); encryption/decryption happens at
// the CORE boundary (packages/db cannot import core), so this schema only ever sees bytea.
//
// ACCESS MODEL: platform-global config holding secrets — leadwolf_app is REVOKEd ENTIRELY in
// applyMigrations (this table is NOT master_*-prefixed, so the convention loop does not cover it; the
// explicit REVOKE is load-bearing). Reads happen on the owner connection (withPlatformReadTx via the core
// origin router's 60s cache); writes are staff-only through withPlatformTx (audited).

import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

export const providerOrigins = pgTable(
  "provider_origins",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v7()`),
    provider: varchar("provider", { length: 50 }).notNull(), // 'linkedin_api' today; generic on purpose
    label: varchar("label", { length: 100 }).notNull(), // "data", "expo" — operator-facing name
    baseUrl: varchar("base_url", { length: 500 }).notNull(), // https origin; validated https at the edge
    apiKeyEnc: bytea("api_key_enc"), // AES-GCM ciphertext; NULL = keyless origin (private network)
    apiKeyHint: varchar("api_key_hint", { length: 12 }), // masked tail ("…x7Q2") for the console
    priority: integer("priority").notNull().default(100), // failover order, ascending
    paused: boolean("paused").notNull().default(false), // operator kill per origin
    // Passive health, written by the fetch layer's recordOutcome — the console's health badge.
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: varchar("last_error", { length: 500 }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqProviderUrl: uniqueIndex("uniq_provider_origins_provider_url").on(t.provider, t.baseUrl),
  }),
);
