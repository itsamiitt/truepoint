# 16 — Per-data-class retention engine (design record)

**Gate:** build-design (reconcile-and-cite). **Backlog:** data-management #6 (the storage-limitation engine).
**Spec pointers:** `08-compliance.md §7`, `ADR-0025` (freshness/decay), `11-phase4-access-governance-compliance.md`
(§4 flags it net-new; acceptance line 123 unmet). **Branch:** `feat/data-mgmt-01-research-brief`.

This complements the bulk-import record (doc 15). It is the on-branch design + DECISION record for the
time-based retention engine — written before code because the feature **deletes customer data**, so the
periods, the shadow-first posture, and the legal-deferred decisions must be explicit and reviewable.

## 1. Reconciled state (what exists vs the gap)

**Already built (cite):**
- DSAR subject-erasure fan-out — `core/compliance/deleteFanout.ts` + `dsarRepository.tombstone/purgeDependents/
  scanResiduals`. Hard-nulls contact PII, hard-deletes dependents, adds a **permanent global suppression** row,
  verifies zero residual. **NOT reusable as a retention enforcer** (it requires a verified request and suppresses
  forever — wrong for an age-out).
- Idempotency-key reclaim — `apps/workers/src/queues/retentionSweep.ts` (`email_retention_sweep`): leader-locked,
  daily, batched 5k, hardcoded 30d, `idempotencyRepository.deleteExpired`. **The sweep PATTERN is the template.**
- Per-tenant gating — `featureFlagRepository` + `isFlagEnabledForTenant` (override → global → default, fail-closed).
- Append-only audit — `audit_log` (triggers block UPDATE/DELETE), `writeAudit`.
- Soft-delete — only `contacts.deleted_at` (DSAR tombstone). Dependents hard-delete via FK CASCADE.

**The genuine gap:** NO time-based purge for any data class except idempotency keys; no policy store; no decay
compute; no scheduled re-verify loop. Everything else ages forever. (`11 §4` line 43/71-72/123 confirms net-new.)

## 2. Decisions (decided here from research; conservative + safe)

- **Shadow-first, OFF by default.** Each policy has a `mode ∈ {disabled, shadow, enforce}` defaulting to `shadow`,
  and the whole engine is gated by a per-tenant `retention_engine_enabled` flag defaulting **false**. A shadow run
  COUNTS + AUDITS candidates and deletes nothing. Nothing is ever deleted until a human flips a class to `enforce`
  AND enables the tenant flag. This is what makes the engine safe to build now without legal sign-off.
- **Per-CLASS control, GLOBAL periods (v1).** A single global `retention_policies` table keyed by `data_class`
  (not per-tenant rows) holds `ttl_days` + `mode`, seeded with the conservative defaults below. Per-tenant TTL
  overrides are a v2 concern; v1 gives per-tenant ENABLE (the flag) + per-class mode — enough for a class-by-class
  rollout (turn on `email_events` enforce first, `contacts` never without legal).
- **A dedicated `retention_policies` + `retention_runs` table** (not jsonb on tenants/workspaces) — explicit
  schema, auditable, the runs table is the shadow-mode evidence ("what WOULD delete").
- **A new per-class deleter, NOT deleteFanout.** Mirror `idempotencyRepository.deleteExpired` (batched
  `DELETE … WHERE <aging_ts> < now() - ttl LIMIT 5000 RETURNING id`) per class. No global suppression, no DSAR scan.
- **Sweep = leader-locked daily**, mirroring `retentionSweep`/`reverificationSweep`/the master-backfill sweep.
- **v1 scope = the LOW-RISK classes only** (no contact cascade, transient/low-PII, clean `created_at` aging):
  `email_event` (90d), `provider_calls` (90d), `enrichment_job_rows` (365d), `import_job_rows` (365d),
  `data_quality_snapshots` (730d), `verification_jobs` (730d). The contact-cascade classes (contacts, activities,
  contact_reveals, source_imports, consent_records) + `enforce` mode are **v2/phase 3** (the dependents-before-
  tombstone order + the PII stakes need the legal periods first).

## 3. Data classes (v1 in **bold**; aging ts; default; cascade)

| Class | Table | PII | Age on | Default TTL | Cascade | v1? |
|---|---|---|---|---|---|---|
| **Email tracking** | `email_event` | metadata jsonb | occurred_at | 90d | soft (set null) | ✅ |
| **Enrichment cache** | `provider_calls` | responsePayload jsonb | called_at | 90d | none | ✅ |
| **Enrichment ledger** | `enrichment_job_rows` | input/enriched jsonb | created_at | 365d | none (audit ptr) | ✅ |
| **Import ledger** | `import_job_rows` | input jsonb | created_at | 365d | none (audit ptr) | ✅ |
| **Data-health snapshots** | `data_quality_snapshots` | none | created_at | 730d | none | ✅ |
| **Verification jobs** | `verification_jobs` | none | created_at | 730d | none | ✅ |
| Contacts | `contacts` | names/email_enc/phone_enc/… | last_activity_at | null (tombstone only) | parent | v2 |
| Timeline | `activities` | metadata jsonb | occurred_at | 365d | with contact | v2 |
| Reveal events | `contact_reveals` | revealed_fields jsonb | revealed_at | 180d | with contact | v2 |
| Import provenance | `source_imports` | raw_data jsonb | imported_at | 730d (archive first) | with contact | v2 |
| Consent | `consent_records` | none | withdrawn_at | 180d post-withdrawal | with contact | v2 |
| Audit | `audit_log` | none | occurred_at | **null (never)** | none | legal |
| Idempotency | `idempotency_keys` | none | created_at | 30d (SHIPPED) | n/a | done |

Default periods anchor on ADR-0025 SLAs (email 90d, firmographics 180d) + GDPR storage-limitation; analytics/
ledger classes get 1–2y. All conservative; all start `shadow`.

## 4. Decisions deferred to business/legal (with a safe default that ships)

- `audit_log` retention → default **null (never auto-delete)**; 7y is typical — counsel/auditor confirm.
- `contacts` age-out (hard-delete vs perpetual tombstone) → default **null** (tombstone-only, as today); only a
  budget decision.
- `consent_records` post-withdrawal → default **180d**; counsel confirms the proof-of-withdrawal window.
- `source_imports` archive-to-S3-then-purge → S3 lifecycle is **infra-as-code, not this engine**; DB purge 730d.
- Export / rejected-rows artifacts (raw-PII S3 objects) → **S3 lifecycle TTL**, not DB retention (out of scope).

None block v1: every class ships in `shadow`, deleting nothing, so the engine is inert until a period is confirmed
and a class is flipped to `enforce`.

## 5. Build phases

1. **Schema + contract** — `@leadwolf/types` `retention.ts` (the `RetentionDataClass` enum, `RetentionMode`, the
   default-policy table, the run-summary DTO), `schema/retention.ts` (`retention_policies`, `retention_runs`),
   migration **0025**, `rls/retention.ts` (these are platform/owner-managed + per-tenant run rows), the
   `retentionPolicyRepository`/`retentionRunRepository`. **Safe — additive, no deletion logic.**
2. **Shadow sweep (low-risk classes)** — `core` per-class candidate-counters + the `dataRetentionSweep` worker
   (leader-locked daily; per tenant: gate on the flag; per class: read policy, COUNT candidates, write a
   `retention_runs` row; `shadow` ⇒ log + stop). Register in `register.ts` behind the flag. **Deletes nothing.**
3. **Enforce mode + the low-risk deleters** — the batched per-class `deleteExpired`-style deleters; a class in
   `enforce` deletes (batched, leader-locked, audited in `retention_runs` + `audit_log`). Still off until a class
   is flipped. Then the contact-cascade classes with the dependents-before-tombstone order + the residual scan.
4. **Per-tenant overrides + admin surface + the ADR-0025 decay/freshness compute** (`freshness_status` derive).

## 6. Open questions / risks

- The legal periods (§4) — shipped safe (shadow); confirm before any `enforce`.
- Partitioning: several classes "target monthly/daily partitioning" (not yet built); until then retention is a
  batched DELETE (fine at current scale; DROP-partition is the scale path — defer with the partitioning work).
- The sweep must be RLS-correct per class: workspace-scoped classes delete under `withTenantTx`; tenant/global
  classes (provider_calls) under the appropriate scope — settled per class in phase 2/3.
- Gates run in CI (no bun here): migration 0025 + RLS exercised by itests; `drizzle-kit` confirms the snapshot.
