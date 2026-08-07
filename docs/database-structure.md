# TruePoint database structure

One Postgres database serves the whole platform. This document explains how it is organized:
the schemas, the layered data model, the tenancy/RLS security model, the table catalog by
domain, and the conventions every table follows. It also records how the schema is deployed
to Supabase.

Source of truth: `packages/db/src/schema/*.ts` (Drizzle table definitions),
`packages/db/src/migrations/` (generated SQL, applied by hash from `meta/_journal.json`),
and `packages/db/src/rls/*.sql` (hand-written RLS policies, triggers, and grants).
`packages/db/src/applyMigrations.ts` applies everything in four idempotent phases:
**bootstrap** (extensions, roles, `uuid_generate_v7()`) → **journal migrations** →
**RLS files** → **grants**. A consolidated snapshot of the result lives at
`supabase/migrations/20260807000000_leadwolf_baseline.sql`.

## Schemas

| Schema | Purpose |
|---|---|
| `public` | The product database: tenant data, the Layer-0 master graph, billing, compliance, platform ops (~122 logical tables; 142 physical including partition children) |
| `forge` | The contribution-ingest data plane (TruePoint Forge): raw captures → parsed → verified → sync, plus its own ER and governance tables (21 tables). Firewalled behind the `leadwolf_forge` role — no grant on `public` |
| `drizzle` | `__drizzle_migrations` — the migration journal (content-hash rows) |

## The three-layer data model

The product's spine (per `docs/strategy/08-architecture.md`) is a strict separation between
the shared data universe, each customer's private copy of it, and the pipeline that feeds it:

```
forge schema                    Layer 0 (public)                Tenant overlay (public)
raw_captures → parsed_records   master_persons/_companies/      contacts, accounts,
→ verified_records → sync ────▶ _employment/_emails/_phones,    contact_emails/_phones,
  (leadwolf_forge role,           source_records, match_links     lists, tags, activities…
   promotion via leadwolf_er)     provenance_event                (workspace-scoped, RLS)
```

1. **Layer 0 — the master graph** (`master_persons`, `master_companies`, `master_employment`,
   `master_emails`, `master_phones`, `source_records`, `match_links`, `projection_outbox`,
   `provenance_event`). The shared universe of prospect data. These tables have **no tenant
   key** and therefore no RLS predicate; they are isolated by **access path**: all privileges
   are revoked from the customer app role (`REVOKE ALL … FROM leadwolf_app`, including a
   convention-based catch-all for any `master_*` table). Reads happen only through masked
   search, the paid-reveal copy path, or the audited platform path.
2. **Tenant overlay** — each workspace's own records (`contacts`, `accounts`, …), optionally
   linked to Layer 0 via `master_*_id` columns. Every row carries `tenant_id` **and**
   `workspace_id` and is guarded by RLS (below). A reveal copies data from Layer 0 into the
   overlay; the overlay row is the customer's to edit.
3. **Forge** — the contribution pipeline in its own schema, owned end-to-end by the
   `leadwolf_forge` role which has **no grant on `public`**, so ingest code can never read a
   customer's contacts (contributor anonymity, C-02). Promotion into the master graph is a
   separate hop under `leadwolf_er`.

Rule 5 of `CLAUDE.md` binds this together: **no ingestion path may write to the graph
without a `provenance_event`** — the append-only event log carrying source, contributor ref,
method, lawful basis, and payload for every field assertion (A-01). Field-level confidence is
a pure fold over these events (`packages/core/src/prospect/fieldProvenance.ts`), cached on
rows as `field_provenance` jsonb.

## Tenancy and security model

- **Two-tier scoping.** `tenant_id` (the customer organization) and `workspace_id` (a team
  space within it). Both are `NOT NULL` on tenant data; RLS keys off the workspace.
- **RLS everywhere on tenant data.** 106 tables have row-level security enabled (100
  policies; hand-written in `packages/db/src/rls/*.sql`, one file per domain). The canonical
  policy shape:

  ```sql
  ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
  CREATE POLICY contacts_workspace_isolation ON contacts
    USING     (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
    WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));
  ```

  The GUC `app.current_workspace_id` is set transaction-locally by `withTenantTx()` under the
  non-BYPASSRLS `leadwolf_app` role. `NULLIF(…, '')` makes an unset scope read **nothing**
  (fail-closed), and the scalar-subquery wrap lets the planner evaluate the GUC once per
  query instead of once per row.
- **Database roles** (created by the migrate bootstrap, cluster-level):

  | Role | Attributes | Purpose |
  |---|---|---|
  | `leadwolf_app` | LOGIN (self-hosted), non-BYPASSRLS | The customer application. All tenant queries run as this role via `withTenantTx`/`withReplicaTx`; RLS gates every row |
  | `leadwolf_admin` | NOLOGIN, BYPASSRLS where grantable | The audited cross-tenant path (DSAR fan-out, staff admin), reached only via `SET ROLE` from the owner (`withPrivilegedTx`) |
  | `leadwolf_er` | NOLOGIN, non-BYPASSRLS | Least-privilege entity-resolution role: reads the master graph, performs co-op-safe mints (`withErTx`). SELECT/INSERT/UPDATE on Layer 0 only — no DELETE, no overlay access |
  | `leadwolf_forge` | NOLOGIN (LOGIN optional) | Owns the `forge` schema data plane (`withForgeTx`); zero grants on `public` |

- **Platform-owned tables** are denied to `leadwolf_app` entirely (RLS deny-all **and**
  privilege revocation): `platform_audit_log`, `platform_staff`, `impersonation_sessions`,
  `jit_elevations`, `support_notes`, `account_holds`, `announcements`, `retention_policies`,
  `credit_packs`, `plan_templates`, `approval_requests`, `sub_processors`. Auth-service
  secrets tables (`user_mfa_methods`, `webauthn_credentials`, `auth_email_tokens`,
  `trusted_devices`) are owner-connection-only the same way.
- **Encrypted PII at the column level.** Sensitive values are stored app-encrypted as
  `bytea` `*_enc` columns with a `*_blind_index` companion for equality lookup (e.g.
  `contacts.email_enc` + `email_blind_index`; `contact_emails`, `contact_phones`,
  `master_emails`, `master_phones` follow the same pattern). Plaintext never lands in the
  database; only derived, non-reversible parts (e.g. `email_domain`) are queryable directly.

## Table catalog by domain

Grouped by the schema module that defines them (`packages/db/src/schema/<module>.ts`);
the RLS file of the same name carries the policies.

### Identity, auth, and tenancy (`auth.ts`, `teams.ts`, `scim.ts`)
- `users`, `user_sessions`, `user_mfa_methods`, `webauthn_credentials`, `auth_email_tokens`,
  `trusted_devices` — user-scoped auth service data (owner-connection only).
- `tenants`, `workspaces`, `tenant_members`, `workspace_members`, `invitations`,
  `tenant_domains` — the two-tier org structure and membership.
- `auth_policies`, `tenant_auth_policies`, `tenant_sso_configs`, `auth_allowed_origins`,
  `oauth_connect_state`, `scim_tokens` — login policy, SSO/SAML/OIDC config (secrets stored
  `*_enc`), SCIM provisioning.
- `teams`, `team_members` — team grouping within a workspace.

### Prospect data — the tenant overlay (`contacts.ts`, `contactChannels.ts`, `accountChildren.ts`, `lists.ts`, `tags.ts`, `pipelineStages.ts`, `customFields.ts`, `savedSearches.ts`, `salesnav.ts`, `intel.ts`)
- `contacts`, `accounts` — the core records; `master_*_id` links to Layer 0, `is_revealed`,
  per-field `custom_fields` jsonb, soft delete via `deleted_at`, `duplicate_of_contact_id`
  for merges.
- `contact_emails`, `contact_phones` — multi-channel storage (encrypted value + blind index,
  verification status, primary/promoted flags).
- `account_domains`, `account_locations` — account hierarchy detail.
- `lists`, `list_members`, `tags`, `record_tags`, `pipeline_stages`, `custom_field_definitions`,
  `saved_searches`, `sales_nav_links`, `intent_signals`, `scores` — organization, scoring,
  and search over the dataset.
- `activities` — timeline events, **range-partitioned by month** (`activities_2026_08` …
  plus `activities_default`).

### Layer 0 — master graph (`masterGraph.ts`, `provenanceEvent.ts`, `projectionOutbox.ts`, `processedSyncEvents.ts`)
- `master_persons`, `master_companies`, `master_employment`, `master_emails`, `master_phones`
  — the shared universe (person is PII-minimal; employment carries job-change/decay
  semantics, S-09/S-13).
- `source_records`, `match_links` — ER inputs and identity links.
- `provenance_event` — the append-only assertion log (partitioned by month; an
  append-only trigger refuses mutation regardless of role).
- `projection_outbox`, `processed_sync_events` — graph-to-overlay projection plumbing.

### Contribution ingest — the `forge` schema (`forge.ts`)
`raw_captures`, `capture_batches`, `parsers`, `parser_versions`, `extraction_runs`,
`extraction_candidates`, `parsed_records`, `verified_records`, `verified_record_events`,
`quarantine`, `review_tasks`, `approval_requests`, `match_candidates`, `match_links`,
`merge_log`, `master_id_map`, `contributor`, `contributor_consent`, `sync_state`,
`sync_outbox`, `forge_audit_log` — the raw→parsed→verified pipeline, its ER, contributor
identity + consent (kept **only** here, C-02), and its audit trail.

### Contribution controls (`enrichmentPolicy.ts` / rls `contributionControls.sql`)
`contribution_policy`, `contribution_exclusion`, `crm_object_contribution`, `enrichment_policy`
— what a tenant allows to flow outward, with per-object exclusions (C-02).

### Jobs and pipelines (`enrichmentJobs.ts`, `verificationJobs.ts`, `revealJobs.ts`, `importJobs.ts`, `scheduledImports.ts`, `importMappingTemplates.ts`, `importPolicy.ts`, `validationRules.ts`, `dataQualitySnapshots.ts`)
- `enrichment_jobs` / `_chunks` / `_rows`, `verification_jobs`, `reveal_jobs` / `reveal_job_rows`
  — bulk async work, chunked for BullMQ workers.
- `import_jobs` / `_chunks` / `_rows`, `source_imports`, `scheduled_imports`,
  `import_mapping_templates`, `import_policy`, `validation_rules` — the CSV/API import
  pipeline with mapping, validation, and policy gates.
- `data_quality_snapshots` — per-workspace quality metrics over time (S-08/S-10).
- `provider_configs`, `provider_calls` — external enrichment/verification vendor config and
  metered call log.

### Billing and entitlements (`subscriptions.ts`, `billing.ts`, `entitlement.ts`, `usageEvent.ts`, `featureFlags.ts`)
- `subscriptions`, `billing_cycles`, `stripe_customers`, `purchases`, `plan_templates`,
  `credit_packs` — freemium tiers (Free / Community / Pro / Team) and Stripe linkage.
- `credit_ledger` — the **purchased** reveal-credit settlement ledger (append-only trigger;
  deliberately *not* a contributor-earned currency — see `CLAUDE.md` rule 7).
- `entitlement`, `usage_event` (partitioned monthly), `feature_flags`, `tenant_feature_flags`
  — feature caps above credits, metering, and flag gating.

### Compliance (`compliance.ts`, `retention.ts`)
`suppression_list` (checked at every egress), `consent_records`, `dsar_requests`,
`retention_policies`, `retention_class_policies`, `retention_runs`, `audit_log`
(append-only trigger) — GDPR/DPDP machinery: suppression, consent, DSAR orchestration,
retention classes and sweeps (A-01/A-02).

### Outreach and email (`outreach.ts`, `email.ts`)
`outreach_sequences`, `outreach_steps`, `outreach_log`, `email_thread`, `email_message`,
`email_event`, `email_template`, `email_template_version`, `mailbox_integration`,
`sending_domain` — outreach logging and mailbox metadata (message *bodies* are never
captured — hard constraint 4).

### CRM connectors (`crm.ts` — dark behind `CRM_SYNC_ENABLED`)
`crm_connections`, `crm_oauth_states`, `crm_field_mappings`, `crm_record_links`,
`crm_sync_state`, `crm_sync_runs`, `crm_inbound_events`, `crm_sync_conflicts`,
`crm_sync_dead_letter` — two-way CRM sync with field-level contribution controls.

### Platform operations (`platformOps.ts`, `aiRequests.ts`, `notifications.ts`, `webhooks.ts`)
- `platform_staff`, `impersonation_sessions`, `jit_elevations`, `support_notes`,
  `account_holds`, `announcements`, `approval_requests`, `sub_processors`,
  `platform_audit_log` (partitioned monthly) — staff/admin surface, all denied to the
  customer app role.
- `ai_requests`, `notifications`, `webhook_subscriptions`, `webhook_deliveries` — AI call
  audit, in-app notifications, outbound webhooks.

### Reliability plumbing (`eventOutbox.ts`, `workerOutbox.ts`, misc)
`event_outbox`, `worker_outbox`, `idempotency_keys` — transactional outboxes for exactly-once
event publication and API idempotency (`Idempotency-Key` per the `/api/v1` contract).

## Conventions

- **Primary keys** are `uuid` defaulting to `uuid_generate_v7()` (time-ordered UUIDs; the
  function is created in the migrate bootstrap).
- **Timestamps**: `created_at` / `updated_at` `timestamptz NOT NULL DEFAULT now()`; a shared
  `set_updated_at()` trigger maintains `updated_at` on every RLS-covered table.
- **Soft delete** via `deleted_at` on customer-visible records; hard deletion is the audited
  DSAR fan-out.
- **Partitioning**: `activities`, `usage_event`, `provenance_event`, `platform_audit_log`
  are range-partitioned by month with a `_default` partition; a partition-maintenance worker
  creates months ahead.
- **Append-only tables** (`audit_log`, `credit_ledger`, `provenance_event`) enforce
  immutability with triggers that raise on UPDATE/DELETE — the guarantee holds regardless of
  role.
- **Extensions**: `pgcrypto`, `citext` (case-insensitive emails/domains), `pg_trgm`
  (trigram search indexes for name/company search).
- **Migrations are forward-only** and identified by content hash (renames are free; editing
  an applied file creates a *new* migration). Statement-level tolerance exists only for
  "already exists" DDL errors.

## Supabase deployment

The schema is deployed to the Supabase project **Closo** (`ntpmucqftmrbxtvtccgu`,
Postgres 17) from the consolidated baseline
`supabase/migrations/20260807000000_leadwolf_baseline.sql` — the exact output of running the
repo migrator against a clean Postgres and dumping schema-only. Verified after push:
142 public + 21 forge tables, 100 RLS policies on 106 RLS-enabled tables, 89 functions,
51 triggers, all four `leadwolf_*` roles, and the drizzle journal preloaded with all 99
migration hashes — so a future `applyMigrations` run against this database converges as a
no-op and only applies *new* migrations.

Supabase-specific deviations to be aware of:

1. **All `leadwolf_*` roles are NOLOGIN there** (including `leadwolf_app`). The database is
   publicly reachable, so no login password was provisioned. To connect an app as
   `leadwolf_app`, rotate in a strong password first:
   `ALTER ROLE leadwolf_app LOGIN PASSWORD '<new strong password>';`
2. **`leadwolf_admin` has no BYPASSRLS** — Supabase's `postgres` role is not a superuser, so
   the bootstrap's guarded `ALTER ROLE … BYPASSRLS` is skipped (same as on Neon). The
   privileged path still works via `SET ROLE` from the owner, which is exempt from
   `ENABLE`-only RLS but subject to `FORCE ROW LEVEL SECURITY` tables' policies only when
   not the table owner — in practice the owner connection (`postgres`) owns the tables.
3. **Extensions** `citext` and `pg_trgm` are installed in `public` (matching the repo's
   dump); `pgcrypto` was already present in Supabase's `extensions` schema and is unused by
   name in the DDL (`gen_random_uuid()` is built-in on PG17).
4. Supabase's platform schemas (`auth`, `storage`, `realtime`, …) coexist with the app
   schemas and are untouched; TruePoint's own `users`/auth tables are unrelated to Supabase
   Auth.
