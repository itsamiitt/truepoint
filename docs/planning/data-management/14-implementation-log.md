# 14 — Implementation Log (data-management build)

> **Companion to the planning series (`00`–`13`).** Those docs are the *plan*; this is *what got
> built* on branch `feat/data-mgmt-01-research-brief`, so the branch is reviewable + validatable in
> one place. **Status: shipped + self-reviewed; NOT yet CI-validated** in the build sandbox (no
> `bun`/`drizzle-kit`/Docker here — see §6 for the gate the reviewer must run before merge).

## 1. What shipped, by backlog item (`13 §6`)

| # | Item | State | Key commits |
|---|---|---|---|
| 1 | **Verifier subsystem** | ✅ email + phone + carrier line-type | `b2c04a1` (Reacher + `hybridVerifier`, reveal-wired) · `cec26bb`/`d9ee5da` (Twilio phone verifier + `phone_line_type`) · `24f11c0` (local role/disposable pre-screen) · `1154c1c` (line-type read side) |
| 3 | **Freshness re-verification** | ✅ loop + sweep + per-tenant flag + audit ledger | `6148980` (`runReverification` + worker + sweep) · `d6b9e1d` (`data_health.reverification` flag) · `698496e` (`verification_jobs` ledger) · `c741146` (runs read) |
| 5 | **Quality metric dashboard** | ✅ per-contact badge + live aggregate + trend store + reads | `b538114` (per-contact badge on the list/search) · `e76231b` (`dataQualitySummary` + `GET /home/data-quality`) · `a5dd9c4` (`data_quality_snapshots` + daily sweep) · `b874d48` (trend read) |

The planning docs `00`–`13` (commits `7ff8290`…`deafb6a`) are the reconciled spec series this build
implements; the recurring finding (briefs' premises vs shipped code) is captured there + in `13 §5`.

## 2. Migrations (hand-authored — see §6)

The build sandbox has no `drizzle-kit`, so these were authored by mirroring existing migrations
(`0003` CREATE TABLE, `0017`/`0020` ADD COLUMN) + the snapshot format (`pipeline_stages`), and the
JSON was `node`-validated. The runtime migrator reads only `meta/_journal.json` + the `.sql`; the
`meta/NNNN_snapshot.json` is for `drizzle-kit` only (see the drift check in §6).

| Migration | Change |
|---|---|
| `0021_phone_line_type` | `ALTER TABLE contacts ADD COLUMN phone_line_type varchar(20)` (the TCPA mobile/landline signal). |
| `0022_verification_jobs` | New table `verification_jobs` (re-verification audit ledger) + 2 FKs + index + RLS. |
| `0023_data_quality_snapshots` | New table `data_quality_snapshots` (Data Health trend store) + 2 FKs + index + RLS. |

## 3. New tables + RLS

Both new tables are workspace-scoped, FORCE-RLS with the standard NULLIF workspace-isolation policy
(`rls/verificationJobs.sql`, `rls/dataQualitySnapshots.sql`, mirroring `enrichment_jobs`). Each has an
`*.itest.ts` proving per-workspace isolation (A sees own / B can't / BYPASSRLS admin can) —
`packages/db/test/verificationJobs.itest.ts`, `dataQualitySnapshots.itest.ts`.

## 4. New API endpoints (all under `home`, authn + tenancy + any-role)

| Endpoint | Returns |
|---|---|
| `GET /home/data-quality` | The live per-workspace fill/verification/freshness/line-type count rollup. |
| `GET /home/data-quality/history` | The daily Data Health trend series (from `data_quality_snapshots`). |
| `GET /home/data-quality/reverification-runs` | Recent re-verification runs (from `verification_jobs`). |

Per-contact Data Health badge (`dataHealth`) + `phoneLineType` now populate on `MaskedContact` from
the main list/search/export projection (`contactRepository.toMaskedContact`).

## 5. Workers, flags, config

- **Workers (leader-locked, daily):** `reverificationSweep` (fans out per-workspace re-verification),
  `dataQualitySnapshotSweep` (captures a per-workspace trend point). Registered in `apps/workers/register.ts`.
- **Per-tenant flag:** `data_health.reverification` (fail-closed/opt-in) gates the re-verification loop.
- **Config (all optional; absent → today's behaviour):** `REACHER_BACKEND_URL`/`REACHER_API_TOKEN`
  (email verifier), `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` (phone verifier + line-type — the latter
  is a paid Lookup add-on). The email verifier wraps Reacher with a zero-network role/disposable
  pre-screen to skip paid probes on the obvious cases.

## 6. CI validation checklist (run before merge)

Nothing below ran in the build sandbox. Required gates (`.github/workflows/ci.yml`):

1. `bun install --frozen-lockfile`
2. `bun run typecheck` · `bun run lint` (Biome — may want `biome check --write` for import-order nits)
   · `bun run lint:boundaries`
3. `bun test` (units, incl. the new `*.test.ts` for the verifiers, pre-screen, and the `home` routes)
4. The **itests** against real Postgres + Redis — these provision the DB via `applyMigrations`, so they
   exercise migrations **0021–0023** + the new **RLS isolation** itests. A bad `.sql`/journal fails here.
5. **`drizzle-kit generate`** — should be a **no-op**; a non-empty diff means a hand-authored snapshot
   (0021/0022/0023) drifted → regenerate that snapshot from the diff.

## 7. Deferred — NOT built (with rationale)

| Item | Why deferred |
|---|---|
| **#4 Teams/visibility + RBAC `org_role`** | Core decision (the role→permission matrix) is a product/security policy call — needs sign-off, not an autonomous guess; and it migrates every `is_tenant_owner` check (ADR-0030), high blast radius. |
| **#6 Per-data-class retention engine** | The purge predicate (what to delete, when, what's exempt) is a compliance/business decision; it deletes data. Build shadow-first (policy + dry-run scan) once the predicate is signed off. |
| **#2 Bulk COPY-staging pipeline** | Pure-technical but multi-tick (COPY staging + bulk merge + integration). |
| **#7 CRM sync + write-back + erasure propagation** | Multi-tick greenfield (connectors, conflict resolution). |
| **#8 Per-workspace ICP tuning** | ADR-0008 "revisit-if"; the weight *values* are config/business. |
| **Conflict-rate metric** (dashboard) | Needs cross-source value comparison (`field_provenance` stores only winners; the raw values live in `source_imports`) — a real analysis feature, not a single tick. |
| **Frontend Data Health view** (`apps/web`) | **Started**: a Data Health card on the home dashboard (`DataHealthCard` + `useDataQuality`) renders coverage/deliverability/freshness from `GET /home/data-quality`. The trend chart (history endpoint) + a dedicated page remain. |

## 8. Recommended next move

**Run the §6 gate on the branch.** Once green (or with the failures sent back), the highest-leverage
follow-ups are the **frontend Data Health view** (consumes §4) and — with a few inputs — **#6 retention**
(shadow-first) or **#4 RBAC**.
