# ⚠ Main-merge integration TODO — migrations RENUMBERED `0029–0034`; snapshot regen + gates still pending

This branch is the result of merging `origin/main` into `feat/data-mgmt-01-research-brief`
(integration branch `integrate/main-into-data-mgmt`). The **code** conflicts are fully resolved, and
feat's six migrations have now been **renumbered `0021…0026` → `0029…0034`** with matching `_journal.json`
entries (`idx` 29–34). The branch is therefore **migrate-able and itest-validatable** — the runtime
migrator (`drizzle-orm/postgres-js/migrator` via `applyMigrations.ts`) reads only the journal + `.sql`.
What remains needs `bun drizzle-kit` (absent in the merge sandbox): the Drizzle **snapshot** regen + the
gate suite. **Do not fast-forward `main` until the snapshots are stitched and the gates pass.**

## What happened

`main` and `feat` both forked at `0020_late_auth_enforcement` and then independently used migration
numbers **0021–0026** for *different* migrations:

| #    | main (now on trunk)        | feat (renumbered → )                    | new # |
|------|----------------------------|-----------------------------------------|-------|
| 0021 | `opposite_randall`         | `phone_line_type`                       | 0029  |
| 0022 | `organic_earthquake`       | `verification_jobs`                     | 0030  |
| 0023 | `steep_ultragirl`          | `data_quality_snapshots`                | 0031  |
| 0024 | `silent_quasimodo`         | `bulk_import_jobs`                       | 0032  |
| 0025 | `nappy_albert_cleary`      | `retention_engine`                      | 0033  |
| 0026 | `email_p1_inbound`         | `seed_rollout_flags`                    | 0034  |
| 0027 | `fixed_purple_man`         | —                                       |       |
| 0028 | `outstanding_venom`        | —                                       |       |

The merge kept main's valid chain in `meta/_journal.json` + `meta/00{21..28}_snapshot.json` (entries
`0000`–`0028`). feat's six SQL files have now been **renumbered** to `0029_phone_line_type.sql` …
`0034_seed_rollout_flags.sql` and **journaled** (`idx` 29–34), so `migrate` applies them after main's
`0028`. Their content is unchanged — it **preserves the hand-written DDL + seed SQL** that
`drizzle-kit generate` cannot reproduce (see MED-1). The `meta/00{29..34}_snapshot.json` files do **not**
yet exist (snapshots are not read at migrate time) — that is the remaining CI step.

## Architectural collision already resolved in code: `retention_policies`

Both branches shipped a table literally named `retention_policies` with incompatible columns. Per the
merge decision, **feat's retention-ENGINE side was renamed** so both features coexist:

- table `retention_policies` → **`retention_class_policies`** (`schema/retention.ts`, `rls/retention.sql`,
  the `0033_retention_engine.sql` migration)
- Drizzle const `retentionPolicies` → **`retentionClassPolicies`**
- repo `retentionPolicyRepository` → **`retentionClassPolicyRepository`** (new file
  `repositories/retentionClassPolicyRepository.ts`; callers: `core/.../runRetentionSweep.ts`,
  `db/test/retention.itest.ts`, `api/.../admin/routes.ts`)

main's 13a `retention_policies` (`schema/platformOps.ts`, `repositories/retentionPolicyRepository.ts`,
`api/.../admin/compliance.ts`) is **unchanged**. The audit action `retention_policy.set` (engine) and
`retention.set` (13a) are both kept and both accounted for in `platformAuditCoverage.test.ts`.

## ⚠ Independent pre-FF review safeguards (read BEFORE running the steps below)

An independent adversarial review of this branch (read-only) confirmed the **code** merge is clean: the
`retention_policies`→`retention_class_policies` rename is complete with **no orphans**, the two retention
concepts are fully disentangled, both retention sweeps + both admins are preserved, the conflict files are
unioned (not clobbered), and there are no conflict markers. No build/runtime defect was found. The remaining
risk is entirely in executing the deferred migration step correctly:

- **MED-1 — preserve the 14 seed INSERTs; do NOT `drizzle-kit generate` from scratch.** The six preserved
  SQL files carry hand-written seeds drizzle-kit **cannot** reproduce: `0033_retention_engine.sql:31-42`
  (12 `retention_class_policies` default rows) + `0034_seed_rollout_flags.sql:1-2` (the `retention_engine_enabled`
  + `bulk_import_enabled` feature flags). A from-scratch `drizzle-kit generate` emits only schema-derivable
  DDL → it would **silently drop all 14 seeds**, leaving the retention engine with no classes (nothing to
  shadow-count or ever enforce) and the two features un-flippable. The **renumber is now done** (files at
  `0029…0034`, journal `idx` 29–34, every INSERT preserved); what remains is the **snapshot hand-stitch**
  (`0029.prevId==0028.id`…), NOT a DDL regenerate. **Correctness gate:** after stitching, `bun drizzle-kit
  generate` must report **no further diff** — a clean no-op proves the snapshots match the merged schema TS
  without having dropped anything.
- **MED-2 — the snapshot stitch must land BEFORE the DB itests, in the same CI job.** The migrations apply
  from the journal regardless of snapshots, but keep the ordering explicit: never run the itests against a
  half-reconciled tree. The later `rls/retention.sql` (step 3) does GRANT SELECT on `retention_class_policies`,
  which the `0033` migration creates — so a clean `migrate` of `0000…0034` is the prerequisite for the gate
  suite; never reorder.
- **LOW (non-blocking):** the engine admin routes (`/admin/retention-policies`, `/import-jobs`,
  `/retention-runs`) sit on `requireStaffRole` (super_admin-only write — strictest; reads match main's own
  multi-tier cross-tenant pattern + the frontend render-gate matches), NOT the 13a F3 `requireCapability`
  model. Safe + internally consistent; an optional later cleanup is dedicated `retention:read`/`retention:manage`
  capabilities. Also: step 1's "RLS grants" actually live in `rls/*.sql` (applied separately by
  `applyMigrations`), not inside the six migration SQL files — only the **seeds** need preserving there.

## What CI / a bun environment must do to finish

1. ✅ **DONE (this branch)** — renumbered feat's six SQL files **`0021…0026` → `0029…0034`** (content
   preserved, incl. the `retention_class_policies` rename + the 14 seed INSERTs) and appended `_journal.json`
   `idx` 29–34. The chain is now contiguous `0000…0034`; `migrate` is unblocked.
2. **Stitch the snapshots** `meta/00{29..34}_snapshot.json` cumulatively on top of main's `0028` snapshot
   (re-stitch the `id`/`prevId` chain so `0029.prevId == 0028.id`, etc.). The merged Drizzle schema TS already
   contains BOTH branches' tables, so the union is the target. **Verify with the MED-1 gate:** `bun drizzle-kit
   generate` reports **no further diff** (clean no-op).
3. Run the gates: `bun run typecheck`, `bun run lint` (Biome), `bun test`, and the DB itests
   (`retention.itest.ts`, `emailIsolation.itest.ts`, `templateIsolation.itest.ts`, the bulk-import +
   platform-reads itests). Pay special attention to the two `retention_*` RLS surfaces
   (`rls/retention.sql` GRANT SELECT on `retention_class_policies`; `rls/platformOps.sql` +
   `applyMigrations.ts` deny-all on `retention_policies`).
4. Only once green: fast-forward `feat/data-mgmt-01-research-brief` (and then `main`) from this branch.

Delete this file once the snapshots are stitched (step 2).
