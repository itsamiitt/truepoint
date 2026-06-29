# ⚠ Main-merge integration TODO — Drizzle migrations are NOT yet valid on this branch

This branch is the result of merging `origin/main` into `feat/data-mgmt-01-research-brief`
(integration branch `integrate/main-into-data-mgmt`). The **code** conflicts are fully resolved,
but the Drizzle migration chain still needs a renumber + snapshot regeneration that requires
`bun drizzle-kit` (not available in the sandbox the merge was performed in). **Do not deploy or
`drizzle-kit migrate` from this branch until the steps below are done and the gates pass.**

## What happened

`main` and `feat` both forked at `0020_late_auth_enforcement` and then independently used migration
numbers **0021–0026** for *different* migrations:

| #    | main (now on trunk)        | feat (this branch's engine work)        |
|------|----------------------------|-----------------------------------------|
| 0021 | `opposite_randall`         | `phone_line_type`                       |
| 0022 | `organic_earthquake`       | `verification_jobs`                     |
| 0023 | `steep_ultragirl`          | `data_quality_snapshots`                |
| 0024 | `silent_quasimodo`         | `bulk_import_jobs`                       |
| 0025 | `nappy_albert_cleary`      | `retention_engine`                      |
| 0026 | `email_p1_inbound`         | `seed_rollout_flags`                    |
| 0027 | `fixed_purple_man`         | —                                       |
| 0028 | `outstanding_venom`        | —                                       |

The merge **kept main's valid chain** in `meta/_journal.json` + `meta/00{21..28}_snapshot.json`
(the entries for `0000`–`0028`). feat's six migration **SQL files are still present** at their old
numbers (`0021_phone_line_type.sql` … `0026_seed_rollout_flags.sql`) — they are **inert** (no journal
entries reference them, so neither `drizzle-kit migrate` nor `generate` will touch them) but they
**preserve the hand-written DDL/RLS/seed SQL** that `drizzle-kit generate` cannot reproduce.

## Architectural collision already resolved in code: `retention_policies`

Both branches shipped a table literally named `retention_policies` with incompatible columns. Per the
merge decision, **feat's retention-ENGINE side was renamed** so both features coexist:

- table `retention_policies` → **`retention_class_policies`** (`schema/retention.ts`, `rls/retention.sql`,
  `0025_retention_engine.sql`)
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
  SQL files carry hand-written seeds drizzle-kit **cannot** reproduce: `0025_retention_engine.sql:31-42`
  (12 `retention_class_policies` default rows) + `0026_seed_rollout_flags.sql:1-2` (the `retention_engine_enabled`
  + `bulk_import_enabled` feature flags). A from-scratch `drizzle-kit generate` emits only schema-derivable
  DDL → it would **silently drop all 14 seeds**, leaving the retention engine with no classes (nothing to
  shadow-count or ever enforce) and the two features un-flippable. So step 1–2 below = **renumber + hand-stitch**
  (rename the six files to `0029…0034`, keep every INSERT, append journal entries with `0029.prevId==0028.id`…),
  NOT a DDL regenerate. **Correctness gate:** after stitching, `bun drizzle-kit generate` must report **no
  further diff** — a clean no-op proves the snapshots match the merged schema TS without having dropped anything.
- **MED-2 — renumber BEFORE the DB itests, in the same CI job.** The engine migrations are inert on this
  branch, so `migrate`/`applyMigrations` does not create `retention_class_policies`/`retention_runs`, and the
  later `rls/retention.sql` (step 3) would fail "relation does not exist". The renumber (step 1–2) is a HARD
  prerequisite for the gate suite (step 3) — never run the itests before it, never reorder.
- **LOW (non-blocking):** the engine admin routes (`/admin/retention-policies`, `/import-jobs`,
  `/retention-runs`) sit on `requireStaffRole` (super_admin-only write — strictest; reads match main's own
  multi-tier cross-tenant pattern + the frontend render-gate matches), NOT the 13a F3 `requireCapability`
  model. Safe + internally consistent; an optional later cleanup is dedicated `retention:read`/`retention:manage`
  capabilities. Also: step 1's "RLS grants" actually live in `rls/*.sql` (applied separately by
  `applyMigrations`), not inside the six migration SQL files — only the **seeds** need preserving there.

## What CI / a bun environment must do to finish

1. Renumber feat's six SQL files **`0021…0026` → `0029…0034`** (preserving their content, including the
   `retention_class_policies` rename, RLS grants, and the `seed_rollout_flags` INSERTs).
2. Regenerate their snapshots **cumulatively on top of main's `0028` snapshot** and append matching
   `meta/_journal.json` entries — i.e. re-stitch the `id`/`prevId` chain so `0029.prevId == 0028.id`, etc.
   The merged Drizzle schema TS already contains BOTH branches' tables, so the regen reflects the union.
3. Run the gates: `bun run typecheck`, `bun run lint` (Biome), `bun test`, and the DB itests
   (`retention.itest.ts`, `emailIsolation.itest.ts`, `templateIsolation.itest.ts`, the bulk-import +
   platform-reads itests). Pay special attention to the two `retention_*` RLS surfaces
   (`rls/retention.sql` GRANT SELECT on `retention_class_policies`; `rls/platformOps.sql` +
   `applyMigrations.ts` deny-all on `retention_policies`).
4. Only once green: fast-forward `feat/data-mgmt-01-research-brief` (and then `main`) from this branch.

Delete this file as part of step 1–2.
