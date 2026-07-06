-- 0061_account_children_and_hierarchy.sql — the 06-family DDL substrate
-- (import-and-data-model-redesign 06 §§1–4; 07 §3/§4/§8; 15 §M-SEQ Phase-4 rows seq 53/56/57/58).
--
-- STEP BOUNDARY (15 §M-SEQ): this migration bundles the ADDITIVE, DDL-ONLY slices of FOUR sequenced steps —
--   • seq 53 S-A1 — `account_domains` table + uniques + RLS   (DDL "additive")
--   • seq 56 S-A3 — `account_locations` table + primary unique + RLS   (DDL "additive")
--   • seq 57 S-A4 — `parent_account_id` + `root_account_id` + `uniq_accounts_ws_id` + composite same-workspace
--                   FK + self-parent CHECK + `idx_accounts_ws_root`   (DDL "additive")
--   • seq 58 S-A5 — `accounts.deleted_at` (G18) + online swap of `uniq_accounts_ws_domain` → live-only partial
--                   (DDL "additive (online index swap)")
-- It DELIBERATELY EXCLUDES the write-path / data steps 15 sequences LATER in the same family, left to the
-- next task: S-A1/S-A3 BACKFILL passes (data), seq 54 S-A2 dual-write, seq 55 the S-A1 backfill re-run, and
-- seq 59 S-A6 read cutover + ladder rung C2. Bundling the DDL is safe because ALL of it is additive dead
-- schema (07 §8: "Everything is additive; no column is renamed or dropped anywhere in this series") — nothing
-- reads or writes these tables/columns until S-A2 (dual-write) and, for reads, S-A6's per-tenant flag. The
-- gates 15 places BETWEEN these steps are backfill/dual-write ordering gates, not DDL-ordering gates.
--
-- INERT: the flat caches remain authoritative and untouched — `accounts.domain` (primary-domain cache),
-- `accounts.hq_country`/`hq_city` (primary-location cache). No code path constructs a child row or reads a
-- hierarchy field yet. Adding `AND deleted_at IS NULL` to the domain unique is behaviour-neutral today
-- because nothing writes `accounts.deleted_at` until S-A5's write-path lands (deleted_at is always NULL ⇒
-- the predicate is identically satisfied for every existing row).
--
-- Design facts pinned from the spec (06/07):
--   • Child tables carry denormalized NOT NULL tenant_id + workspace_id on EVERY row; RLS (ENABLE+FORCE,
--     fail-closed NULLIF workspace GUC) is DIRECT on workspace_id, never derived through the accounts join
--     (rls/accountChildren.sql — the import_job_rows / contact_emails precedent, 06 §Security).
--   • Domains + office addresses are NON-PII (06 §1/§3): stored CLEAR (citext domain; plain address text) —
--     the deliberate contrast with doc 05's encrypted channel values. Nothing here is encrypted or blind-indexed.
--   • account_domains provenance trio = source / source_import_id / pinned + verified_at (06 §1); the whole-set
--     ws-domain partial unique (`uniq_account_domains_ws_domain`) is what makes rung C2 "any-domain exact" safe.
--   • account_locations carries source + pinned but DELIBERATELY NO source_import_id lineage FK — locations are
--     subordinate to company identity and NEVER a dedup key (06 §3), so 07 §3's FK inventory lists only
--     tenant/workspace + account_id for this table (and 07 §2.2 draws no locations→source_imports edge). See
--     doc 16 drift row. `country` is char(2) NULL (ISO-3166 alpha-2; NULL when source was unmappable freetext).
--   • FKs (07 §3): account_id → accounts CASCADE on BOTH child tables (hard-purge/retention fanout ONLY —
--     product delete is soft via deleted_at); account_domains.source_import_id → source_imports SET NULL;
--     tenant/workspace → CASCADE. At-most-one live primary per account per child table (`uniq_*_primary`).
--   • Hierarchy (S-A4, 06 §2): `parent_account_id` is guarded by a COMPOSITE same-workspace FK
--     (workspace_id, parent_account_id) → accounts(workspace_id, id), which needs `uniq_accounts_ws_id`
--     UNIQUE(workspace_id, id) as its target (a plain unique INDEX is NOT a valid FK target — a unique
--     CONSTRAINT is required). This makes a cross-workspace parent a DB impossibility (a plain FK to id would
--     bypass RLS — 06 §2). `root_account_id` is a bare uuid denormalized ultimate-parent pointer with NO FK
--     (07 §2.2 draws it FK-less; it is a recomputed cache, family key = COALESCE(root_account_id, id)). The
--     self-parent CHECK is the DB backstop; the cycle guard + depth-10 cap + root recompute are APP-LAYER
--     (write-path step — NOT this migration).
--   • ON DELETE for the composite FK uses PG15+ COLUMN-TARGETED SET NULL — `SET NULL (parent_account_id)` —
--     because a plain `SET NULL` would try to null workspace_id too (NOT NULL ⇒ would error). 06/07 specify
--     "SET NULL on purge" without the column-list nuance; resolved here (PG16, itestDb.ts) + doc 16 drift row.
--
-- NO audit-action CHECK extension in this train (15 ruling M1: the CHECK is extended once per phase with
-- exactly the actions THAT phase's VERBS write — the 06-family DDL steps write no audit action; coarse
-- account.create/.update/.delete already exist. Fine-grained domain/location attach/detach/promote actions,
-- if any are minted, ride the write-path step, not this DDL substrate). NO retention-class seed rows either
-- (07 §8 / 15 assign NONE to the 06 family — the deliberate contrast with S-CH1/0058, which 05 §7 DID assign;
-- the account tombstone retention class rides data-management/16's enforce-mode, not this program's DDL).
--
-- RLS (ENABLE+FORCE) + grants + set_updated_at triggers for the two child tables live in
-- rls/accountChildren.sql (applied by applyMigrations' rls/*.sql pass). accounts already has its policy +
-- trigger (rls/contacts.sql) — the new columns inherit them, no RLS change needed for accounts.

-- ── seq 53 · S-A1 — account_domains ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "account_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"domain" citext NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"source" varchar(30) NOT NULL,
	"source_import_id" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_domains_source_enum" CHECK ("account_domains"."source" IN ('import','enrichment','manual','master_suggestion'))
);--> statement-breakpoint

-- ── seq 56 · S-A3 — account_locations ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "account_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"type" varchar(10) NOT NULL,
	"line1" varchar(255),
	"line2" varchar(255),
	"city" varchar(100),
	"region" varchar(100),
	"postal_code" varchar(20),
	"country" char(2),
	"is_primary" boolean DEFAULT false NOT NULL,
	"source" varchar(30) NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_locations_type_enum" CHECK ("account_locations"."type" IN ('hq','branch','office')),
	CONSTRAINT "account_locations_source_enum" CHECK ("account_locations"."source" IN ('import','enrichment','manual','master_suggestion'))
);--> statement-breakpoint

-- FKs (07 §3). Idempotent DO-block guard mirrors 0058's pattern.
DO $$ BEGIN
 ALTER TABLE "account_domains" ADD CONSTRAINT "account_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_domains" ADD CONSTRAINT "account_domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_domains" ADD CONSTRAINT "account_domains_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_domains" ADD CONSTRAINT "account_domains_source_import_id_source_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."source_imports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_locations" ADD CONSTRAINT "account_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_locations" ADD CONSTRAINT "account_locations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_locations" ADD CONSTRAINT "account_locations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Child-table uniques + fetch indexes (07 §4.1/§4.2). Partial on live rows so a tombstone releases the key.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_account_domains_ws_domain" ON "account_domains" USING btree ("workspace_id","domain") WHERE "account_domains"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_account_domains_primary" ON "account_domains" USING btree ("account_id") WHERE "account_domains"."is_primary" AND "account_domains"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_domains_account" ON "account_domains" USING btree ("account_id") WHERE "account_domains"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_account_locations_primary" ON "account_locations" USING btree ("account_id") WHERE "account_locations"."is_primary" AND "account_locations"."deleted_at" IS NULL;--> statement-breakpoint

-- ── seq 57 · S-A4 — accounts hierarchy columns + composite same-workspace FK + self-parent CHECK ─────────
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "parent_account_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "root_account_id" uuid;--> statement-breakpoint
-- ── seq 58 · S-A5 — accounts soft-delete (G18) ──────────────────────────────────────────────────────────
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint

-- The FK-target unique CONSTRAINT (not a bare index — a composite FK requires a unique/PK constraint on its
-- referenced columns). This is what makes cross-workspace parentage structurally impossible (06 §2).
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "uniq_accounts_ws_id" UNIQUE ("workspace_id","id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Composite same-workspace self-FK. ON DELETE uses PG15+ column-targeted SET NULL so ONLY parent_account_id
-- is nulled on a rare hard purge (a plain SET NULL would try to null the NOT NULL workspace_id and error).
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ws_parent_account_fk" FOREIGN KEY ("workspace_id","parent_account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE SET NULL ("parent_account_id") ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Self-parent block (DB backstop; app validation rejects it first with an RFC 9457 error — 06 §2).
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_not_self" CHECK ("parent_account_id" IS NULL OR "parent_account_id" <> "id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Family reads without recursive CTEs (07 §4.2); live-hierarchy nodes only.
CREATE INDEX IF NOT EXISTS "idx_accounts_ws_root" ON "accounts" USING btree ("workspace_id","root_account_id") WHERE "accounts"."root_account_id" IS NOT NULL;--> statement-breakpoint

-- ── seq 58 · S-A5 — online swap of uniq_accounts_ws_domain → live-only partial (07 §4.1) ─────────────────
-- The unique gains `AND deleted_at IS NULL` so a soft-deleted account RELEASES its domain (06 §4). Behaviour-
-- neutral today (deleted_at is always NULL until the S-A5 write path). PRODUCTION EXECUTION NOTE: prod runs
-- the true ONLINE swap — CREATE UNIQUE INDEX CONCURRENTLY <new name> … ; DROP INDEX CONCURRENTLY
-- uniq_accounts_ws_domain; ALTER INDEX <new> RENAME — to avoid a write-blocking window. Here (fresh/empty CI
-- DBs, migrator runs in a txn where CONCURRENTLY is illegal) the drop-then-recreate under the same name is
-- equivalent and keeps the Drizzle mirror's index name stable. See doc 16.
DROP INDEX IF EXISTS "uniq_accounts_ws_domain";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_accounts_ws_domain" ON "accounts" USING btree ("workspace_id","domain") WHERE "accounts"."domain" IS NOT NULL AND "accounts"."deleted_at" IS NULL;

-- DOWN (manual, per 15 §R-P4 — reversible ONLY in the never-written case, i.e. before S-A2 dual-write ran;
-- the production rollback lever is the S-A6 per-tenant flag, never this down — 15 rule 2):
--   -- restore the pre-S-A5 domain unique:
--   DROP INDEX IF EXISTS uniq_accounts_ws_domain;
--   CREATE UNIQUE INDEX uniq_accounts_ws_domain ON accounts (workspace_id, domain) WHERE domain IS NOT NULL;
--   DROP INDEX IF EXISTS idx_accounts_ws_root;
--   ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_parent_not_self;
--   ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_ws_parent_account_fk;
--   ALTER TABLE accounts DROP CONSTRAINT IF EXISTS uniq_accounts_ws_id;
--   ALTER TABLE accounts DROP COLUMN IF EXISTS deleted_at;
--   ALTER TABLE accounts DROP COLUMN IF EXISTS root_account_id;
--   ALTER TABLE accounts DROP COLUMN IF EXISTS parent_account_id;
--   DROP TABLE IF EXISTS account_locations;  -- drops its indexes, CHECKs, FKs, policies, triggers with it
--   DROP TABLE IF EXISTS account_domains;
