# ADR-0001 — Use Drizzle (not Prisma) as the ORM

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [01-tech-stack.md](../01-tech-stack.md), [03-database-design.md](../03-database-design.md)

> **Note (2026-05-29):** The decision (Drizzle) stands. Some original rationale below cites subsystems
> that were later removed in the per-workspace repositioning (identity resolution, the append-only
> `credit_ledger`, `raw_records`, the scraper worker — see [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md),
> [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md), [ADR-0010](./ADR-0010-aws-native-self-hosted-stack.md)).
> Read those examples as historical; Drizzle's SQL-first control (RLS, partial indexes, partitioning,
> `FOR UPDATE`) is still exactly what the current schema needs.

## Context

LeadWolf's two highest-risk subsystems — **identity resolution** and the **credit ledger** — lean
heavily on advanced PostgreSQL features:

- `pg_trgm` GIN indexes and `citext` for fuzzy matching and case-insensitive emails/domains.
- `GENERATED ALWAYS` columns and **partial/expression indexes** (e.g. one current provenance row per
  field via `WHERE is_current`).
- `SELECT … FOR UPDATE` row locking for the idempotent reveal transaction.
- Time-based **range partitioning** for `raw_records`, `audit_log`, `provider_calls`, `credit_ledger`.

We need precise control over SQL and migrations, and a light runtime footprint in workers.

## Decision

Use **Drizzle ORM** + `drizzle-kit` for migrations, on PostgreSQL 16.

## Rationale

- Drizzle is SQL-first: it exposes raw SQL, custom column types, partial/expression indexes, generated
  columns, and explicit locking without fighting the abstraction.
- No separate query-engine binary (unlike Prisma) → lighter, faster cold-starts in `worker`/`scraper`.
- Type inference is strong and integrates cleanly with our Zod-as-source-of-truth approach.
- Migrations are plain SQL we can review and tune (concurrent index creation, expand/contract).

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Prisma** | Rejected (primary) | Best-in-class DX/migrations, but fights partial indexes, generated columns, `FOR UPDATE`, and partitioning we depend on; query-engine binary adds weight. |
| **Kysely** | Close second | Excellent type-safe query builder, but we'd add a separate migration tool; Drizzle bundles schema + migrations + builder. |
| **TypeORM / Sequelize** | Rejected | Heavier, weaker TS ergonomics, less SQL transparency. |
| **Raw `pg` + SQL files** | Rejected | Maximum control but loses type-safety and developer velocity. |

## Consequences

- **Positive:** full Postgres power for matching/ledger/partitioning; small runtime; reviewable SQL.
- **Negative:** more manual migration authoring than Prisma; smaller (though healthy) ecosystem; team
  ramp-up if unfamiliar.
- **Mitigation:** wrap common access in typed repositories in `packages/db`; keep migrations in CI with
  a gated apply step; document partitioning/index patterns.

## Revisit if
Drizzle blocks a needed capability, or migration ergonomics become a sustained drag — re-evaluate
Kysely + a dedicated migration tool.
