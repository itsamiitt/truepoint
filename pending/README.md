# TruePoint — Pending Work Plan

> **Purpose:** a durable, pick-up-later plan for everything still open on the data-management /
> prospect-database track. For each item: what it is, **why it's blocked**, **the concrete fix**, and
> what gets built once the gate clears.
>
> **As of:** 2026-07-01 · **Branch:** `feat/data-mgmt-01-research-brief` · **main:** `3e388b6`
> (everything below marked "shipped" is merged to `main`).

---

## 0. Status snapshot — what's already done

**Shipped this track (on `main`):**
- Data-Ops admin control panel (read tier): overview, import drill-down + **reject histogram** (`0041`),
  enrichment/verification run monitors, fleet data-quality.
- **Item 6 metrics:** multi-source **coverage** proxy **and** the **true cross-source conflict rate**
  (`markConflicts` → `field_provenance.cf`, sync-import path, unit-tested).
- **Feature-flag control:** the admin Feature-flags page (global + per-tenant override, `flags:manage`),
  seeded `data_health.reverification` (`0046`), a read-only **env master-switch panel**.
- **Bulk-enrichment per-tenant dual-gate** (`bulk_enrichment_enabled`, `0048`).
- Concurrent workstreams also landed: export executor, maker-checker approval write-tier, retention
  policy editor + `retention_enforce` executor, validation framework, dedup review, billing/subscriptions,
  notifications, and **Teams/RBAC is in progress** (`0047_teams`).

**Not yet verified:** none of the above has run through `bun`/typecheck/tests in the build sandbox — see §1.

---

## 1. ⭐ The decisive gate — CI verification (do this first)

Nothing else should be trusted until this runs. It verifies ~65 commits and regenerates migration snapshots.

**Fix (run on a machine with `bun` + Docker/Postgres):**
```bash
bun install
bun run typecheck
biome check .
bun test                 # includes the new packages/core/src/prospect/conflictDetect.test.ts
bun run lint:boundaries
bunx drizzle-kit generate   # regenerates snapshots for 0041, 0046, 0048 (hand-written .sql, no snapshot yet)
# then the integration tests (Postgres):
bun test **/*.itest.ts
```
**Owner:** user (no `bun`/Docker in the agent sandbox — see memory `sandbox-no-push-creds`).
**Migrations awaiting snapshot regen:** `0041_import_reject_histogram`, `0046_seed_reverification_flag`,
`0048_seed_bulk_enrichment_flag`.
**If anything fails:** paste the output — the agent fixes it (as it did the `next build` nullable-prop break).

---

## 2. Pending BUILD items

### 2.1 `dedup_merge` / `bulk_delete` executors  🔒 security review
- **What:** the approval operations exist (`DATA_APPROVAL_OPERATIONS` in `packages/types/src/dataApproval.ts`)
  and can be **filed**, but the executor throws *"no executor is wired"* (`apps/api/src/features/admin/dataRoutes.ts:357`).
  Only `retention_enforce` + `bulk_export` execute today.
- **Why blocked:** executing means **destructive, cross-tenant master-graph writes** (merge clusters,
  re-point loser→survivor, re-project survivorship). A bug corrupts the shared entity graph across tenants.
  Per `CLAUDE.md` ("security has the final say") this needs a security review first.
- **The fix:** (1) security review of the merge/re-point write path + cross-tenant isolation; (2) then build.
- **Build once cleared:** a master-graph write repo (`confirmMatch` / `mergeClusters` / `splitCluster`),
  the overlay-bridge re-point (loser→survivor), a survivorship re-projection via `projection_outbox` + worker,
  wired into the existing maker-checker executor branch. Reuse `erRepository.ts`, `schema/masterGraph.ts`.
- **Prep doable now (no gate):** write the design + threat-model doc so the review is fast (see §5).

### 2.2 I6 chrome-extension landing pipeline  ⚖️ legal + security
- **What:** the capture connector exists (dark behind `CHROME_EXTENSION_ENABLED`); the async
  evidence→resolve→enrich→**surface** pipeline that would make scraped data visible does not.
- **Why blocked:** it **surfaces scraped PII** — a hard stop needing legal/ToS sign-off **and** a security
  review of the suppression-before-surface gate. Never surface scraped PII without those.
- **The fix:** (1) legal signs off on the scraping/ToS posture; (2) security signs off the
  suppression-before-surface proof; (3) then build.
- **Build once cleared:** the async landing pipeline with an **unbypassable suppression check before any
  surface**, per-source rate limits (already shipped), consent + lawful-basis gates (already in the connector).

### 2.3 S3 `FileStore` adapter  🔑 dep + creds
- **What:** prod object store for bulk import + export artifact delivery. Today only `diskFileStore` (dev).
- **Why blocked:** needs `@aws-sdk/client-s3` (a `bun install` — the agent can't touch the frozen lockfile)
  and bucket/region/credentials.
- **The fix:** (1) `bun add @aws-sdk/client-s3` (updates the lockfile); (2) bucket/region/keys in
  `.env.production`.
- **Build once cleared:** `s3FileStore.ts` implementing the `FileStore` port
  (`packages/core/src/storage/fileStore.ts` — `putObject`/`getObjectStream`/`getSignedDownloadUrl`/`putArtifact`),
  injected at `apps/api/src/features/import/bulkStore.ts`. **The adapter code can be written NOW** (see §5);
  it just won't typecheck/run until the dep is installed.
- **Unblocks:** the bulk-import enable-gate (`BULK_IMPORT_ENABLED` + `bulk_import_enabled`) and revealed-export delivery.

### 2.4 CRM sync (#7)  🔑 OAuth creds + scope decision
- **What:** bi-directional Salesforce/HubSpot sync. Plan exists: `docs/planning/crm-sync/00-enterprise-implementation-plan.md`.
- **Why blocked:** greenfield connectors + OAuth credentials + a scope decision.
- **The fix:** (1) register OAuth apps → client id/secret in env; (2) decide scope (which objects; one-way vs
  bi-directional; field mapping + source-of-truth); (3) then build incrementally.
- **Build once cleared:** connector abstraction → sync loop → write-back **conflict queue** (a field-level
  `crm_sync_conflicts` steward queue, distinct from the entity-level ER `match_links`).

### 2.5 Conflict rate — bulk-import path (deferred follow-up)  ⚙️ safe, but batched
- **What:** the true conflict rate (`markConflicts`) is wired into the **sync** import merge only. The
  high-volume **bulk** COPY path (`packages/core/src/import/bulkProcessChunk.ts`) doesn't compute it.
- **Why deferred:** the sync path does a per-row extra read (cheap for small files); doing that per-row in the
  bulk path would hurt throughput. Needs a **batched** existing-values fetch.
- **The fix (agent can do, low risk):** batch-load existing scalar values per chunk (mirror
  `getFieldProvenanceBatch`), call `markConflicts` per row, stamp `cf`. Bulk is dark anyway, so no urgency.

### 2.6 Teams / RBAC (#4)  ✅ handled elsewhere
- Being built by a concurrent workstream (`0047_teams` on `main`). No action here beyond letting it land + CI.

---

## 3. Built-but-DARK — the enable / flip checklist

These are already built; "fixing" them = clearing a precondition, then flipping the switch. Env switches are
set in `.env.production` then `bash deploy/deploy.sh` (read at boot — not UI-toggleable). Per-tenant flags flip
in the admin **Feature flags** page.

| Feature | Env master | Per-tenant flag | Precondition (the real fix) | Risk |
|---|---|---|---|---|
| Bulk import | `BULK_IMPORT_ENABLED` | `bulk_import_enabled` | prod **S3** (§2.3) | low |
| Bulk enrichment | `BULK_ENRICHMENT_ENABLED` | `bulk_enrichment_enabled` | **provider keys** (Apollo/ZoomInfo/Clearbit) | 💸 spends per match |
| ER shadow | `ER_SHADOW_ENABLED` (+ `INGESTION_EVIDENCE_ENABLED`) | — | calibrate weights/thresholds | low (shadow) |
| Re-verification | — | `data_health.reverification` | a **verifier** (Reacher/Twilio) configured | low |
| Retention (shadow) | — | `retention_engine_enabled` | none — counts only | low |
| Retention (delete) | — | + class → `enforce` (Retention policies) | **legal periods + sign-off** | 🗑️ destructive |
| Chrome capture | `CHROME_EXTENSION_ENABLED` | — | **legal** (§2.2) | ⚖️ scraping |
| Auth enforcement | `AUTH_POLICY_ENFORCEMENT_ENABLED` | tenant Auth-enforcement toggle | — | 🔒 lockout risk |

---

## 4. Recommended sequence

1. **Run CI** (§1) — verify everything shipped; regenerate the three snapshots. *Blocks trust in all of it.*
2. **Flip the safe dark features** — ER shadow + evidence, retention shadow. No creds, non-destructive.
3. **Provide credentials** as available: S3 (unblocks bulk import), verifier (unblocks re-verification),
   provider keys (unblocks bulk enrichment — spends).
4. **Schedule the security reviews** — dedup merge (§2.1), chrome landing (§2.2). Agent writes the design docs
   in parallel (§5) so the reviews are fast.
5. **CRM sync** (§2.4) — once OAuth creds + scope are decided.

---

## 5. Prep — DONE (ready for you to act on)

- ✅ **Dedup-merge design + threat model** → [`dedup-merge-design.md`](./dedup-merge-design.md). Hand this to
  security; it ends with the exact decisions/checklist they sign off. Once signed → agent builds §2.1.
- ✅ **S3 adapter — full code + setup** → [`s3-filestore-setup.md`](./s3-filestore-setup.md). §1 is the
  `bun add` + env "needful"; §2–§4 are the ready-to-commit files the agent lands after your `bun.lock` is updated.
- ⏳ **Bulk-path conflict detection** (§2.5) — safe/additive/batched; agent can do anytime. Just ask.

_Do the needful in the two docs above (run the review, run the `bun add`), and the agent starts implementing._

---

## 6. Reference

- **Flag keys:** `bulk_import_enabled`, `bulk_enrichment_enabled`, `retention_engine_enabled`,
  `data_health.reverification`. **Flag system:** two layers (env kill-switch + per-tenant `feature_flags`,
  dual-gate); admin control plane is generic — seed a flag and it appears. (memory: `feature-flag-control-plane`)
- **Migrations awaiting CI snapshot regen:** `0041`, `0046`, `0048`.
- **Key files:** `apps/api/src/features/admin/dataRoutes.ts` (approval executor seam),
  `packages/core/src/storage/fileStore.ts` (FileStore port), `apps/api/src/features/import/bulkStore.ts`
  (S3 injection point), `packages/core/src/prospect/conflictDetect.ts` (conflict marker),
  `packages/db/src/repositories/erRepository.ts` + `schema/masterGraph.ts` (ER layer),
  `docs/planning/crm-sync/00-enterprise-implementation-plan.md` (CRM plan).
- **Gate rule (non-negotiable):** never ship a destructive/cross-tenant master-graph write, surface scraped
  PII, or bypass suppression without the required review/sign-off — `CLAUDE.md` precedence: *security has the
  final say*.
