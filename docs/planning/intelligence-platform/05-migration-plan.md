# Phase 5 — Migration Plan & Implementation Log

Non-destructive by construction: every migration is additive, nothing is dropped in the same release as its
replacement, and the one existing-column change (0104) only *weakens* a constraint.

---

## Naming decision — supersedes the table names in `03-target-architecture.md` §2

**Found while implementing, by reading `applyMigrations.ts` rather than assuming.** The GRANTS phase already
carries a convention-based defence-in-depth loop:

```sql
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^master_' LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM leadwolf_app', t);
  END LOOP;
END $$;
```

Its own comment states the trap precisely: *"A FUTURE Layer-0 master table is auto-granted by the ALTER
DEFAULT PRIVILEGES above at CREATE time… Tables NOT matching `master_*` … still rely on the explicit list
above; each phase MUST add its system-owned tables there."*

Phase 3's names (`technology_categories`, `company_technology_adoptions`, `signal_types`) do **not** match
`^master_`. Each one would have been auto-GRANTed to `leadwolf_app` at CREATE time and left readable by the
customer app role until someone remembered the explicit list — which is exactly the "0108 must not slip"
risk `04-validation.md` flagged, in its most likely form.

**Decision: every new Layer-0 table takes the `master_` prefix**, so the convention makes it fail closed by
default, *and* it is added to the explicit REVOKE list anyway.

| `03` name | Implemented name |
|---|---|
| `technology_categories` | `master_technology_categories` |
| `technology_aliases` | `master_technology_aliases` |
| `technology_vendors` | `master_technology_vendors` |
| `technology_features` | `master_technology_features` |
| `company_technology_adoptions` | `master_technology_adoptions` |
| `signal_types` | `master_signal_types` |
| `master_technologies`, `master_signals`, `master_company_*`, `master_person_identifiers` | unchanged |

This is a strictly better outcome than the separate migration 0108 the design proposed: instead of one
migration that must not be forgotten, the safety is in the table name itself.

---

## Migration ledger

| # | File | Contents | State |
|---|---|---|---|
| 0100 | `0100_chief_ravenous.sql` | Group A/B catalog: `master_technologies`, `master_technology_categories`, `master_technology_aliases`, `master_technology_vendors`, `master_technology_features` | ✅ **generated, gates green** |
| 0101 | `0101_technology_adoptions.sql` *(hand-authored)* | `master_technology_adoptions`, PARTITION BY RANGE (`observed_at`), monthly | ✅ **written, gates green** |
| 0102 | `0102_partition_acl_inherit.sql` *(hand-authored)* | **security fix** — partition ACLs inherit the parent's instead of the schema default grant | ✅ **written, gates green** |
| 0103 | `0103_master_signals.sql` *(hand-authored)* | `master_signal_types` + `master_signals`, partitioned, plus the launch vocabulary | ✅ **written, gates green** |
| 0104 | `0104_talented_justice.sql` generated + hand-appended backfill | `master_company_locations`, `master_company_contact_points`, `master_company_funding`, `master_person_identifiers` | ✅ **written, gates green** |
| 0105 | `0105_chemical_hannibal_king.sql` generated + hand-edited | `master_employment` D9: drop NOT NULL, add `company_name_raw` + `company_name_normalized`, CHECK (NOT VALID + VALIDATE), partial unique (revision R-2) | ✅ **written, full-monorepo typecheck green** |
| 0106 | `0106_block_key_indexes.sql` *(hand-authored)* | `block_key` indexes on persons/companies/technologies, CONCURRENTLY, with an invalid-index guard | ✅ **written, gates green** |
| 0107 | `0107_slow_silhouette.sql` generated + hand-appended seed | `master_confidence_policy` (per-(field, source_type) half-lives + weights) | ✅ **written, gates green** |
| ~~0108~~ | — | ~~dual-write adoption edge; staged reader cutover (R-1)~~ **RETIRED.** Phase 6.5 verified that `master_companies.technographics` has **no writer** and that the four "readers" read `accounts.technologies` instead — a different column on the Layer-1 overlay. There is no live Layer-0 writer to keep in sync, so there is nothing to dual-write. See `06-data-management-layer.md` §6.5 for the corrected cutover. | ✅ n/a |
| ~~old 0108~~ | — | **eliminated** — folded into the naming convention + per-migration REVOKE, see above | ✅ n/a |

---

## Slice 1 — migration 0100 (done)

**Files changed**

| File | Change |
|---|---|
| `packages/db/src/schema/masterTechnology.ts` | **new** — five Layer-0 catalog tables |
| `packages/db/src/schema/index.ts` | export the new module (drizzle-kit reads this barrel) |
| `packages/db/src/rls/masterTechnology.sql` | **new** — `updated_at` trigger; documents the deliberate absence of RLS and why a REVOKE must not live here |
| `packages/db/src/applyMigrations.ts` | the five tables added to the explicit Layer-0 REVOKE list |
| `packages/db/src/migrations/0100_chief_ravenous.sql` | generated |

**Verification run**

- `bunx tsc --noEmit` in `packages/db` → **exit 0**
- `bunx biome check` on all changed files → **clean** (one formatting fix applied)
- Migration content reviewed by hand: 5 × `CREATE TABLE`, 6 × `ADD CONSTRAINT … FOREIGN KEY`, 12 ×
  `CREATE INDEX`. **No `ALTER` of an existing table, no `DROP`, no data movement.**

**Design points that survived into the code**

- `master_technology_vendors` is SCD2 with `started_on DEFAULT '-infinity'`, reusing `master_employment`'s
  unknown-start sentinel so two unknown-start ownership rows collide instead of duplicating. A partial unique
  enforces **at most one open `current_owner` per technology** at the database level, mirroring
  `uniq_employment_primary` — two concurrent writers cannot both win the ownership slot.
- `cpe23` and `wikidata_qid` are **partial**-unique, not unique: most catalog rows will never have either,
  and research R10 found CPE coverage skews to software with published CVEs.
- Category tree is an **adjacency list, not `ltree`** — `ltree` needs an extension this database does not
  bootstrap, and a recursive CTE over a few hundred category rows costs nothing. Deviation from
  `cascade 2.md` recorded deliberately.
- `implies`/`requires`/`excludes` are `uuid[]` columns, not link tables: they are read whole by the
  Technology Profile and never filtered individually, so a link table would triple catalog row count for a
  query that is never run.
- `master_technology_features` has **no** CHECK tying it to `kind='product'`. A constraint that deletes
  evidence when a catalog row is reclassified is worse than a few rows the read path filters out.

**Not yet done for this slice** (tracked, not forgotten): repository, ER resolution against
`master_technology_aliases`, catalog seeding, and the isolation itest asserting `leadwolf_app` sees nothing.
Those land with Phase 6/9.

---

## Slice 2 — migrations 0101 + 0102 (done)

### 0101 — the adoption edge

`master_technology_adoptions`, `PARTITION BY RANGE (observed_at)`, hand-authored per the 0089 precedent; the
Drizzle module `schema/masterTechnologyAdoption.ts` is deliberately **not** in `schema/index.ts`, which is
what guarantees `drizzle-kit generate` never emits DDL for it.

Two decisions recorded in the migration itself, because both are the kind a future reader would "fix":

- **Partitioned on `observed_at` (valid time), not `recorded_at`.** Every read is "what was true in window
  W", and a provider backfill landing three years of history in one day would pile the whole backfill into a
  single `recorded_at` partition while the months it describes stayed empty.
- **No unique on (company, technology, method).** The grain is one row per detection *episode*. A technology
  detected → removed → re-detected is three facts and must be three rows, because that sequence **is** the
  displacement signal. A unique would also silently absorb the partition key and degrade to "one per pair per
  month" — the trap 0085 documents for `provider_calls` and 0089 for `provenance_event`.

### 0102 — partition ACLs do not inherit (a pre-existing security gap)

**Found while wiring 0101's REVOKE, by checking the claim instead of asserting it.**

Postgres checks privileges on the relation **named in the query**. So
`REVOKE ALL ON provenance_event FROM leadwolf_app` correctly blocks `SELECT ... FROM provenance_event` — and
says nothing about `SELECT ... FROM provenance_event_2026_08`. Each monthly partition is an ordinary table in
`public`, created by `ensure_month_partitions`, and `applyMigrations.ts` carries both
`ALTER DEFAULT PRIVILEGES … GRANT … ON TABLES TO leadwolf_app` and a blanket
`GRANT … ON ALL TABLES IN SCHEMA public` that re-runs every migrate. Partition names are fully predictable —
this function builds them as `parent_YYYY_MM`.

**This is pre-existing and already affects `provenance_event`**, whose partition names do not even match the
`^master_` convention loop, so nothing swept them up. 0101 did not introduce it; 0101 made it visible.

**Fix: mirror the parent's ACL onto each partition, rather than blanket-revoking.** Not every partitioned
table is Layer-0 — a tenant-scoped RLS table legitimately keeps its `leadwolf_app` grant, and a blanket
revoke inside a shared maintenance function would break it silently, on a calendar boundary. Mirroring is
correct for both cases and needs no table list to maintain.

Three places, because the ACL is re-applied from three directions:
1. `mirror_partition_acl(child_ns, child_name, parent)` — new function; sets child ACL = parent ACL.
2. `ensure_month_partitions` calls it immediately after `CREATE TABLE … PARTITION OF`, so there is no window
   in which a fresh partition is readable by a role the parent denies.
3. A loop in the `applyMigrations.ts` GRANTS phase re-mirrors every existing partition — **and it must run
   last**, because it is undoing what the blanket `GRANT ON ALL TABLES` in that same block just did. Guarded
   on the function existing so a database migrated only as far as 0101 still converges.

Implementation note worth keeping: role names go through `pg_get_userbyid()`, not `grantee::regrole::text`.
`regrole` output is already quoted when the name needs it, so passing it to `format('%I')` would double-quote
and emit an invalid statement.

**Verification:** `tsc --noEmit` exit 0 · `biome check` clean · `_journal.json` parses, 102 entries, both
migrations registered with descriptive tags per the 0089 convention.

**Still needed (Phase 9):** an itest asserting `leadwolf_app` can read neither
`master_technology_adoptions` nor any of its partitions by name — and per the RLS-denial rule, asserting
**"affected zero rows"** for UPDATE/DELETE rather than expecting a throw.

---

## Slice 3 — migration 0103, the canonical signal store (done)

`master_signal_types` + `master_signals`, both hand-authored in one migration. `master_signals` is
`PARTITION BY RANGE (observed_at)`; `master_signal_types` is authored alongside it rather than generated
because the two are one unit joined by an FK, and splitting them across the generated/hand-authored boundary
would leave half a coupled pair inside the drizzle snapshot and half outside it.

**`intent_signals` is not touched, not migrated, and not deprecated.** The two tables answer different
questions and neither replaces the other:

| | `intent_signals` (shipped) | `master_signals` (new) |
|---|---|---|
| Scope | tenant + workspace + contact | Layer 0, no tenant key |
| Meaning | a tenant's private scoring input | a canonical fact, corroborable across tenants |
| Example | "this contact opened my email" | "Acme raised a Series B" |

**The D6 fix: the vocabulary is rows, not a CHECK enum.** Adding `seed_round` or `office_opening` is an
INSERT, not a migration behind a deploy. It also gives each type somewhere to carry its own weight and
**decay half-life**, which research says must vary by type — a hiring surge is stale in a quarter, a funding
round never becomes untrue (`half_life_days` NULL = does not decay). Thirteen launch types seeded across the
five in-scope families; the half-lives are explicitly starting points for calibration, not researched
constants.

**The `intent` family is deliberately absent from the CHECK.** Five of the six industry-standard families are
company facts and are in scope; intent/content-engagement is deferred non-goal X-04 and carries by far the
heaviest privacy weight. Its absence from the constraint means adding it costs a migration and a decision,
rather than an INSERT someone makes on a Friday.

**Polymorphic subject, no FK** — `(subject_type, subject_id)` addresses a company *or* a person, so no single
FK can be written. Same trade-off `provenance_event.entity_id` makes and documents: referential integrity
moves to the repository, and in exchange one signal store serves both entity kinds instead of two
near-identical tables drifting apart.

**Compliance, per the 09-compliance review gate.** A `subject_type='person'` signal (`job_change`,
`exec_departed`) is **personal data** even though `payload` holds no contact value. Two hard requirements
recorded in the migration header and owed before person subjects are populated:
1. person-subject signals join the **DSAR erasure fan-out** (`forge-core/src/dsar.ts`,
   `workers/queues/dsar.ts`) — a signal left behind after an erasure is a compliance failure, and a brand-new
   table is exactly what quietly misses one;
2. `payload` carries **no contact values, ever** — same rule as `provenance_event.payload`, and it needs an
   itest rather than a comment.

**Verification:** `tsc --noEmit` exit 0 · `biome check` clean · journal parses, 103 entries.

---

## Slice 4 — migration 0104, Group D completeness (done)

Four non-partitioned tables, so drizzle-kit generated the DDL; one backfill hand-appended below the
generated block.

**Fixes audit D7** (company location existed only at Layer 1, so two tenants observing the same company's
offices could not corroborate each other) and **D8** (person identifiers were one column per source, making
every new provider a migration).

Decisions worth keeping:

- **`master_persons.linkedin_public_id` stays.** The new table generalizes *additional* identifiers; it does
  not replace the primary one, which is a hot indexed lookup used across the codebase. The appended backfill
  copies it in as `id_type='linkedin_public_id'` so the two agree from the moment the table exists —
  `INSERT … SELECT … ON CONFLICT DO NOTHING`, idempotent, reads one table and writes another. Noted at the
  call site that if `master_persons` ever grows large this belongs in a batched sweep: a single unbounded
  `INSERT … SELECT` in a deploy path is how a migration becomes an outage.
- **`id_type` is free-form varchar, not a CHECK enum** — same reasoning as D6. The set of sources is the part
  most expected to grow.
- **`master_company_contact_points` carries a `value_blind_index`** even though the value itself is stored in
  cleartext (business-contact data under 09-compliance rule 3). "Generic" is a claim, not a guarantee: an
  `info@` mailbox is frequently routed to one identifiable person. The suppression list keys on hashes, so
  without this column a suppressed individual could not be matched here at all and their address would keep
  re-entering the graph through the company door. The column exists now so Phase 6 can wire the HMAC without
  a destructive migration; the HMAC must use the same key and derivation as `master_emails.email_blind_index`
  or the two will never match. (04-validation.md Part 3, requirement 1.)
- **`master_company_funding` is the structured fact; the `master_signals` row is the dated event.** Both are
  kept on purpose — the profile reads the fact ("total raised, last round"), the feed reads the event ("who
  raised this month"), and neither has to reshape the other's data.
- At most **one `hq` per company**, DB-enforced by a partial unique, mirroring `uniq_employment_primary`. Two
  sources disagreeing about the HQ is a survivorship problem to resolve, not two rows to keep.

**Known limitation, recorded rather than glossed** (the V4 lesson applied preemptively):
`uniq_master_company_funding_round` is on `(company, round_type, announced_on)`, and both `round_type` and
`announced_on` are nullable. Postgres treats NULLs as distinct in a unique index, so two "unknown round"
rows for the same company will **not** collide. That is acceptable — an unknown round is genuinely
ambiguous — but it is best-effort dedup, not exact, and the ingest path must not assume otherwise.

**Verification:** `tsc --noEmit` exit 0 · `biome check` clean · journal 104 entries, hand-authored tags
0101–0103 survived `drizzle-kit generate` intact · architecture map regenerated.

---

## Slice 5 — migration 0105, the D9 change (done)

**The only change to an existing column in the entire program.** Everything else (0100–0104) is new tables.
It therefore gets its own migration, its own header rationale, and its own itest.

**What was wrong.** `master_employment.master_company_id` was `NOT NULL`, so an assertion like "Jane Doe, VP
Finance at Contoso Ltd" whose employer had not yet been ER-resolved could not be recorded **at all** — the
insert was rejected and the assertion was lost, along with the title, dates, and provenance that came with
it. This is `cascade 1.md` §2.3's one genuinely better structural idea, and it is adopted here.

**Approach: edit the schema, let drizzle-kit emit the ALTER.** Hand-authoring a diff that drizzle would
later fight is how a snapshot drifts from the database. The generated output was then hand-edited for the
lock behaviour below.

**Why it is non-destructive** — four independent reasons, all stated in the migration header:
1. `DROP NOT NULL` only *weakens* a constraint; every existing row already satisfies the weaker form and no
   row is rewritten.
2. Both `ADD COLUMN`s are nullable with no default — metadata-only in PG 11+, no table rewrite.
3. Both new indexes are **partial on `master_company_id IS NULL`**, which matches zero existing rows today,
   so the build is trivial regardless of table size.
4. The CHECK is added `NOT VALID` and validated in a separate statement.

**The one hand-edit that matters.** drizzle emitted a plain `ADD CONSTRAINT … CHECK`, which takes an
**ACCESS EXCLUSIVE lock and full-scans the table** to verify. Every existing row passes — the verdict is
never in doubt — but on a table sized for the graph the *scan* is the problem, not the result. Split into
`ADD … NOT VALID` (brief lock, enforced on all new rows immediately) + `VALIDATE CONSTRAINT` (scan under
SHARE UPDATE EXCLUSIVE, which blocks neither readers nor writers). Same end state, no write outage.
Migration 0084 makes the same point about validating constraints on very large tables.

**`company_name_normalized` is a stored column, not an expression index.** An expression index would need a
SQL normalization function, which means two implementations of "normalize a company name" — one in
TypeScript for `master_companies.name_normalized`, one in plpgsql. They will drift, and the day they do,
unresolved stints silently stop deduping against the key `master_companies` actually uses. One
implementation, written once, stored.

**Known limitation, stated in the index comment rather than glossed** (the V4 lesson, now applied at the
source): `uniq_employment_unresolved_stint` is best-effort. `started_on` defaults to the `'-infinity'`
unknown-start sentinel, so two genuinely different employers sharing a normalized name *and* an unknown
start will collide into one edge until ER resolves them. That is the better failure than unbounded duplicate
stints on every re-ingest, and it is reversible — `source_records` and `match_links` keep the evidence to
split them back apart.

**The DOWN is deliberately asymmetric**, and the migration says so: restoring the `NOT NULL` is a
*strengthening* and will fail outright once any unresolved row exists. Safe to apply, awkward to undo — the
correct shape for this change.

**Verification:** full monorepo `bun run typecheck` — **25/25 tasks green**, including `typecheck:tests`. Run
across all packages rather than just `packages/db`, because this is the one change that alters an existing
type (`masterCompanyId` is now `string | null`); nothing in the monorepo depended on its non-nullability.
`biome check` clean.

---

## Slice 6 — migration 0106, the ER blocking indexes (done)

The **one** schema change the probabilistic ER tier needs. `block_key` was reserved-but-unindexed at freeze
precisely so this could switch on without a destructive migration; 0106 is that switch.

Research R5 is why this is the only change required: comparison count grows with the *square* of record
count (Splink's own guidance: 1M records ≈ 500 billion pairs, and even after blocking the survivors are
typically 10×–1000× the input rows). The Fellegi–Sunter scoring arithmetic is trivial — **candidate
generation** is the expensive part, and that is a Postgres index problem, not a new service. No Splink
runtime, no Spark.

### Two things verified rather than assumed

**1. This repo does not use Drizzle's migrator.** `applyMigrations.ts::applyJournalByHash` splits each file
on `--> statement-breakpoint` and runs the statements one at a time through `sql.unsafe()` in **autocommit**
— its own docstring says *"statement by statement (autocommit, hash row recorded LAST) so an interrupted run
resumes convergently."* No enclosing transaction, so `CREATE INDEX CONCURRENTLY` is legal here.

This is worth stating because `migrate.ts:15-17` carries a comment that *"Drizzle's migrator opens a real DDL
transaction"* — that describes the connection-pooler hazard, not this code path, and reading it at face value
would have led to the wrong conclusion.

**2. The tolerance set would have hidden a failure.** A failed `CREATE INDEX CONCURRENTLY` leaves an
**INVALID** index behind; Postgres does not clean it up. The next deploy's retry raises `42P07`
duplicate_table — which **is in this migrator's `ALREADY_EXISTS` tolerance set**. It would be logged as
"tolerated: object already exists", the migration marked applied, and the invalid index left in place
forever: never used by the planner, still maintained on every write. The tolerance set is correct for
genuine already-exists cases; it simply cannot distinguish a valid index from a dead one.

Fix: a name-scoped `DO` block drops any invalid leftover first, then `CREATE INDEX CONCURRENTLY IF NOT
EXISTS`. Fully convergent — after a success the re-run is a silent no-op; after a failure the corpse is
cleared and the build retried.

**Why the indexes are hand-authored and NOT in the Drizzle schema.** Drizzle emits a plain, blocking
`CREATE INDEX` for anything declared in a schema file. `drizzle-kit generate` diffs schema against its own
snapshot (never the live database) and this repo never runs `push`, so an index created outside the schema
is invisible to it and will not be dropped — the arrangement `provenance_event`'s indexes already rely on.
Confirmed empirically: after the change, `drizzle-kit generate` reports **"No schema changes, nothing to
migrate"**.

Both `block_key` comments in `masterGraph.ts` and `masterTechnology.ts` were updated from
"[RESERVED, leave UNINDEXED]" to point at 0106, with an explicit *do not "fix" this by adding an index()
entry* — otherwise the next reader helpfully reintroduces the blocking build.

Indexes are **partial on `IS NOT NULL`**: `block_key` is unpopulated until the ER sweep computes it, and the
sweep reads exactly the non-null rows.

**Verification:** `tsc --noEmit` exit 0 · `biome check` clean · journal 106 entries · `drizzle-kit generate`
confirms no pending diff.

---

## Slice 7 — migration 0107, the confidence policy (done). **Phase 5 DDL complete.**

Parameterizes `confidence(field) = base(source_weight) × corroboration(source_count) × decay(age,
half_life)`. All three inputs already existed in the graph (source type, `source_count`, the
`observed_at`/`recorded_at` split); what was missing is the **curve** — 08-architecture states plainly that
"Decay curves are Phase 2 — not built", which is why today a five-year-old assertion and a fresh one score
identically. That undermines S-09, S-13 and S-10 simultaneously.

**Why a table and not constants.** Research R4 found reported decay clustering at ~2.1%/month (~22.5%/yr)
with published ranges from 22.5% to 70.3% — and **every one of those figures comes from a data vendor
selling the cure**. The direction and the dominant driver (job change) are consistent across independent
sources; the coefficient is not trustworthy. Hard-coding someone's marketing number as a physical constant
would bake an unverifiable claim into the scoring path. So: ship the shape with defaults, calibrate against
TruePoint's own bounce and reverification telemetry, which `verification_jobs` and the reverification sweeps
already collect. **Tuning is an UPDATE, not a deploy.** Every seeded value carries a `notes` string
explaining itself, because a number nobody can explain is a number nobody dares change.

**Keyed on (field, source_type)** because R1 (6sense, verbatim) states decay logic *varies by source type*
and that active sources outrank passive ones "reflecting the directness and verifiability of their signals".
A DNS fingerprint and a job-posting mention cannot share a half-life. 26 rows seeded across three groups:
per-source-type weights, per-field half-lives, and technology-specific rows where detection method dominates.

**`half_life_days` NULL = does not decay** — `primaryDomain` and `name` do not silently stop being true;
a rebrand is an event we observe, not decay.

**Resolution order the fold must implement**, most specific first:
`(field, source_type)` → `('*', source_type)` → `(field, '*')` → `('*', '*')`. The universal fallback is
seeded, so a lookup can never miss and the fold needs no hard-coded default.

**Rollout switch built in.** `is_enabled` exists so decay ships **display-only** (the S-10 badge) before it
influences ranking, and only then reveal gating — per 04-validation.md. A wrong half-life must never
silently downgrade good records before it has been watched against real telemetry.

**Verification:** `tsc --noEmit` exit 0 · `biome check` clean · architecture map regenerated (1986 files).

---

## Phase 5 status: DDL complete (0100–0107)

Eight migrations, all additive. One existing column weakened (0105), nothing dropped, no data destroyed.
Two pre-existing defects found and fixed along the way that were **not** in the original plan:
the partition-ACL inheritance gap (0102) and the invalid-index/tolerance interaction (0106).

What Phase 5 deliberately did **not** do, and Phase 6 owes:
repositories for every new table · the ER blocking sweep that populates `block_key` · the decay fold in
`packages/core/src/prospect/` · the adoption dual-write and staged reader cutover (R-1) · the HMAC wiring for
`master_company_contact_points.value_blind_index` · `master_signals` joining the DSAR fan-out.
Phase 9 owes the isolation itests for all of it.

---

## Standing rules for the remaining slices

1. **Partitioned tables are hand-authored and excluded from `schema/index.ts`** — Drizzle cannot express
   `PARTITION BY`, and `drizzle.config.ts` points at that barrel, so keeping the module out of it is what
   guarantees `generate` never emits DDL for it. Precedent: `provenanceEvent.ts`.
2. **Partition maintenance is free** — `partitionRepository.listPartitionedTables()` discovers
   `relkind='p'` from the catalog, so 0101 and 0102 need no sweep changes (verified, `04-validation.md` V1).
3. **Every new Layer-0 table**: `master_` prefix, explicit REVOKE entry, an `rls/*.sql` file stating why
   there is no policy, and an isolation itest asserting **"affected zero rows"** rather than "threw" —
   INSERT raises under `WITH CHECK`, but UPDATE/DELETE with no policy silently affect nothing.
4. **Blocked:** personal email/phone typing, pending conflict C8.
5. **Sequenced ahead of any new contribution path:** the CD-1 fix (`/api/v1/ingest` currently acks and
   discards; the extension deletes its queue item on that ack).
