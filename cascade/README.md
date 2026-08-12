# CASCADE — implementation

Working code for the typed relationship graph designed in [`../cascade-graph/`](../cascade-graph/).
The docs are the spec; this is the build.

> **Relationship to TruePoint.** This is a **self-contained project** — its own workspace, its own
> Postgres schema, no imports from `apps/*` or `packages/*` and no coupling to TruePoint's tenancy,
> RLS, or gates. TruePoint's shipped Layer-0 (`master_persons`, `master_employment`,
> `master_technology_*`) solves an overlapping problem with different conventions (uuid-v7 + RLS vs
> prefixed ULIDs + no tenancy). Fusing them is a decision to take deliberately, not a side effect of
> building this. See "Open decisions" below.

## Quick start

```bash
cd cascade
bun install
bun test          # 48 tests: 25 schema/acceptance + 23 API contract
bun run dev:web   # http://localhost:3200 — Explorer + API, seeded, no database needed
bun run dev       # API only, http://localhost:3100
```

No Postgres server is required for development: `@electric-sql/pglite` runs a real Postgres engine
in-process, so partial unique indexes, `ARRAY`, and `DISTINCT ON` behave exactly as they will in
production. Set `DATABASE_URL` to point the same code at a real cluster.

## Layout

| Package | What it is |
|---|---|
| `db/` | Schema, migrations, repositories, edge lifecycle, confidence fusion, the example seed |
| `api/` | Hono service implementing [`cascade-graph/api/openapi.yaml`](../cascade-graph/api/openapi.yaml) |
| `web/` | The Explorer — one screen that makes the develops-vs-uses split visible |

## What is built (Phase A of `cascade-graph/api/09` §11)

**Database** — all five relationship domains from the design, with the research-driven corrections:
partial unique indexes on open edges (re-adoption works), alias + identifier resolution substrate,
`detected_on_domain` on usage rows, closure-as-displacement (no `deprecated_use` type), and
`alumnus` derived from dates rather than stored.

**API** — 13 of the 23 planned routes: entity reads, both identify tiers, the typed traversals,
the vendor ledger, evidence, and the category taxonomy. Cross-cutting: RFC 9457 errors everywhere
(including 404s), boundary validation with named codes, opt-in field groups, `min_confidence`,
and `as_of` time travel.

**Web** — organization search by alias, side-by-side Builds/Runs panels, per-row confidence bands
that open the evidence trail, an as-of date control, and people/alumni panels.

### Not built yet (Phases B–D)

`POST /*/search` + autocomplete (needs the projection layer), watchers and the `/changes` feed,
batch endpoints, credits/permissions metering. The OpenAPI spec carries all of them; the routes
return 404 until implemented.

## The invariant this exists to protect

"Sage developed Sage Intacct" and "Sage uses WordPress" are different facts, and no query, endpoint,
or screen may blur them:

- **Schema:** one `org_technology_relations` row per fact, typed by `relationship_type`.
- **Repository:** `relationship` is a required argument — there is no call that returns both.
- **API:** `GET /organizations/{id}/technologies` without `?relationship=` is a **400**, not a guess.
- **UI:** two panels with different colors and different labels, never one merged list.
- **Tests:** `bun test` fails if `develops` ever returns WordPress or `uses` ever returns Sage Intacct.

## Open decisions (for the owner, not for an agent)

1. **Merge with TruePoint Layer-0, or stay separate?** Compatible models, different conventions.
2. **Postgres portability:** the DDL substitutes `TEXT` + functional indexes for `citext` and a
   dotted path for `ltree` so PGlite and production run identical SQL. Switch to the native types
   if PGlite parity stops mattering.
3. **`candidatesByName` scoring is a placeholder** — deterministic tiers standing in for the Splink
   model in `cascade-graph/guides/06` §4. Fine for seeding and demos; replace before real ingestion.
