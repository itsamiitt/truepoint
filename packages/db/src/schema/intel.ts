// intel.ts — Drizzle schema for the intelligence layer (03 §6, ADR-0008) + enrichment cost/cache (03 §8):
// `scores` (append-per-rescore; the AFTER INSERT trigger in rls/intel.sql syncs contacts.priority_score),
// `intent_signals` (typed, weighted), `provider_calls` (request-hash cache + cost_micros tracking).
// NOTE: 03 §12 targets monthly range-partitioning for all three; plain tables until volume warrants.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
const contactId = () =>
  uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" });

// ── scores — versioned: every re-score APPENDS (ADR-0008); history stays explainable ───────────────────
export const scores = pgTable(
  "scores",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: contactId(),
    icpFit: integer("icp_fit").notNull(),
    intentScore: integer("intent_score").notNull(),
    engagementScore: integer("engagement_score").notNull(),
    compositeScore: integer("composite_score").notNull(),
    scoreBreakdown: jsonb("score_breakdown").notNull().default({}),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ranges: check(
      "scores_ranges",
      sql`${t.icpFit} BETWEEN 0 AND 100 AND ${t.intentScore} BETWEEN 0 AND 100
       AND ${t.engagementScore} BETWEEN 0 AND 100 AND ${t.compositeScore} BETWEEN 0 AND 100`,
    ),
  }),
);

// ── intent_signals — typed + weighted; feed the intent component (03 §6) ───────────────────────────────
export const intentSignals = pgTable(
  "intent_signals",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    contactId: contactId(),
    signalType: varchar("signal_type", { length: 50 }).notNull(),
    signalSource: varchar("signal_source", { length: 50 }),
    detail: varchar("detail", { length: 500 }),
    weight: integer("weight").notNull().default(1),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeEnum: check(
      "intent_signals_type_enum",
      sql`${t.signalType} IN ('job_change','new_hire','funding_round','tech_install','web_visit',
        'content_engagement','keyword_search','linkedin_activity','sales_nav_view')`,
    ),
    weightRange: check("intent_signals_weight_range", sql`${t.weight} BETWEEN 1 AND 10`),
  }),
);

// ── provider_calls — cache-first + cost-aware enrichment ledger (06 §5/§6) ─────────────────────────────
export const providerCalls = pgTable(
  "provider_calls",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    providerName: varchar("provider_name", { length: 50 }).notNull(),
    requestHash: bytea("request_hash").notNull(), // sha256(provider + normalized request) — the cache key
    status: varchar("status", { length: 20 }).notNull(), // hit|miss|rate_limited|error
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    cacheHit: boolean("cache_hit").notNull().default(false),
    responsePayload: jsonb("response_payload"), // verbatim payload for cache replays (TTL pruned later)
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One persisted answer per (workspace, request) — concurrent duplicates collapse onto it.
    uniqWsHash: uniqueIndex("uniq_provider_calls_ws_hash").on(t.workspaceId, t.requestHash),
    // Dashboard "recent provider calls" / enrichment-cost feed (providerCallRepository: WHERE workspace_id ...
    // ORDER BY called_at DESC): composite with workspace_id so the recency read stays index-backed under the
    // RLS workspace predicate instead of a seq-scan + sort on this high-volume ledger (perf RC#9).
    wsCalledAtIdx: index("idx_provider_calls_ws_called_at").on(t.workspaceId, t.calledAt.desc()),
    statusEnum: check(
      "provider_calls_status_enum",
      sql`${t.status} IN ('hit','miss','rate_limited','error')`,
    ),
  }),
);

// ── provider_configs — PLATFORM-global enrichment-provider settings (13 §3.6): enable/disable + the
// per-month cost budget + rate cap. NO secrets here (provider API keys live in env/KMS). Read by the
// platform-admin console (owner) and the enrichment budget breaker (the app role may SELECT — it is global
// config, not tenant data); only the owner/withPlatformTx path writes it (rls/providerConfigs.sql).
export const providerConfigs = pgTable("provider_configs", {
  provider: varchar("provider", { length: 50 }).primaryKey(), // apollo|zoominfo|clearbit|…
  label: varchar("label", { length: 100 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  rateLimitPerMin: integer("rate_limit_per_min"), // null = unlimited
  monthlyBudgetCents: integer("monthly_budget_cents"), // null = unset
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
