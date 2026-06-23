# Database and Migrations

TruePoint's data lives in a relational (Postgres) database accessed through the
backend (`apps/api`). This file covers how schema changes are made safely.

The repo's established setup, which you follow exactly:

- **Schema migrations** are Drizzle Kit migrations in `packages/db/src/migrations`
  (sequence-prefixed SQL, e.g. `0003_chunky_vapor.sql`, with `meta/` snapshots).
- **RLS policies** are applied as SQL files in `packages/db/src/rls/` (one per table
  area, e.g. `contacts.sql`, `billing.sql`) **after** the migrations run — RLS is not
  authored inside the Drizzle migration files.
- **Two-tier tenancy**: every tenant-scoped table carries `tenant_id` (and
  `workspace_id` where the row is workspace-scoped); RLS is `ENABLE` + `FORCE` and
  fail-closed via `NULLIF` on the GUCs `app.current_tenant_id` /
  `app.current_workspace_id`, enforced for the non-BYPASSRLS role `leadwolf_app`.

The principle-level rules below are the intended discipline regardless of which file
the change lands in.

---

## Every Migration Is Reversible

Every schema change ships with a defined, tested way to revert it — an `up` (apply)
and a `down` (revert) that actually reverses the `up`. The revert is not optional and
is not a stub. This is what makes rollback possible (see the pre-build rollback
question).

A migration you cannot reverse is a migration you cannot safely deploy. If a
change is genuinely irreversible (e.g. dropping a column with data), the revert
must at least recreate the structure, and the destructive step must be staged
separately (see below).

> **Implementation status — mechanism:** Drizzle Kit generates forward-only SQL in
> `packages/db/src/migrations` and does not author a paired `down` file. The
> reversibility mandate still holds: author and test a companion revert (a reverse SQL
> migration) for every change, and treat any change without a tested revert path as
> not deploy-ready. The corresponding RLS revert lives alongside the policy in
> `packages/db/src/rls/`.

---

## Migrations Are Forward-Only Once Deployed

Once a migration has run in production, never edit it. Editing an
already-applied migration means environments diverge — some ran the old
version, some the new. To change something, write a new migration.

A migration is immutable the moment it leaves your machine.

---

## Additive-First for Zero-Downtime

The app and the database are deployed separately, and for a window both the old
and new app versions run against the same schema. Schema changes must not break
the version that is still running.

This means changes are **additive first**:

- Adding a column: make it nullable or give it a default, so the old app (which
  doesn't write it) still works.
- Renaming a column: never rename in place. Add the new column, backfill, update
  the app to write both then read the new one, and only later drop the old one —
  each step its own migration.
- Removing a column: stop reading it in the app and deploy that first. Only
  after the app no longer references it does a later migration drop it. (This is
  the database mirror of the staged-removal rule in `removal-cleanup.md`.)

A migration that drops or renames a column in the same release that changes the
app is a guaranteed production error for users mid-session.

---

## Indexing Discipline

Pre-build asks what slows down as the table grows. Migrations are where you
answer it:

- Any column used in a `WHERE`, `JOIN`, or `ORDER BY` on a table that grows
  needs an index. Foreign keys especially.
- Add the index in the same migration that adds the column it supports, so the
  query is never deployed against an unindexed column.
- On large tables, create indexes concurrently where the database supports it,
  so the migration does not lock the table.

---

## Naming and Location

- Schema migrations live in `packages/db/src/migrations` (Drizzle Kit), sequence-
  prefixed so order is unambiguous; RLS policy changes live in `packages/db/src/rls/`.
- The name states the change: `add_export_count_to_lists`, not `update_lists`.
- One logical schema change per migration — same single-responsibility principle
  as code files. Do not bundle an unrelated table change into another migration.

---

## Data Migrations vs Schema Migrations

- A **schema migration** changes structure (tables, columns, indexes).
- A **data migration** changes rows (backfilling a new column, fixing bad data).

Keep them separate. A data backfill that touches many rows should be batched so
it does not lock the table or exhaust connections, and it must be idempotent —
safe to re-run if it fails partway.

---

## What NOT to Do

- Do not write a migration without a tested revert path (`down`).
- Do not edit a migration that has already run anywhere but your own machine.
- Do not drop or rename a column in the same release as the app change that
  stops using it — stage it.
- Do not add a queryable column without its index.
- Do not run an unbatched `UPDATE` across a large table in a migration.
- Do not put business logic in migrations — they change data shape, not
  application behaviour.
