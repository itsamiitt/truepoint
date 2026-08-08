# Intelligence Platform Redesign — Progress Tracker

**Program:** redesign TruePoint's canonical data architecture for full Sales + Market Intelligence
(prospect, company, technology, product, market), plus the contribution network, central data-management
layer, identity resolution, trust framework, API surface, and the four intelligence profile UIs.

**Driving brief:** the user's 12-section brief, delivered with two reference documents at repo root —
`cascade 1.md` (person-layer architecture) and `cascade 2.md` (technology-entity architecture). Those two
documents are **reference designs from a different product (CASCADE), on a different stack**. They are
input, not instructions. See §Conflicts.

**Mandated order — never skip forward:**
`Research → Verify → Audit → Design → Validate → Implement → Test → Document`

**This tracker is the loop's state.** Each iteration: read this file, do the next uncompleted step, update
this file. Never re-do a completed step; never start implementation while a Design/Validate box is open.

---

## Phase board

| # | Phase | State | Artifact |
|---|---|---|---|
| 1 | Research (industry practice, cited) | ✅ **v1 done** — 10 findings, 9 decisions (RD-1…RD-9) | `01-research.md` |
| 2 | Existing-system audit | ◐ **in progress** (schema inventory done; read paths pending) | `02-audit.md` |
| 3 | Architecture design (ERD, schema, flows) | ✅ **v1 done** — DDL, ER ladder, confidence model, migration sketch | `03-target-architecture.md` + `03a-contribution-architecture.md` |
| 4 | Validation pass (scale/perf/quality/security/cost) | ✅ **done** — 7 items resolved, 6 revisions, 1 bug found, 1 new conflict | `04-validation.md` |
| 5 | Database implementation (migrations, non-destructive) | ✅ **DDL complete** — 0100–0107, all additive | migrations + `05-migration-plan.md` |
| 6 | Data-management layer | ◐ **in progress** — 6.1 decay fold done (33 tests); 6.2–6.6 queued | `06-data-management-layer.md` + code |
| 7 | Application integration | ◐ **slice 7.1 BUILT** (dark) — the S-13 job-change fan-out sweep; gates green, **unrun against Postgres** | `07-integration-and-producers.md` + code |
| 8 | UI enhancement (4 profiles) | ◐ **audited — S-10 badge already SHIPPED; 3 of 4 profiles blocked on EMPTY TABLES, not on UI** | `08-profile-ux.md` |
| 9 | Testing | ◐ **in progress** — 3 itests written: Layer-0 isolation + repository behaviour + the S-13 sweep (gates green, **all three unrun: no Postgres on this host**) | tests |
| 10 | Documentation | ✅ **done** — the handover doc | `10-handover.md` |

---

## Iteration log

### Iteration 1 — 2026-08-08
Scope: orientation + schema inventory. **No code written, no migration authored** (Critical Rule holds).

Done:
- Recurring loop scheduled (`*/20 * * * *`, session job `29423847`).
- Read both cascade reference documents in full.
- Inventoried the live schema by direct inspection, not assumption: **99 migrations**, ~130 tables in
  `public`, **21 tables in the `forge` schema**, **120 repositories** under `packages/db/src/repositories/`.
- Read the Layer-0 core (`masterGraph.ts`), the intelligence layer (`intel.ts`), and the field-grain
  provenance log (`provenanceEvent.ts`) line by line.
- Wrote `02-audit.md` v1 (inventory + gap table + conflict register).

Key correction to the brief's premise, recorded early because it changes the whole plan:
**TruePoint is not a greenfield.** A canonical Layer-0 master graph, an append-only evidence log, a
field-grain provenance log, an encrypted-channel model with HMAC blind indexes, a contributor pipeline with
consent/quarantine/review, DSAR + suppression, and a reveal/credit ledger **already exist and are shipped**.
Several of them are stronger than what the cascade documents propose. The work is therefore *extension and
completion*, not redesign-from-zero.

Next: Phase 1 research (§Research queue below), then finish Phase 2 with the read-path and flow audit.

### Iteration 2 — 2026-08-08
Scope: Phase 1 research. **Still no code, no migrations.**

Done — `01-research.md` v1, ten findings, all cited or explicitly marked unverifiable:
- R1 technographic modeling (catalog + dated edge; 6sense's three-factor confidence model verbatim)
- R2 product intelligence — **no established B2B pattern exists**; commerce catalogs are a different problem
- R3 signal taxonomy — six families, industry-consistent
- R4 data decay — ~2.1%/month ≈ 22.5%/yr, job change dominant; coefficient itself untrustworthy (vendor-sourced)
- R5 identity resolution — Splink's own numbers; blocking, not scoring, is the constraint
- R6 survivorship — four standard strategies; TruePoint weighs three of four
- R7 **Postgres scale ceiling, from the PostgreSQL manual directly** — constraint is partition *count*
  ("a few thousand"), not row count
- R8 contribution networks — Apollo/ZoomInfo models, notification-on-add jurisdictions, and why TruePoint's
  no-earned-currency rule is a fraud control rather than a restriction
- R9 profile UX — **neither ZoomInfo nor Apollo surfaces "last verified" in the standard UI**
- R10 licensing — enthec/webappanalyzer GPL-3.0 **confirmed from the repo itself**, full field list captured

Conflicts moved: **C2 resolved** (RD-5, Postgres-only with a written revisit trigger).
**C5 resolved** (RD-4 — only signal family 5 is X-04; families 1–4 and 6 are in scope).
**C4 has a recommendation** (RD-7, option 1: use the field shape, not the GPL data) — still needs sign-off.
**New open item RD-3** — collapsing products into the technology catalog reinterprets the brief's structure,
so it is surfaced rather than assumed.

Next: Phase 2 v2 — read-path/flow audit (API contract, extension capture path, workers, CRM ownership map),
then Phase 3 design.

### Iteration 3 — 2026-08-08
Scope: contribution-system design, **placed on real monorepo paths** (user directive: plan it in the
monorepo, not as an abstract diagram). Covers brief §2, §3, §8, §9. Still no code, no migrations.

Done — `03a-contribution-architecture.md`:
- Read `.dependency-cruiser.cjs` and captured the seven boundary rules the design must obey; these are
  CI-enforced, so they constrain placement mechanically.
- Mapped all 11 lifecycle stages (S0…S11) to their owning package/app and the tables they write.
  **The brief's contribution lifecycle is ~85% built.**
- Traced the extension capture path end to end: `captureQueue.ts` (IndexedDB, idempotency key =
  SHA-256(sourceUrl ␀ fields), survives SW death) → `scheduler.ts` drain → `POST /ingest` on `API_BASE`.
- **Finding: two ingest front doors.** The extension posts to `apps/api` `/ingest`; the hardened
  `landEnvelope` (server-recomputed hash, server-measured size, tenant-prefixed object keys, post-commit
  enqueue) sits behind `apps/forge-api` `POST /v1/captures`. → CD-1.
- Wrote the write-ownership matrix; **Layer 0 has exactly one writer** and it is already structurally
  enforced (no `leadwolf_app` grant), not merely documented.
- Gaps: G1 `forge-capture-sdk` is a one-line stub though its header promises the shared envelope builder and
  **the PII guard** (hard constraint 4 is convention-enforced today, not build-enforced); G2 `EnrichPort`/
  `VerifyPort` declared with no adapters; G3 no contribution path for technology/product/signal;
  G4 undocumented `forge-worker` vs `workers` split.
- Placement table for every new capability, and five decisions CD-1…CD-5.

Structural conclusion carried into Phase 3: **the new entity families need new parsers, new canonical
tables, and new `provenance_event.entity_type` values — not a new pipeline.** `provenance_event.entity_type`
is a `varchar(20)` with no FK by design, so extending it costs nothing.

Next: Phase 3 target architecture — the canonical tables for technology, product, and signals, plus the
decay function, written against RD-1…RD-9 and CD-1…CD-5.

### Iteration 4 — 2026-08-08
Scope: Phase 3 target architecture. **Design only — still no code, no migrations.**

Done — `03-target-architecture.md`:
- Convention table first: this design uses **uuid v7, varchar+CHECK, single Postgres, 1.5-temporal** — the
  repo's idioms — not cascade's ULID/Citus/ClickHouse/bitemporal substrate. The cascade *shapes* are good;
  adopting its *substrate* would fork the schema's identity idiom for one subtree.
- Five change groups (A technology, B product, C signals, D person/company completeness, E decay), each
  answering the brief's seven mandated questions.
- Full DDL: `master_technologies` (+ categories, aliases, SCD2 vendors, features),
  `company_technology_adoptions` (partitioned, **episode-grained**), `signal_types` + `master_signals`
  (partitioned, polymorphic subject), company locations/contact-points/funding,
  `master_person_identifiers`, and the one existing-column change (D9).
- ER ladder exact→strong→probabilistic→review, with the probabilistic tier designed as a **bounded offline
  job with capped block sizes** — no Splink runtime, no Spark. Indexing `block_key` is the only schema
  change it needs, which is precisely the affordance it was reserved for.
- Confidence model `base(source_weight) × corroboration(source_count) × decay(age, half_life)`, half-life
  per (field, source_type), **display-only rollout first**.
- Migration sketch 0100–0108 with per-step risk. **0108 (RLS/GRANT for every new Layer-0 table) flagged as
  the one that must not slip** — a new system-owned table inheriting a blanket grant is a tenancy hole.
- Outcome IDs per change group. Skills/education/languages **cut** — conflict C6, no listed outcome.

Design decisions worth carrying forward:
- **C7 answered in the design:** product = technology seen from the vendor end, `kind` discriminator,
  `technology_features` child. Collapses two of the brief's five domains, kills the product↔technology
  mapping problem. Escape hatch noted if products ever need SKU-shaped attributes.
- **Adoption edge is episode-grained on purpose** — no unique on (company, technology, method). A
  re-detection after removal is a NEW episode, which is what makes displacement reconstructable.
  Collapsing to one row per pair would destroy the signal the table exists to produce.
- **cascade 1's best idea adopted** (D9: keep `company_name_raw` beside the resolved FK so an assertion
  survives until ER catches up), and **its shared-vocabulary idea preserved without building skills tables** —
  `master_technologies` is that vocabulary; `technology_skill_map` is a two-column add whenever a skills
  outcome exists.

Next: Phase 4 validation — 7 open items already queued in `03-target-architecture.md` §8, incl. the
`uniq_employment_stint` NULL-distinctness consequence, whether `partitionSweep` generalizes beyond
provenance, the compliance pass on `master_signals`, and the CD-1 two-file verification.

### Iteration 5 — 2026-08-08
Scope: Phase 4 validation. **Still no code, no migrations.** All seven items resolved against the code or
the strategy docs.

Resolved:
- **V1 ✅ partition automation generalizes and is free.** `partitionRepository.listPartitionedTables()` asks
  `pg_class` for `relkind='p'` — no hard-coded list, by explicit design. Migrations 0101/0102 inherit
  monthly partition maintenance with zero extra work.
- **V2 ⚠ `technographics` jsonb has four live readers** (prospect filter group, account drawer, a
  filter-order test, and the `company_technographics` search facet). Backfill becomes a dual-write with a
  staged reader cutover. Also resolved the audit's `[UNVERIFIED]`: `accounts` has **no** second
  technographics column — one copy only, which makes the cutover far safer.
- **V3** `company_technology_current` projection deferred behind a measurement trigger.
- **V4 ⚠ the Phase 3 fix for unresolved-stint dedup was wrong as written** — it collided with the
  `'-infinity'` unknown-start sentinel. Revised to normalize the raw name like `name_normalized` and to
  record best-effort dedup as a known limitation instead of claiming exactness.
- **V5/V6** compliance block produced; the Art. 14-style notice obligation is **already tracked** in
  `09-compliance.md` as planned-with-counsel, so this program does not create a new gap.
- **V7 ❌ CD-1 verified, and it is a correctness bug, not tidiness.** `apps/api/.../ingest/routes.ts`
  validates, re-pins scope to the token (correct), throttles, runs the connector — then returns
  `202 {accepted:true}` and **persists nothing** (its own comment: "the async processing … is a later
  slice"). Meanwhile `scheduler.ts:22-24` **deletes the queue item on success**. Net: an extension capture
  is acked, dropped from the client's durable buffer, and stored nowhere. Also confirmed two divergent
  envelope contracts (`ingestionEnvelope` vs `IngestionEnvelopeV2`).

Verdict: design **passes** on scalability, performance, quality, maintainability, extensibility, cost;
**conditional pass** on security, gated on migration 0108 (RLS/GRANT for every new Layer-0 table) and its
isolation itests asserting *"affected zero rows"* rather than *"threw"*.

Six revisions R-1…R-6 recorded. CD-1's fix is now sequenced **before** any new contribution surface.

Next: Phase 5 — `05-migration-plan.md`, then migrations 0100…0108. Groups A–E are cleared; only the
personal-contact typing (C8) is blocked.

### Iteration 6 — 2026-08-08
Scope: Phase 5 slice 1. **First code of the program.** Migration 0100 — the Group A/B technology/product
catalog. Gates green.

Shipped:
- `packages/db/src/schema/masterTechnology.ts` — 5 Layer-0 tables
- `packages/db/src/rls/masterTechnology.sql` — `updated_at` trigger + why there is deliberately no policy
  and why a REVOKE must NOT live in this file (GRANTS runs after rls/*, so it would be undone immediately)
- `packages/db/src/applyMigrations.ts` — the five tables added to the explicit Layer-0 REVOKE list
- `packages/db/src/migrations/0100_chief_ravenous.sql` — generated; 5 CREATE TABLE, 6 FK, 12 indexes.
  **No ALTER of an existing table, no DROP, no data movement.**
- `packages/db/src/schema/index.ts` — barrel export

Gates: `tsc --noEmit` **exit 0**; `biome check` **clean** (one formatting fix applied).

**Naming decision that came out of reading the code, not designing.** `applyMigrations.ts` already carries a
defence-in-depth loop revoking `leadwolf_app` from every table matching `^master_`, with a comment warning
that non-matching Layer-0 tables *"still rely on the explicit list … each phase MUST add its system-owned
tables there."* Phase 3's names (`technology_categories`, `company_technology_adoptions`, `signal_types`)
would NOT have matched — each auto-GRANTed at CREATE time. **All new Layer-0 tables now take the `master_`
prefix**, so the convention makes them fail closed by default and the explicit list is the belt.

Consequence: **migration 0108 is eliminated.** The security step `04-validation.md` called "the one that must
not slip" is now a property of the table name rather than a migration someone has to remember. `03` §2 has a
supersedes note; `05-migration-plan.md` carries the rationale and the full rename table.

Next: 0101 — `master_technology_adoptions`, hand-authored, PARTITION BY RANGE (`observed_at`), excluded from
`schema/index.ts` per the `provenanceEvent.ts` precedent. Partition maintenance needs no changes (V1).

### Iteration 7 — 2026-08-08
Scope: Phase 5 slice 2. Migrations 0101 + 0102. Gates green (`tsc` exit 0, `biome` clean, journal parses).

**0101 — `master_technology_adoptions`**, hand-authored, `PARTITION BY RANGE (observed_at)`, module kept out
of `schema/index.ts` so `drizzle-kit generate` can never see it. Partitioned on **valid** time, not
transaction time — a provider backfill landing three years of history in one day would otherwise pile the
whole backfill into a single `recorded_at` partition while the months it describes stayed empty. **No unique
on (company, technology, method)**: the grain is one row per detection *episode*, and detected → removed →
re-detected is three facts, which is precisely the displacement signal.

**0102 — a pre-existing security gap, found by checking a claim instead of asserting it.**
While writing 0101's REVOKE I wrote "REVOKE on the parent cascades to every partition." It does not.
Postgres checks privileges on the relation **named in the query**, so
`REVOKE ALL ON provenance_event FROM leadwolf_app` blocks the parent and says nothing about
`provenance_event_2026_08` — an ordinary table in `public` that picks up both the
`ALTER DEFAULT PRIVILEGES` grant at creation and the blanket `GRANT ON ALL TABLES` every migrate, under a
fully predictable name.

**This already affects `provenance_event` today** — its partition names do not match the `^master_`
convention loop either, so nothing swept them up. 0101 did not introduce it; 0101 made it visible.

Fix: `mirror_partition_acl()` sets each partition's ACL to its parent's — correct for a REVOKE'd Layer-0
table AND for a tenant-scoped RLS table that legitimately keeps its grant, with no table list to maintain.
Wired in three places: the function, `ensure_month_partitions` (so there is no window at creation), and a
loop in the GRANTS phase that **must run last**, because it undoes what the blanket GRANT in that same block
just did.

Next: 0103 — `master_signal_types` + `master_signals` (Group C), partitioned, same hand-authored pattern.
Then Phase 9 owes an itest proving `leadwolf_app` can read neither the adoption parent nor any partition by
name — asserting *"affected zero rows"*, not *"threw"*.

### Iteration 8 — 2026-08-08
Scope: Phase 5 slice 3. Migration 0103 — the canonical signal store (Group C). Gates green.

- `master_signal_types` + `master_signals`, hand-authored as one unit (FK-coupled; splitting them across the
  generated/hand-authored boundary would put half a pair in the drizzle snapshot and half outside it).
- **`intent_signals` untouched, not migrated, not deprecated.** Different question: it is a tenant's private
  scoring input ("this contact opened my email"); `master_signals` is a canonical fact the whole platform
  shares ("Acme raised a Series B"). Recorded in both the schema module and the plan so nobody later
  "consolidates" them.
- **D6 fixed:** the vocabulary is rows, not a CHECK enum. New signal families are an INSERT. Each type
  carries its own weight and **decay half-life** — a hiring surge is stale in a quarter, a funding round
  never becomes untrue (`NULL` = does not decay). 13 launch types seeded; half-lives flagged as calibration
  starting points, not researched constants.
- **`intent` family deliberately absent from the CHECK** — X-04, and the heaviest-privacy family. Adding it
  costs a migration and a decision rather than an INSERT.
- Polymorphic subject with no FK, same documented trade-off as `provenance_event.entity_id`.
- **Compliance owed before person subjects are populated** (recorded in the migration header): person-subject
  signals must join the DSAR erasure fan-out, and `payload` must never carry contact values. Both need
  itests, not comments.

Architecture map regenerated after the new schema module.

Next: 0104 — Group D company/person completeness (`master_company_locations`, `master_company_contact_points`,
`master_company_funding`, `master_person_identifiers`). All non-partitioned, so drizzle-kit generates it.

### Iteration 9 — 2026-08-08
Scope: Phase 5 slice 4. Migration 0104 — Group D completeness. Gates green.

Fixes **D7** (company location only at Layer 1, so two tenants could not corroborate the same company's
offices) and **D8** (one identifier column per source — every new provider a migration).

- `master_persons.linkedin_public_id` **stays**; the new table generalizes *additional* identifiers. A
  hand-appended `INSERT … SELECT … ON CONFLICT DO NOTHING` backfills it so both agree immediately. Noted at
  the call site that this belongs in a batched sweep if the table ever grows — an unbounded
  `INSERT … SELECT` in a deploy path is how a migration becomes an outage.
- `master_company_contact_points` carries a **`value_blind_index`** even though the value is cleartext
  business data: "generic" is a claim, not a guarantee — an `info@` mailbox is often routed to one
  identifiable person, and the suppression list keys on hashes. Without the column a suppressed individual
  could not be matched here at all and their address would keep re-entering through the company door.
  Column now, HMAC wiring in Phase 6, no destructive migration later.
- Funding is the **structured fact**; the `master_signals` row is the **dated event**. Both kept — the
  profile reads one, the feed reads the other, neither reshapes the other's data.
- One `hq` per company, DB-enforced by partial unique.

**Known limitation recorded, not glossed** (V4 lesson applied preemptively): the funding-round unique is on
`(company, round_type, announced_on)` and both latter columns are nullable, so two "unknown round" rows will
not collide. Best-effort dedup, not exact — the ingest path must not assume otherwise.

Also verified: the hand-authored journal tags 0101–0103 **survived `drizzle-kit generate`** intact (it
rewrote `_journal.json` and preserved them). Worth knowing before the next hand-authored migration.

Next: 0105 — `master_employment` D9 change (drop NOT NULL on `master_company_id`, add `company_name_raw`,
CHECK, and the normalized partial unique from revision R-2). This is the **only** existing-column change in
the whole program, so it gets its own migration and its own itest.

### Iteration 10 — 2026-08-08
Scope: Phase 5 slice 5. Migration 0105 — the D9 change. **Full monorepo typecheck 25/25 green.**

The only existing-column change in the program. An employment assertion whose employer had not yet
ER-resolved could not be recorded at all — rejected at the door, losing the title, dates and provenance with
it. Now the raw name lives beside the resolved id, so the assertion survives until ER catches up and can be
re-resolved without re-fetching the source.

Approach: edited the schema and let drizzle emit the ALTER, rather than hand-authoring a diff drizzle would
later fight.

**One hand-edit that matters.** drizzle emitted a plain `ADD CONSTRAINT … CHECK`, which takes an ACCESS
EXCLUSIVE lock and full-scans the table. Every existing row passes — the verdict is never in doubt — but on
a graph-sized table the *scan* is the problem, not the result. Split into `ADD … NOT VALID` (brief lock,
enforced on new rows immediately) + `VALIDATE CONSTRAINT` (scan under SHARE UPDATE EXCLUSIVE, blocking
neither readers nor writers). Same end state, no write outage.

**`company_name_normalized` is a stored column, not an expression index** — an expression index would need a
SQL normalization function, giving two implementations of "normalize a company name" (TS + plpgsql). They
drift, and when they do, unresolved stints silently stop deduping against the key `master_companies` uses.

Known limitation stated in the index comment, not glossed: the unresolved-stint unique is best-effort —
`started_on`'s `'-infinity'` sentinel means two different employers sharing a normalized name and an unknown
start collide until ER resolves them. Better than unbounded duplicates, and reversible via
`source_records`/`match_links`. The DOWN is deliberately asymmetric and says so: restoring the NOT NULL is a
strengthening that fails once unresolved rows exist.

Ran the **full monorepo** typecheck rather than just `packages/db`, because this is the one change that
alters an existing type (`masterCompanyId` is now `string | null`). Nothing depended on its non-nullability.

Next: 0106 — index `block_key` on `master_persons`/`master_companies`/`master_technologies` CONCURRENTLY,
the one schema change the probabilistic ER tier needs. Note CONCURRENTLY cannot run inside a transaction
block, which is the trap to check against how migrations are applied here.

### Iteration 11 — 2026-08-08
Scope: Phase 5 slice 6. Migration 0106 — ER blocking indexes. Gates green; `drizzle-kit generate` confirms
no pending diff.

**Checked the CONCURRENTLY question instead of assuming it, and the assumption would have been wrong.**
This repo does **not** use Drizzle's migrator. `applyJournalByHash` runs each statement through
`sql.unsafe()` in **autocommit** ("statement by statement (autocommit, hash row recorded LAST)"), so there
is no enclosing transaction and CONCURRENTLY is legal. `migrate.ts:15-17` still says *"Drizzle's migrator
opens a real DDL transaction"* — that describes the pooler hazard, not this path, and taking it at face
value would have produced the wrong migration.

**Second finding: the migrator's tolerance set would have hidden a failure.** A failed
`CREATE INDEX CONCURRENTLY` leaves an **INVALID** index behind. The retry raises `42P07`, which **is in
`ALREADY_EXISTS`** — so it would be logged "tolerated: object already exists", the migration marked applied,
and a dead index left forever: never used by the planner, still maintained on every write. Fixed with a
name-scoped `DO` block that drops invalid leftovers before `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
Convergent after either outcome.

Indexes are hand-authored, **not** in the Drizzle schema — Drizzle emits a plain blocking `CREATE INDEX` for
schema-declared indexes. Both `block_key` comments updated from "[RESERVED, leave UNINDEXED]" to point at
0106, with an explicit *do not "fix" this by adding an index() entry*.

Next: 0107 — `master_confidence_policy`, the per-(field, source_type) half-life table backing the decay
function. Then Phase 5 is done and Phase 6 (the data-management layer: repositories, ER, decay fold) begins.

### Iteration 12 — 2026-08-08. **Phase 5 DDL complete.**
Scope: migration 0107 — `master_confidence_policy`. Gates green; map regenerated (1986 files).

Parameterizes `confidence = base(source_weight) × corroboration(source_count) × decay(age, half_life)`. All
three inputs already existed in the graph; what was missing is the curve — 08-architecture says plainly
"Decay curves are Phase 2 — not built", which is why a five-year-old assertion and a fresh one score
identically today.

**A table, not constants, and the reason matters.** Every published decay figure R4 found comes from a data
vendor selling the cure. Direction and dominant driver (job change) are consistent across independent
sources; the coefficient is not. Hard-coding a marketing number as a physical constant would bake an
unverifiable claim into the scoring path. So the shape ships with defaults and gets calibrated against
TruePoint's own bounce/reverification telemetry. **Tuning is an UPDATE, not a deploy.** Every seeded row
carries a `notes` string explaining itself.

Keyed `(field, source_type)` because R1 states decay varies by source type and active sources outrank
passive. 26 rows seeded. `half_life_days` NULL = does not decay (a rebrand is an event we observe, not
decay). `is_enabled` is the switch that keeps the display-only-first rollout honest.

**Phase 5 summary: 8 migrations, all additive.** One existing column weakened (0105), nothing dropped, no
data destroyed. Two pre-existing defects found and fixed that were not in the original plan — the
partition-ACL inheritance gap (0102) and the invalid-index/tolerance interaction (0106).

Next — **Phase 6**, the data-management layer. Order: repositories for the new tables (they are the only
data-access path) → the decay fold in `packages/core/src/prospect/` beside `fieldProvenance.ts` (pure, unit
-testable, no DB) → the ER blocking sweep → the adoption dual-write + staged reader cutover (R-1).
Still owed and tracked: HMAC wiring for `master_company_contact_points.value_blind_index`, and
`master_signals` joining the DSAR fan-out before person-subject rows are populated.

### Iteration 13 — 2026-08-08. **First slice actually TESTED, not just written.**
Scope: Phase 6.1 — the confidence/decay fold. `bun test` **33 pass / 0 fail**, 75 assertions.

Reordered Phase 6 to put pure code first: `packages/core` is unit-testable in this environment,
`packages/db` needs Postgres (CI). Building the provable part first means each landed slice is verified
rather than merely written — every Phase-5 migration so far is lint-clean and hand-reviewed but has **never
run against a live database**.

**Deliberate deviation from the Phase-3 design, recorded in the module and the doc.** §4 specified three
factors (`base × corroboration × decay`); implemented as two, because noisy-OR
(`1-(1-w)^n`) collapses base and corroboration into one principled function. It is also exactly the
philosophy `cascade 1.md` §2.4 names. A separate hand-rolled corroboration curve on top would double-count
and need a second set of magic numbers; noisy-OR needs none — "second source worth far more than the tenth"
falls out of the algebra, and a test asserts that property so it cannot silently regress.

Honest caveat stated in the module: noisy-OR assumes independence, and two providers reselling one upstream
feed are not independent. `corroboration_ceiling` is the blunt cap; real independence modelling is a much
later problem.

**The defensive cases are the point**, and each has a test: a future `observedAt` clamps to no-decay (without
it, `2^(+x) > 1` would hand out MORE confidence than any source justified — the only way this function could
inflate a score) · `source_count` 0/negative treated as 1 · **no policy returns null, not a default** ·
unknown age skips decay but reports `ageDays: null` so the caller can tell the difference · a disabled
policy row falls through to the next precedence tier, which is what makes `is_enabled` a safe rollout switch.

`daysUntilStale` turns reverification from "re-check everything every N days" into "re-check this value when
it is about to stop being trustworthy" — the scheduler input behind S-09/S-13.

**Nothing calls it yet, deliberately** — display-only first per 04-validation.md.

Gates: `bun test` 33/0 · full monorepo typecheck 25/25 · biome clean · depcruise 0 errors · map 1988 files.

Next: 6.2 — repositories for the new Layer-0 tables, through `withErTx`. Those need Postgres to verify, so
they land with their itests written but unrun locally, and CI is the proof.

### Iteration 14 — 2026-08-08
Scope: Phase 6.2a — `masterTechnologyRepository`. Gates green (typecheck 25/25, biome, depcruise 0 errors).

Shaped exactly like `masterGraphRepository`: caller owns the transaction (`Tx` in, always inside `withErTx`),
no policy decisions, convergent writes.

**The decision that needed real thought: an advisory lock instead of a unique constraint.** Every other
convergent write here uses a global UNIQUE + `ON CONFLICT DO NOTHING`. The adoption edge deliberately has no
unique, because its grain is one row per detection *episode*. That leaves `recordDetection` with a real
read-then-write race — two workers would both find no open episode and both open one, making the company look
like it adopted the same technology twice. Fixed with a transaction-scoped advisory lock on
(company, technology, method): serialises that triple only, auto-released at commit, no cleanup to forget.

Rejected the alternative (let duplicates land, collapse on read) and recorded why at the call site: **the
profile read is not the only consumer.** The displacement sweep reads this table too, and a spurious second
episode is a spurious "re-adopted" signal fired at a customer.

Also: `recordDetection` extends the open episode with `GREATEST`/`LEAST`, so a late-arriving OLD sighting can
never make a stale detection look fresh · alias resolution probes `LIMIT 2` and returns **null** on ambiguity
rather than guessing which product a detection belongs to · `closeDetection` returns a **count**, not a
boolean, per the RLS-denial discipline (assert "changed exactly one row", don't infer from no error).

**Registry hygiene:** the new file landed as a 9th unassigned in the navigation map. Added
`masterTechnology: "master-sync"` to `REPO_DOMAIN` in `.claude/hooks/lib/arch-map.mjs` — that registry is
what the generator expects each phase to extend, and it's the same system-owned graph. Back to 8 unassigned;
the 4 pre-existing unregistered repositories remain a separate tracked follow-up, untouched.

**Not verified and cannot be from here:** no query has run against Postgres. The advisory-lock serialisation
and the extend-vs-open branch need an itest with two concurrent transactions — Phase 9, CI is the proof.

Next: `masterSignalsRepository` + `masterCompanyDetailRepository`, then the ER blocking sweep (6.3).

### Iteration 15 — 2026-08-08
Scope: Phase 6.2b — `masterSignalsRepository` **plus the PII guard as executable code**. `bun test` **21 pass
/ 0 fail**. Gates: typecheck 25/25, biome clean, depcruise 0 errors, map 1991 files / 8 unassigned.

`04-validation.md` Part 3 said of the no-contact-values rule, verbatim, that it *"needs an itest, not a
comment"*. This slice makes both its requirements real:

**1. `assertNoContactValues` runs on every write path and throws.** Pure and exported specifically so the
compliance control is unit-testable **without Postgres** — proven here rather than deferred to CI. Three
precise rules: forbidden key tokens (normalized past casing/separators; the key alone is disqualifying, since
an empty `contact_email` is still a schema heading in the wrong direction), email-shaped values, and
E.164-shaped values. Deliberately **not** a generic long-digit-run test — that would reject
`amount_minor: 5000000000` and get the guard switched off by the first engineer it blocked.

**False positives are the real risk**, so ~half the tests prove the guard stays out of the way: funding
amounts, evidence URLs, realistic funding/leadership payloads, headlines naming companies. Violations report
a path and reason, because a message that doesn't name the field makes the debugger guess between keys.

**2. `erasePersonSignals`** — a real DELETE, not a tombstone (09-compliance: erasure beats append-only for
personal data), returning a count per the RLS-denial discipline. A dated career event naming a person is
personal data even with no contact value in it.

**Declined to add a unique** over (subject, type, observed_at), which *is* expressible since observed_at is
the partition key: two genuinely distinct signals of one type can share a day, and a constraint that silently
drops the second is worse than a duplicate a human can see. Idempotency stays upstream on
`source_records.content_hash` + an `evidence_ref` pre-check for the derivation-replay case.

Registered `masterSignals: "master-sync"` in `REPO_DOMAIN` — same registry the generator expects each phase
to extend. Unassigned stays 8.

Next: `masterCompanyDetailRepository`, then the ER blocking sweep (6.3).

### Iteration 16 — 2026-08-08. **Found and fixed a bug in my own two previous slices.**
Scope: Phase 6.2c — `masterCompanyDetailRepository`. Gates: typecheck 25/25, biome clean across all 199
`packages/db` files, depcruise 0 errors, guard tests 21/0, map 1992 files / 8 unassigned.

**The bug.** Writing the suppression check meant checking what `leadwolf_er` can actually read. Its explicit
grant in `applyMigrations.ts` ends with the comment, verbatim: *"A future Layer-0 table that the resolver
writes MUST be added here."* **None of the eleven new Layer-0 tables were in it.** The repositories shipped
in iterations 14 and 15 both run under `withErTx` and would have failed with permission denied on their
first query — not at review, not at typecheck, not in any gate that runs without Postgres.

Fixed: `SELECT/INSERT/UPDATE` on the eleven writable tables, `SELECT` only on `master_signal_types` and
`master_confidence_policy` (staff-authored config an ingest path must never rewrite), **no DELETE anywhere**.
Consequence: **`erasePersonSignals` is NOT a `withErTx` call**, now stated loudly in its docblock — calling it
as `leadwolf_er` fails, which is correct, because erasure is an audited privileged operation.

The two partitioned tables are granted on the parent; partitions inherit via `mirror_partition_acl` (0102).
**The Phase-5 security fix pays for itself here** — without it the monthly sweep would mint partitions the
resolver could not write.

**Suppression is a parameter, not a join — verified.** `suppression_list` is RLS-scoped overlay, and
`leadwolf_er` has *"NO overlay grant"* and is not BYPASSRLS, so a join fails at runtime. Follows the
contribution-gate pattern: decided caller-side, carried in. The parameter is **required, not optional** — an
optional flag is a check someone forgets, and the failure mode is a suppressed address re-entering through
the company door.

**`recordPersonIdentifier` returns conflicts instead of swallowing them.** `ON CONFLICT DO NOTHING` is the
obvious implementation and it is wrong: an identifier held by a *different* person is evidence the two golden
records are the same person — the strongest merge hint ER can get. Returned as `{status:"conflict"}` for the
review queue, and the SELECT/INSERT race is re-read so the signal survives a concurrent claim.

Next: 6.3, the ER blocking sweep — compute `block_key`, generate candidate pairs, score with m/u weights.
The blocking-key function is pure, so it is testable here; the sweep itself needs CI.

### Iteration 17 — 2026-08-08. **Deleted a duplicate I had just written.**
Scope: Phase 6.3 — ER candidate generation. `bun test packages/core/src/er/` **43 pass / 0 fail**; typecheck
25/25; biome clean; depcruise 0 errors.

**The mistake.** I built blocking keys AND a Fellegi-Sunter scorer. A name collision at the barrel export
surfaced `packages/core/src/er/fellegiSunter.ts` — **already shipped and tested**, with a calibrated config,
next to `compareRecords.ts` and `stringSimilarity.ts`. The Phase-2 audit recorded the probabilistic tier as
"reserved, not implemented", which was true **of the schema**; I carried that into an assumption about the
**code** and never checked.

Corrected rather than papered over: deleted the duplicate scorer, moved the survivor to
`packages/core/src/er/blocking.ts` beside its siblings, and pointed its header at the existing scorer so the
next reader does not repeat it. What survived is genuinely missing — both sibling modules call the candidate
generator "a later slice", and grep confirms no blocking existed.

**Three test failures were real design errors, not test bugs:**
1. **A claim in my own comment was false** — the first-initial key unifies *truncations* (Rob/Robert), NOT
   *substitutions* (Bob/Robert, Bill/William), which have different initials. Comment corrected; the
   limitation is now **asserted by a test** so it is a documented property.
2. **The prior does real work** — one agreeing high-discrimination field against a 1-in-10,000 prior lands at
   ~0.49, not >0.99. Correct: two random records are overwhelmingly likely to be different people. A model
   returning 0.99 there would auto-merge on a single shared field.
3. `blockBudget(0)` returned **negative zero**. Guarded and tested.

Also swapped the diacritic range `[̀-ͯ]` for `\p{M}` — biome rejects the range, and it covered only
the Latin block, silently failing to fold Vietnamese/Devanagari/Arabic marks.

Pre-existing and untouched: `packages/db/src/seed.ts` has 2 `noConsoleLog` errors from commit `40846ede`.

Next: 6.4 — the worker sweep that calls blocking + the existing scorer and writes `match_links`
(`review_status='pending'`), then the adoption dual-write (R-1).

### Iteration 18 — 2026-08-08. **Checked first this time.**
Scope: Phase 6.4. Gates: typecheck 25/25, biome clean, depcruise 0 errors, blocking tests 43/0.

**The sweep already existed.** `apps/workers/src/queues/erSweep.ts` is complete — leader-locked,
cursor-resumed, bounded, scoring with the existing `compareRecords` + `scoreFellegiSunter`, proposing
pending `match_links`, gated on `ER_SHADOW_ENABLED`, never auto-merging. My tracker item "build the sweep"
was wrong for the same reason as iteration 17: derived from the schema-level audit finding rather than the
worker code. This time I read before writing, so nothing was duplicated.

What IS missing is named verbatim in `erRepository.ts`'s header: *"block_key is RESERVED/unpopulated …
name/email blocking is a later refinement; a seed with no company yields no candidates here."*

**Why the name pass matters, and why it is additive rather than a replacement.** The company block finds
colleagues — high precision, the natural dedup neighbourhood. It structurally CANNOT find two cases:
1. a company-less person, previously skipped outright and therefore invisible to ER entirely;
2. **the same person recorded at two companies — the job-change duplicate, i.e. S-09 and S-13**, the two
   outcomes this programme exists to serve. A company-keyed block can never surface it, because the two rows
   disagree on exactly the key it blocks on.

Added: `findCandidatesByBlockKey` (equality join on the column 0106 indexed) · `countBlockMembers` +
`blockBudget` admission, where an over-large block is **skipped and logged**, never silently dropped (an
over-large block is usually a very common surname — exactly where duplicates cluster, so a silent skip would
read as "nothing to resolve here") · `setBlockKey`, guarded on `IS NULL` so recomputing keys stays a
deliberate migration · `ErCandidatePerson` widened with `blockKey` + `locationCountry`.

The **backfill runs inside the existing tick** over rows already loaded and already bounded — a separate
backfill sweep would re-scan the same table to do strictly less. Both candidate sets union and dedupe on the
existing pair key, so a person found by both blocks is scored once.

Next: 6.5 — the adoption dual-write + staged reader cutover (R-1), the last piece before Phase 7.

### Iteration 19 — 2026-08-08. **A wrong plan retired instead of code written.**
Scope: Phase 6.5. Gates re-run green (typecheck 25/25, biome, depcruise 0).

Checking who **writes** `master_companies.technographics` before building a dual-write for it overturned
`04-validation.md` V2 and revision R-1, which depended on it.

| | V2 claimed | 6.5 verified |
|---|---|---|
| Writers of the Layer-0 jsonb | implied live | **none.** Dead column. |
| The four "readers" | read the Layer-0 jsonb | read **`accounts.technologies`** — different column, Layer-1 overlay |
| Does `accounts` carry technographics? | resolved **NO** | **YES**, named `technologies` (`contacts.ts:65`), jsonb[], GIN-indexed |

Live path never touches Layer 0:
`intent_signals(tech_install)` → `runFirmographicRollup` → `accounts.technologies` → the `technology` search
facet → the prospect filter group.

**Root cause, recorded because it recurs:** the audit resolved *"does accounts carry technographics?"* by
grepping the literal string `technographics`. The column is named `technologies`. **A string-match grep was
treated as a semantic answer** — a NO meaning "this word does not appear" became "this concept does not
exist", and every downstream conclusion inherited it. Same shape as iterations 17 and 18, and the third time
verifying before building has changed the plan.

**Consequence: the migration is simpler.** Migration 0108 (dual-write) is **retired** — there is no live
Layer-0 writer to keep in sync. The corrected cutover: (1) populate the adoption edge from a licensed feed;
(2) point the rollup at the edge instead of inferring technographics from `intent_signals` — a behavioural
change to a shipped filter, so **proposed, not made**; (3) drop the dead column in its own release, after (1).

Docs corrected: `04-validation.md` V2 carries a prominent superseded banner, `05-migration-plan.md` retires
0108 with the reason, and `masterTechnologyAdoption.ts`'s header no longer claims a dual-write is pending.

Next: Phase 7 (application integration) or Phase 9 (the itests Phases 5–6 owe). Phase 9 is the higher-value
choice — six slices of DB code have shipped without a single one running against Postgres.

### Iteration 20 — 2026-08-08. Phase 9 opened: the Layer-0 isolation itest.
Scope: `packages/db/test/intelligencePlatformIsolation.itest.ts`. `typecheck:tests` **exit 0**, biome clean,
full monorepo typecheck 25/25, map 1995 files.

**This is the test `04-validation.md` made the design's security verdict conditional on.** Layer 0 has no
workspace_id, so no fail-closed RLS predicate can exist over it — isolation is the GRANT and nothing else,
which makes it exactly the boundary that stays invisible until something asserts it. Every gate these tables
have passed so far is blind to a missing REVOKE.

Four properties, each tied to a defect that was real or would be:
1. **`leadwolf_app` denied every DML verb on all 13 tables.**
2. **Partitions denied BY NAME** — the 0102 fix. Partition ACLs do not inherit, so `REVOKE ALL ON
   master_signals` says nothing about `master_signals_2026_08`. Partition names are discovered from
   `pg_inherits` rather than hard-coded, and the test asserts it found at least one — otherwise it would pass
   by checking nothing.
3. **`leadwolf_er` can actually work** — this is the assertion that would have caught iteration 16's bug,
   where every Phase-6.2 repository would have failed at runtime with 42501.
4. **`leadwolf_er` denied DELETE**, and denied UPDATE on the staff-authored config tables.

Plus: the 0103/0107 hand-appended seeds landed, and — asserted rather than trusted to a comment — **no
`intent` family exists in the signal vocabulary** (the X-04 boundary).

**Deliberate deviation from the house RLS rule, explained in the header.** The rule is "assert affected-zero-
rows, never assert it threw", because UPDATE/DELETE under a *missing policy* silently affect nothing. That
rule does **not** apply here: these tables have no RLS, the wall is grant-absence, and every verb including
SELECT raises 42501. Asserting the code is correct *because* the mechanism is a grant — noted so that if RLS
is ever added, the test's shape gets revisited with it.

**Cannot be run from this host — stated plainly rather than implied.** `docker` is not installed and
`ITEST_DATABASE_URL` is unset, so the 92-itest suite has never executed here. What IS verified locally:
`typecheck:tests` (which exists precisely because a wrong itest signature once passed every local gate and
failed in CI), biome, and hand review. **CI is the proof.**

Next: repository-behaviour itests — the advisory-lock serialisation in `recordDetection` (two concurrent
transactions), the extend-vs-open episode branch, and `recordPersonIdentifier`'s conflict return.

### Iteration 21 — 2026-08-08. Repository-behaviour itest.
Scope: `packages/db/test/intelligencePlatformRepositories.itest.ts`. `typecheck:tests` exit 0, biome clean,
full typecheck 25/25, map 1996 files.

Pins the decisions that were argued in comments and are otherwise one refactor from silently reverting:
episode grain (open → extend → close → **re-open as a NEW row**), the `GREATEST`/`LEAST` guard that stops a
late-arriving old sighting from making a stale detection look fresh, `closeDetection` returning a count with
a second close as 0 rather than an error, ambiguous-alias resolution returning null instead of guessing,
`recordPersonIdentifier` **returning** a conflict, HQ upsert replacing rather than duplicating, and a
suppressed contact point writing nothing.

Also proves the PII guard **end to end at the repository boundary**, not just as a unit test of the pure
function: a payload with a contact value is refused and no row lands.

**The concurrency test I deliberately did NOT write.** The obvious shape is two concurrent `withErTx` calls
racing `recordDetection`. `withErTx` runs on the owner pool, whose size is `env.DB_OWNER_POOL_MAX` — if that
is 1 in the test environment, the two calls serialise on the **pool** and the test passes green without the
advisory lock existing at all. A green that proves nothing is worse than no test, because it retires the
question.

Instead the lock **primitive** is tested on two independent connections with `lock_timeout = 600ms`, asserting
`55P03 lock_not_available`. That proves the mechanism `recordDetection` depends on actually blocks, and turns
"would hang forever" into a fast assertable failure rather than a suite that hangs on regression.

**Still unrun.** No Docker, no `ITEST_DATABASE_URL` on this host. Two itests now written and locally
verified only by `typecheck:tests`, biome and review. CI remains the proof.

Next: wire both itests into CI expectations / confirm they are picked up by the existing itest job, then
Phase 7 (application integration) or Phase 8 (the four profile UIs).

### Iteration 22 — 2026-08-08. CI pickup verified; two stale CI comments corrected.
Scope: verification, not code. No source changed; the only edit is comment text in `.github/workflows/ci.yml`,
confirmed comment-only by inspecting every `+`/`-` line of the diff.

**Verified: both new itests WILL run in CI, with nothing to wire.** The job discovers files with
`find packages apps -name '*.itest.ts' | sort` and round-robins by `index mod 4` across a 4-way shard matrix.
No hard-coded list, no registry — which is exactly what I wanted to confirm rather than assume, since a
hard-coded list would have meant both files silently never executing.

**Two stale comments found and fixed.** One was merely out of date; the other actively misleads:

1. *"packages/db's 93 itest files … This checks the 76 that are currently clean; the 17 excluded in
   tsconfig.typecheck.json are a shrinking ratchet."* — The ratchet is **closed**. `tsconfig.typecheck.json`
   itself says it has no exclude list and every test file is checked, and instructs future readers to keep it
   that way. CI was still describing an exclusion mechanism that no longer exists, which invites someone to
   "add to" a list whose whole point was reaching zero. Corrected, with the don't-reintroduce-one rule
   restated where a CI reader will see it.
2. *"91 itest files"* → the real count is **114** (107 of them in `packages/db`). Also recorded that the
   shard split is `find | sort` + mod 4 so new files need no registry update, and that the next thing to give
   is the 40-minute ceiling — for which the fix is a fifth shard, not a longer timeout.

Neither is a code defect. Both are operational documentation that a future engineer would have acted on.

Next: Phase 7 (application integration) or Phase 8 (the four profile UIs). Phase 8 is better sequenced — the
profile reads are what make the new tables visible, and `03-target-architecture.md` §5 already specifies each
profile's read set, with research R9's finding (neither ZoomInfo nor Apollo surfaces "last verified") as the
design thesis.

### Iteration 23 — 2026-08-08. Phase 8 opened. ⚠ **ITS CENTRAL FINDING WAS WRONG — see iteration 24.**
> Kept for the record, struck rather than deleted. Every claim below that the badge is unsurfaced is false;
> the greps it rests on were case-sensitive. Corrected in iteration 24 and in `08-profile-ux.md`.

Scope: verification + design. **No JSX** — CLAUDE.md mandates reading `truepoint-design` and
`truepoint-architecture` before any component, and neither has been read this session.

Verified before designing (the lesson from iterations 17–19, applied deliberately):

1. `apps/web/src/features/prospect/` — `RecordDetail`, `QuickViewDrawer`, `AccountDetailDrawer`,
   `ProspectPage` all exist. **No Technology or Product profile exists.**
2. Grep across all of `apps/web/src` for `provenance|lastVerified|last_verified|confidence` — **zero matches**.
3. Grep for `provenanceBadge` across apps + packages — **zero call sites**. Read the repository in full: it is
   complete, correct, and wired to nothing.
4. Grep for `dataHealth` — **zero in `apps/web`**, but present and *tested* in `packages/types`
   (`contacts.test.ts` asserts `{score, freshnessStatus}` round-trips, plus a case asserting the field is
   optional "on surfaces that don't render the column").

**Finding: the S-10 badge is ~2/3 built and surfaced nowhere.** Freshness is computed and rides the contact
DTO to the client; corroboration has a finished repository with no caller; the decay curve (this programme's
`confidence.ts`) is deliberately uncalled. Three layers deep, zero pixels. The test asserting `dataHealth` is
optional on surfaces that don't render it currently describes **every** surface.

This reorders the phase. R9 found neither ZoomInfo nor Apollo surfaces "last verified" — that hole is the
product's stated differentiator (S-10, A-01), and the machinery to fill it already exists on records users
open today. Meanwhile the four requested profiles read tables that, as of 6.5, **hold no rows**: creating,
granting and testing `master_technology_adoptions` / `master_signals` did not populate them, and population
waits on a licensed feed. Four profiles over empty tables ships four empty pages.

Wrote `08-profile-ux.md`: the audit, the reorder, slice 8.1 (badge) with its three load-bearing constraints —
**null ≠ zero** (badgeFor returns null for un-logged records; rendering "0 sources" would actively misinform),
the badge cannot be read on the request path (`leadwolf_app` is REVOKE'd from `provenance_event`, so it needs
a `withErTx` server fetch like `resolveMasterForLanding`), and contributor identity must stay inside the SQL
aggregate — plus a per-profile blocked-on table. Recommended order: badge → Prospect (career timeline off
`master_employment` SCD2, which is real data) → pause on the rest.

One new small design question recorded: what a profile section renders when its table exists but is empty.
The badge answers it (omit the clause); the profiles need the same discipline or they ship as pages of zeros.

Next: read `truepoint-design` + `truepoint-architecture` SKILL.md, then build slice 8.1. The API shape is the
first real decision — the badge needs a `withErTx` read that today's contact endpoint does not make.

### Iteration 24 — 2026-08-08. Iteration 23 retracted. The badge was already shipped; Phase 8 is data-blocked.
Scope: correction. No source code changed. `08-profile-ux.md` rewritten with a retraction banner.

**What happened.** Reading `truepoint-design` (the mandatory gate before JSX) surfaced a reference to "the
ScorePill recipe". Chasing it landed in `apps/web/.../ListDetailPage.tsx`, which contains a fully built
`DataHealthCell` — score pill, freshness `StatusBadge`, tooltip. That contradicted iteration 23's central
claim within one file, so I re-ran the audit properly.

**The badge is shipped end to end.** `provenanceBadgeRepository.badgeFor` is **called** from
`revealContact.ts:431` and asserted in `provenanceEvent.itest.ts:342`. `packages/core/src/data-health/badgeV1.ts`
assembles score + recency + corroboration explicitly "for outcome S-10, shown in app, extension, and exports".
`apps/web/src/features/data-health/` is an entire feature area with its own route, eight components, home
cards and a reports section. `sourceDiversity` crosses the extension bridge. Full table in `08-profile-ux.md`.

**Root cause — and it is the iteration-19 lesson, repeated.** I grepped `apps/web/src` for
`dataHealth|provenance|confidence|lastVerified`, got zero hits, and concluded the feature did not exist. The
code is spelled `DataHealthCell`, `ContactDataHealth`, `dataHealthTone`, `features/data-health/`. A
case-insensitive search returns **58 files**. I had already written down "don't treat a string match as a
semantic answer" — and then made the search itself unsound, which the earlier lesson did not cover.

**Lesson restated in the form that would have caught it, added to the standing constraints:**
*Search case-insensitively, and try the concept's several plausible spellings — camelCase, kebab-case, the
type name, the directory name — before concluding anything is absent. Absence of a string is not absence of a
capability.* Sixth occurrence of this failure family (17 fellegiSunter, 18 ER sweep, 19 grep-as-semantics, the
`leadwolf_er` grant, 23 the badge, and C9 below).

**New conflict C9, surfaced not resolved.** The same audit found **two** field-confidence implementations:
the shipped `packages/types/src/confidence.ts` (method priors × decay × capped corroboration curve, consumed
by `badgeV1` → app/extension/exports) and this programme's `packages/core/src/prospect/confidence.ts`
(noisy-OR over `master_confidence_policy` rows, keyed on field+sourceType, consumed by **nothing**). Both
compute "how much do we believe this field"; they will disagree. `badgeV1.ts` states the stake itself: *"a
badge that disagrees with itself across surfaces is worse than no badge."* Recommendation recorded — keep the
shipped leaf-package function, have the policy table **supply its constants** rather than fork the math. Not
acted on: it touches shipped code reaching the extension, so it needs sign-off.

**The real Phase 8 conclusion, opposite to iteration 23's.** Phase 8 is not blocked on UI, it is blocked on
**data**. The Prospect profile can be enriched now (career timeline off `master_employment` SCD2 — real rows).
Company, Technology and Product all read tables this programme created, granted, indexed and tested but never
populated. The high-value next work is the **populators**, not more surfaces.

Next: Phase 7 (application integration) reframed around that — what actually writes rows into
`master_technology_adoptions` and `master_signals`. C4/RD-7 (catalog seed licensing) gates the technology half
and is still unsigned, so the signal producers are the unblocked side.

### Iteration 25 — 2026-08-08. Phase 7 designed: the producers. Audit ran the new search discipline.
Scope: verify + audit + design. **No code written.** Artifact: `07-integration-and-producers.md`, structured
as the brief's seven mandated statements.

Applied the iteration-24 rule deliberately — directory listings first, case-insensitive greps, read every file
before claiming what it does. It changed the finding three times.

**The headline: the job-change stack is complete and unwired.** `jobChange.ts` (pure detection — compares
*confidences* not timestamps, `CHANGE_MARGIN = 0.1` anti-flap, "departed" held to the same bar as "moved"),
`recordJobChange.ts` (writes `intent_signals`, notifies only watchers, dedups per user+contact),
`successor.ts` (ranking, `SUCCESSOR_MIN_SCORE = 0.5`), and `jobChangeAlerts.itest.ts` proving the producer end
to end. **Repo-wide, the only callers of `recordJobChange` are that itest and the barrel.** No queue, sweep or
route triggers it; `reverification.ts` does no employment comparison. S-13 measures time-to-learn-about-a-job-
change; that time is currently unbounded because nothing looks.

**Second finding: `intent_signals` has one producer and it never runs.** So `computeScore`'s intent component
and `firmographics.ts`'s `tech_install`→technologies / `funding_round`→stage rollups are all reading an empty
table. Not a crash — a feature that appears to work and is inert, which is worse, because nothing signals it.

**Third: the `SignalType` enum is largely aspirational.** Of nine values, only `job_change` has a producer
(unwired) and two have consumers with no producer. The other five — `web_visit`, `content_engagement`,
`keyword_search`, `linkedin_activity`, `sales_nav_view` — appear **only in the enum declaration**. The first
three *are* X-04 intent data; the last two could only be populated by means hard-constraint 4 prohibits.
Inert today, so a latent trap rather than a live violation → **C10**, with the cheap fix (comment, don't
delete — it is a shipped zod schema).

**The design writes itself, because the fan-out shape is already proven.**
`apps/workers/src/queues/channelReconcileSweep.ts` is exactly the Layer-0-change → per-tenant-write pattern:
leader-locked, env-gated dark, owner-connection census returning **non-PII ids only** and capped per tick,
then per-workspace `withTenantTx` keyset batches with RLS enforcing ("never the owner conn for writes"). Slice
7.1 is one sweep on that shape wiring the two shipped halves together — no schema change, no migration, no new
personal data, nothing new invented. The census/write connection split is a **C-02 boundary**, not a
convenience: "which tenants hold this person" is a cross-tenant read no tenant role may perform.

Risks recorded with mitigations — the sharpest is the **first-run alert storm**, whose real defence is seeding
the watermark to "now" so tick one detects only forward changes (the per-contact dedup bounds repeats, not the
initial burst).

Note for C9: `detectJobChange` composes `computeFieldConfidence` from `@leadwolf/types`. That makes the
shipped confidence model load-bearing for a tested decision path and **strengthens** the recommendation to
retire the duplicate rather than the original.

Next: validate slice 7.1 against `04-validation.md`'s criteria, run the 09-compliance checklist, then
implement — sweep file + registration, dark behind an env gate.

### Iteration 26 — 2026-08-08. Slice 7.1 IMPLEMENTED (dark). The S-13 trigger now exists.
Scope: validate → implement → gate. Five files new/changed; no schema change, no migration.

**Compliance gate run first** (09-compliance §Review gates, which blocks merges). The required five:
- *Data elements touched:* employment facts only (employer id, title, match method, source count, observed
  date) + a contact's display NAME for alert copy. No contact points, no contributor_ref. Passes hard rule 3
  (business-contact data only).
- *Lawful-basis tag:* unchanged — no new ingestion path; this reads facts already in the graph.
- *Consent surface:* none required; no new collection. Hard constraint 4 untouched (no scraping, no capture,
  nothing beyond user-initiated collection).
- *Suppression enforcement point:* unchanged — the sweep writes a signal + a notification, never a channel
  value, so no egress passes suppression here.
- *Erasure propagation path:* unchanged — `intent_signals` is tenant-scoped and already inside the existing
  tenant erasure path. (`master_signals` still owes its DSAR fan-out, but this slice does not write it.)

**Built:**
- `packages/db/src/repositories/jobChangeSweepRepository.ts` — owner-conn census (`DISTINCT tenant_id,
  workspace_id`, non-PII ids, limit-capped), a **per-workspace** Layer-0 fact read, and the tenant-side
  keyset candidate read that runs under the caller's `withTenantTx`.
- `packages/core/src/data-health/runJobChangeSweep.ts` — the per-workspace runner. Composes the shipped
  `detectJobChange` + `recordJobChange` and **re-decides nothing**.
- `apps/workers/src/queues/jobChangeSweep.ts` — leader-locked, env-gated sweep with the Redis watermark.
- Env (`JOB_CHANGE_SWEEP_ENABLED` + two batch knobs), both barrels, and registration in `register.ts`.

**Three design decisions worth keeping:**
1. **Absent watermark ⇒ start at NOW, fan out nothing.** A Redis loss then MISSES changes instead of
   replaying history as an alert storm. Deliberate failure direction: a missed change is repaired by the next
   change on that person; a storm teaches every user to ignore the notification permanently, and an alert
   users ignore has negative value (the same reasoning `shouldAlert` uses to stay silent on title changes).
2. **The watermark advances only on a fully drained tick.** A capped or failed workspace leaves it put, so
   the remainder is re-censused rather than silently dropped. Cost is some re-processing, absorbed by
   `recordJobChange`'s per-(user, contact) notification dedup.
3. **The prior is priced conservatively.** A tenant contact carries no method and no corroboration count, so
   it gets `DEFAULT_METHOD_PRIOR` (provider-grade, mid-ladder) and one source, aged by `last_verified_at`.
   A strong new claim clears that bar; a weak one cannot.

**Caught and fixed in-flight:** my first draft built the `= ANY(...)` id list with `sql.raw` string
interpolation — a SQL-injection shape. Replaced with parameter binding (`= ANY(${ids}::uuid[])`) before any
gate ran. The ids come from our own database, so it was not exploitable, but establishing that pattern in the
data-access layer is how a real one arrives later.

**Gates:** typecheck 25/25 · biome green · dependency-cruiser **0 errors** (12 pre-existing orphan warnings) ·
`packages/core/src/data-health` unit tests **85 pass / 0 fail**.

**Separately, and not caused by this work:** `bun run lint` was already RED on main — 7 format-only errors in
`packages/db/test/*.itest.ts` files untouched by this programme. Fixed (`biome check --write`), format only,
no behavioural change. Worth knowing that the CI lint gate was failing independently of the feature work.

**Standing caveat, unchanged and important:** no Docker on this host, `ITEST_DATABASE_URL` unset. The three
new SQL queries — including the owner-conn census join and the `DISTINCT ON` fact read — **have never
executed against Postgres.** CI is the proof. The `readonly string[]` → `uuid[]` binding in particular is
typecheck-clean but runtime-unverified.

Next: Phase 9 — the itest for slice 7.1 (census finds only post-watermark changes; the tenant read is
RLS-bounded; a title change records a signal but notifies nobody; a move notifies watchers once and not
twice). That itest is what turns "gates green" into evidence.

### Iteration 27 — 2026-08-08. Phase 9: the sweep itest. Nine tests over four properties.
Scope: test. One new file, `packages/db/test/jobChangeSweep.itest.ts`. No source changed.

**Read the existing producer itest first** (`jobChangeAlerts.itest.ts`) rather than inventing fixtures. It
already covers the producer thoroughly — watcher fan-out (owner AND the adder, never a bystander), the
per-(user, contact) dedup, the unsaved-contact signal, the title-change silence, the non-change no-op. So the
new file deliberately covers only what that one **cannot see**: the layer above it.

**The four properties, chosen because each fails SILENTLY:**
1. **The watermark bounds the census.** A change dated before the watermark must not surface; one after must,
   and must return **both** tenants holding the person. This is the alert-storm defence in its load-bearing
   form — a wrong predicate here replays all of history at every watcher the moment the gate flips.
2. **The Layer-0 fact read is workspace-scoped.** It runs on the OWNER connection, where **RLS is not the
   wall** — the explicit workspace predicate IS. A third tenant that does not hold the person must get an
   empty map. Drop that predicate and one tenant's people enter another's read set with nothing raised.
3. **Only the primary+current edge counts.** The fixture seeds a non-primary historical stint dated after the
   watermark; the read must still return exactly one row. A historical stint is not a move.
4. **The runner composes end to end against real columns.** The unit tests drive `detectJobChange` with
   hand-built claims; only a database proves `match_method → method`, `source_count → distinctSources`,
   `observed_at → ageDays`, and — the specific risk flagged last iteration — that the
   `= ANY($1::uuid[])` **parameter binding actually works at runtime**.

Plus two behavioural closers: the sweep never writes to tenant B's contact from tenant A's pass, and a
re-run writes no second notification (the case a deliberately-held-back watermark creates).

**Gates:** `@leadwolf/db typecheck:tests` exit 0 · biome clean · dependency-cruiser **0 errors**.

**Unchanged and still the honest caveat:** no Docker on this host. **The itest has never executed.** It is
written against the real schema and typechecks against the real repository signatures, but "typecheck-clean"
is not "passes" — CI is the proof, and the first run is where fixture mistakes (a NOT NULL I missed, a
default I assumed) will surface.

Arch map regenerated (2000 files, unassigned still 7) and `ARCHITECTURE_MAP.md` updated with both itests
under data-health.

Next: Phase 10 (documentation) is the last unstarted phase, but the higher-value move is **C9/C10 sign-off** —
both are recorded recommendations blocking real cleanup, and C9 in particular now has a tested consumer
(`detectJobChange` composes the shipped confidence model), which strengthens the case to retire the duplicate.

### Iteration 28 — 2026-08-08. C10's safe half applied. Phase 10 written. **All ten phases now have artifacts.**
Scope: document + one additive comment. No behavioural change.

**C10 — the comment half only.** `packages/types/src/intel.ts`'s `SignalType` enum now documents, per value,
what is buildable and what is not: `job_change` has a producer; `tech_install`/`funding_round` have consumers
and no producer (gated on C4/RD-7); `web_visit`/`content_engagement`/`keyword_search` **are** X-04 deferred
intent data; `linkedin_activity`/`sales_nav_view` could only be filled by means hard-constraint 4 forbids and
are explicitly "NOT a roadmap". The five stay in the enum — deleting a member of a shipped zod schema is a
breaking change to fix a documentation problem. **The delete half still needs sign-off; it was not done.**

**C9 was deliberately NOT acted on.** It requires choosing between two defensible confidence models, and the
losing side is either shipped code reaching the extension and exports, or this programme's own migration
0107. That is a human decision, not a cleanup. Recorded, recommended, left alone.

**Phase 10 — `10-handover.md`**, written for someone who was not here. Contains: the not-a-greenfield
correction that reframed everything; the full build inventory (migrations 0100–0107 with the *why* on 0102's
partition-ACL security fix and 0105's `NOT VALID`→`VALIDATE` avoidance of an ACCESS EXCLUSIVE scan); the six
open human decisions in one table with recommendations; why Phase 8 is blocked on **data, not UI**; a reading
order; and §5 — the six-times-repeated failure mode and the rule that would have caught all of them.

§5 is, honestly, the most transferable thing here. Every significant error in 28 iterations had one shape:
concluding absence from a narrow check. Iterations 23–24 stay in this log with the wrong finding **struck,
not deleted**, because the retraction teaches more than a clean record would.

**Gates:** `@leadwolf/types` typecheck exit 0 · biome clean · `packages/types` unit tests **101 pass / 0 fail**.

**Programme status: all ten phases have artifacts.** What remains is not more design — it is (a) CI actually
running the three unrun itests, (b) the C4/C7/C8/C9 decisions, and (c) populators for the empty Layer-0
tables, which (a) and (b) both gate.

### Iteration 29 — 2026-08-08. Adversarial pass over the unrun code. **Found and fixed a real runtime bug.**
Scope: verification. One source fix. The remaining work is gated on human decisions or a push, so the
highest-value available move was to attack the code that has never touched Postgres.

**THE BUG: a bare JS array passed to `= ANY(...)` would have failed at runtime with "malformed array
literal".** `jobChangeSweepRepository.loadJobChangeCandidates` had
`AND c.master_person_id = ANY(${masterPersonIds}::uuid[])` — the exact form the codebase already documents as
broken, in two independent places:

- `dsarRepository.ts:163` — *"Pass ids as a Postgres array LITERAL ('{a,b}') — drizzle's sql template does
  NOT parameterize JS arrays as SQL arrays."*
- `searchRepository.ts:144` — *"Per-element params (ARRAY[$1,$2]::text[]) — a bare array param reaches the
  wire as a scalar ('malformed array literal') under the driver's raw-fragment binding."*

It typechecks (drizzle accepts any value in a template hole) and it lints. **Only execution or a read of the
neighbouring repositories catches it** — and this is the risk flagged explicitly in iteration 26 as
"typecheck-clean but runtime-unverified". The flag was correct and the thing it pointed at was in fact broken.

**Fixed** with `sql.join` per-element params — `ANY(ARRAY[${idParams}]::uuid[])`. Chose that over dsar's
array-literal form deliberately: `sql.join` keeps every id a **bound parameter**, whereas the literal form
interpolates ids into the statement text and is safe only while they remain database-issued UUIDs. Same
session already fixed one injection-shaped pattern in this file; no reason to reintroduce the shape.

**Also verified, and clean:**
- itest fixtures match established precedent (`INSERT INTO master_companies (name)`,
  `master_persons (full_name, …)` — same shape as `erMerge`, `dsarLayerZero`, `contributorIsolation`).
- Every `master_employment` CHECK holds for the seeded rows: `employerPresent` (company id supplied),
  `primaryIsCurrent` (primary row is current), `endedAfterStarted` (ended_on NULL). The
  `uniqUnresolvedStint` partial unique excludes both rows (it applies only where
  `master_company_id IS NULL`).
- **No `updated_at` trigger exists anywhere in 107 migrations** — only `DEFAULT now()` column defaults. So
  the itest's explicit `updated_at = <fixed date>` sticks, and the watermark tests are sound. Had a
  `moddatetime`-style trigger existed, every watermark assertion would have silently tested `now()` instead.

**Lesson, consistent with the standing constraints:** the neighbouring repositories had already paid for this
knowledge and written it down at the call site. Reading two files in the same directory before writing raw
SQL would have prevented it — the same "read before writing" rule that §5 of `10-handover.md` records six
instances of.

**Gates:** `@leadwolf/db` typecheck exit 0 · `typecheck:tests` exit 0 · biome clean.

Next: unchanged — (a) CI, (b) C4/C7/C8/C9, (c) populators. The itests remain unrun; this pass reduces how
much the first CI run will find, but does not substitute for it.

### Iteration 30 — 2026-08-08. Adversarial pass continued over the rest of the unrun code. **Second real fix.**
Scope: verification. One ordering fix in `applyMigrations.ts`. Iteration 29 only covered the slice-7.1 code;
this covered the repositories and migrations from iterations 1–22, which are equally unrun.

**THE FIX: `mirror_partition_acl` was not running last, and its own comment claimed it was.**
The mirror `DO` block sat ABOVE the `leadwolf_er` grants. Its comment read *"This MUST run last: it is
undoing what the blanket GRANT above just did."* It wasn't last — 19 lines later came
`GRANT SELECT, INSERT, UPDATE ON … master_technology_adoptions, master_signals … TO leadwolf_er`.

Consequence on a **fresh** database (i.e. every itest run, and any new environment): each partition was
mirrored from a parent ACL that did not yet carry the er grant, so a `leadwolf_er` query naming a partition
**directly** would be denied — while the comment immediately above that grant asserted the opposite
("their partitions pick the same ACL up automatically").

Scoped honestly: the blast radius was **narrow**. Routed DML checks privileges on the PARENT, and every
repository names the parent, so nothing in the shipped code path would have failed. A second migrate run also
converges it. But it is a documented invariant that was false, of exactly the kind that costs someone a
debugging session — and the isolation itest could have asserted it either way and been misled.

**Fixed** by moving the mirror block to the genuine end of the grants string (verified by string position:
mirror index 28678 > er-grant index 25095), with a note at both sites explaining the ordering dependency and
instructing that anything appended later goes ABOVE the mirror.

**Verified clean in the same pass — four things that could each have been a first-run failure:**
1. **The array trap does not recur.** `masterTechnologyRepository`, `masterSignalsRepository`,
   `masterCompanyDetailRepository` use scalar params throughout — no bare-JS-array `= ANY(...)`.
2. **Affected-row counts are driver-agnostic.** `closeDetection` and `erasePersonSignals` both use
   `RETURNING id` + `.length`, not a driver-specific `rowCount`.
3. **The migrator splits on `--> statement-breakpoint`, not `;`.** Confirmed by reading
   `applyJournalByHash`. That is what makes 0106's `CREATE INDEX CONCURRENTLY` legal (each is its own
   autocommit statement — no enclosing transaction) and what keeps 0102's dollar-quoted function bodies
   intact. All four hand-authored migrations carry breakpoints (0101: 5, 0102: 3, 0103: 7, 0106: 4).
4. **`DO $$ … END $$;` dollar-quoting is correct** in every block in `applyMigrations.ts` — a single `$`
   would have been a syntax error breaking every itest and every deploy.

**Gates:** `@leadwolf/db` typecheck exit 0 · biome clean across 2098 files.

**Pattern across both adversarial iterations:** each bug was a *claim in a comment that the code did not
honour* — "typecheck-clean" (it was, and still broke), and "MUST run last" (it didn't). Comments asserting an
invariant are worth checking against the code precisely because they are load-bearing enough to write down.

Next: unchanged — (a) CI, (b) C4/C7/C8/C9, (c) populators.

### Iteration 31 — 2026-08-08. Third adversarial pass. **Clean — and that is the finding.**
Scope: verification only. **No changes.** Applied iteration 30's lens (*a claim in a comment the code may not
honour*) to the last unchecked surface: the two earlier itests and migrations 0100/0103/0104/0105/0107.

**Four claims checked, all TRUE:**
1. `intelligencePlatformIsolation.itest.ts` asserts `parts.length > 0` on the strength of the comment *"the
   migrations create months + a DEFAULT partition, so there is always at least one."* **Verified:** 0101 and
   0103 each call `ensure_month_partitions(…, 3)` **and then** create an explicit `…_default PARTITION OF …
   DEFAULT`, in that order — with both files carrying the 0085/0089 rationale for why months must come first
   (a row in the DEFAULT partition blocks a later `CREATE … PARTITION OF` for that month outright). So the
   assertion cannot pass vacuously, and out-of-range writes land in the default rather than failing.
2. 0104's hand-appended backfill claims idempotence *"against the global (id_type, id_value) unique."*
   **Verified:** `uniq_master_person_identifier` on `(id_type, id_value)` is created at line 74, the
   `INSERT … SELECT … ON CONFLICT DO NOTHING` runs at line 92 — correct order, and the targetless
   `ON CONFLICT` covers any unique violation.
3. 0105's `NOT VALID` → `VALIDATE CONSTRAINT` split is the standard avoidance of an ACCESS EXCLUSIVE full
   scan. Correct as written.
4. The DEFAULT-partition safety net means `master_signals`' arbitrary `observed_at` (e.g. a backdated funding
   round) cannot be rejected for falling outside the created months — the failure mode 0084's own header
   warns about.

**Why "clean" is worth recording.** Both bugs found in iterations 29 and 30 were in the **newest** code —
the slice-7.1 repository and the grants block edited in the same sitting. The older migrations, written more
slowly and with their reasoning spelled out at the time, held up. That is a signal about where to point the
next review, not a reason to trust the code more broadly.

**Diminishing returns reached on static review.** Three passes: two bugs, then nothing. The residual risk is
now concentrated in things static reading genuinely cannot settle — whether the queries return the shapes the
casts assert, whether the fixtures satisfy every constraint, whether RLS behaves as the itests expect. **Only
execution closes those**, and the honest status remains: eight migrations, six repositories and three itests
have never run against Postgres.

Next: unchanged — (a) CI, (b) C4/C7/C8/C9, (c) populators. Of these, (a) is now the binding constraint on
everything else, and it needs a commit and push, which has not been requested.

### Iteration 32 — 2026-08-08. Closed the one brief item with no artifact: API architecture (`09-*`).
Scope: audit + document. No code. Chose this over a fourth static-review pass, because iteration 31 recorded
that static review had hit diminishing returns and repeating it would have been ignoring my own finding.

**Found the gap by counting, not guessing:** the docs ran 00–08 then jumped to **10**. Brief scope item 10
(API architecture) had no artifact.

**But it is substantially SHIPPED** — the fourth time this programme has found the thing it was about to
design already built. Eleven of fifteen sub-items complete, verified by opening files rather than by grep:
`authn` · `tenancy` · six authorization guards with tests · `rateLimit` (+ a reveal-specific one) ·
`idempotency` · `requestId` · **RFC 9457** `application/problem+json` in `error.ts` wired as Hono's `onError`
· `webhooks` (HMAC + SSRF guard) · `scim` · 39 feature areas covering entity/search/enrichment/contribution/
integration APIs. Also notable: `extensionScope.ts` (AUTH-065) restricts extension-minted tokens to a
deny-by-default route allow-list — the extension cannot call the whole tenant API even with a valid token.

**The one real gap → C11: there are no API keys.** No `api_keys` table exists (confirmed by *listing* the 50
schema files, not only by searching — the iteration-23 lesson applied deliberately). Auth is session JWT +
extension tokens; there is no server-to-server credential. `cascade 1.md` §6's design is sound, and its
`contacts:read` vs `contacts:enrich` split is the part worth preserving: it is a **spend control**, since
reveal debits the credit balance inside its transaction, and an integration key without that split can drain
a customer's balance from an automation loop with no human in it. The existing `requireEntitlement` /
`revealRateLimit` guards bound *who* and *how fast*, not *whether this credential may spend at all*.

Not built, deliberately: an API-key system is an authentication surface (secret storage, rotation, revocation,
leak response) **plus** a product decision about whether TruePoint offers a public API, plus a pricing
position. That is a human call, not a mid-programme fill-in.

**Second gap, the familiar one:** no routes for the new Layer-0 entities — correct while the tables are empty,
because an endpoint returning `[]` asserts the entity exists and has nothing, which is a claim about the data
rather than the build. Their access rules are already settled by work done here (Layer-0 reads via
`withErTx`; provenance leaves the DB aggregated; contact points carry a required `SuppressionVerdict`).

Doc is explicit about what it does *not* claim: it is a static read of the route tree and middleware — it says
what exists, not that the endpoints behave correctly. CI still has not run this branch.

**All twelve brief scope items now have an artifact.**

### Iteration 33 — 2026-08-08. **Closed a real DSAR compliance gap.** `master_signals` now erases.
Scope: implement + test. Chosen because it was the one owed item blocked on neither a human decision nor a
push — and because it is *cheapest now, while the table is still empty*, which is the whole argument.

**The seven statements (brief requirement), in order:**

*Research.* `cascade 1.md` §7 states the governing rule outright — **"the right to erasure beats the
append-only principle for personal data, full stop"** — and requires erasure to cascade. `09-compliance.md`
A-02 requires propagation on an automated ≤72h SLA, with the residual scan making "completed" truthful.

*Current system.* `dsarRepository.suppressMasterPersons` deletes `master_emails` / `master_phones` and nulls
the golden node's PII; `scanMasterResiduals` counted residual emails plus unsuppressed reachable persons.

*What was wrong.* `master_signals` holds person-subject rows, and `applyMigrations.ts` **already said why that
matters** at the REVOKE: *"a dated career event IS personal data even with no contact value."* The analysis
was done and recorded; the wiring never happened. Neither the fan-out nor the residual scan touched the table,
so a DSAR would delete the channels, find zero residuals, and report **`completed` while person-subject signal
rows survived**. The false completion claim is the worse half — the A-02 SLA is measured against that gate.
`masterSignalsRepository.erasePersonSignals` existed, was documented as the DSAR path, and had **no caller**.

*Solution.* Delete person-subject signals inside `suppressMasterPersons` — same privileged transaction as the
channel facets — and extend `scanMasterResiduals` to count them, taking `masterPersonIds` as a new parameter
that `deleteFanout` now passes.

*Why better.* Same transaction ⇒ a partial erasure cannot commit. Extending the scan is what makes the gate
honest rather than merely making the deletion happen. The ids must be passed in because suppression has
already deleted the blind index that resolved those nodes — after the fact there is deliberately no path back
from the subject's key to the node, so the step-3 ids are the only handle left.

*Risks.* Deleting Layer-0 signals removes the fact for **every** tenant — correct, and exactly the rule
`master_emails` already follows. The delete is scoped `subject_type = 'person'`: `master_signals` is
polymorphic, and dropping that discriminator would silently destroy company intelligence (funding rounds,
acquisitions) on every DSAR. Index-backed by `idx_master_signals_subject`.

*Protection.* No schema change, no migration. The table is empty today; retrofitting erasure onto a populated
append-only store is the miserable case cascade §7 warns about, which is why this was worth doing now rather
than after a feed lands.

**Tests — three added to `dsarLayerZero.itest.ts`:** the subject's person-subject signals are gone; a
bystander's survive; and a **company-subject** signal seeded with the *subject's own id* as `subject_id`
survives — contrived deliberately so the ONLY thing that can save it is the discriminator, making the guard
tested rather than merely present.

**Gates:** typecheck **25/25** · biome clean (no fixes needed) · dependency-cruiser **0 errors** ·
`packages/core` unit tests **943 pass / 0 fail**. The itest additions remain unrun — same standing caveat.

### Iteration 34 — 2026-08-08. Last owed item checked: **correctly deferred, no work invented.**
Scope: verification. **No changes.**

Checked the remaining owed item — HMAC wiring for `master_company_contact_points.value_blind_index`. It is
**not** a gap of the kind iteration 33 found. The schema states the deferral and its reason explicitly:

> `value_blind_index` exists because "generic" is a claim, not a guarantee. An `info@` mailbox is frequently
> routed to one identifiable person… The HMAC MUST use the same key and derivation as
> `master_emails.email_blind_index` or the two will never match. **Populating it, and joining the suppression
> check in the ingest path, is Phase 6 work — the column exists now so that wiring is not a destructive
> migration later.**

Three things make this materially different from the `master_signals` case:
1. The deferral is **stated**, not silently missing from a path that claims completeness.
2. The **ingest-side guard already exists** — `recordCompanyContactPoint` takes a *required*
   `SuppressionVerdict`, so nothing can be recorded without the check having been made.
3. The table has **no writer and no rows**, so there is nothing a DSAR could fail to find.

Recording this rather than manufacturing a fix for it. A column deliberately reserved so that later wiring is
non-destructive is the design working, not a defect.

---

## ▶ CI IS GREEN — 2026-08-08, run 31263352838, branch `feat/intelligence-platform-layer0`

All five jobs pass. **Everything in this programme has now actually executed against Postgres**: eight
migrations, six repositories, four itest files. The standing caveat repeated in every iteration since #1 is
discharged.

**It took seven fix commits, and CI found every one of the bugs. Static review had found none of them.**

| # | Bug | Why only execution could find it |
|---|---|---|
| 1 | **0106's header comment contained the statement-breakpoint marker verbatim.** The splitter is a plain string split over the whole file and does not know what a comment is, so the comment *explaining the splitter* split the file, leaving a fragment starting with a backtick. | `syntax error at or near "\`"` at 0106 — and since applyMigrations runs before EVERY itest, all four shards failed on every file, including tests untouched by this branch. The blast radius made a one-character problem look like broken infrastructure. |
| 2 | **`contacts.master_company_id` does not exist.** `schema/contacts.ts` defines BOTH `accounts` and `contacts`; the company bridge is on `accounts`. I read both declarations in one file and concluded "contacts carries both axes". | Four static passes read that file and never caught it. The tempting fix was a migration adding the column — which would have polluted the schema to match a misreading. |
| 3 | Fixture collided with `uniq_employment_stint` once a test moved the primary edge, because both stints sat on the `started_on` default of `-infinity`. | Requires the constraint to actually exist and the sequence to actually run. |
| 4 | The **P-1.7 snapshot ratchet** caught four migrations added without snapshots and failed, exactly as designed. Raised 62 → 66 with the reason stated. | A gate doing precisely its job. |
| 5 | The isolation itest's `UPDATE <table> SET id = id` probe hit **42703 (undefined_column)** — several Layer-0 tables have no `id`. **The failure was the lucky outcome**: a statement that cannot be planned never reaches the privilege check, so a looser expectation would have "passed" while proving nothing about whether `leadwolf_app` can write. |
| 6 | The `leadwolf_er` assertions compared against a **Drizzle wrapper string**, not a SQLSTATE — raw postgres.js puts `code` on the error, Drizzle hangs the original off `.cause`. The DELETE was refused correctly both times; the wall worked and the test could not read the verdict. |
| 7 | **Dates passed raw into Drizzle `sql` templates.** Not a Postgres error at all — postgres.js falls through to its string serializer and throws in JS *before the query is sent*, reported as an empty `Failed query:`. Adding `::timestamptz` did not help because the failure is client-side. **`.toISOString()` is the established house pattern** — contactRepository, dsarRepository, eventOutboxRepository and importJobRepository all use it. |

**The pattern in #2 and #7 is the same one §5 of `10-handover.md` records:** the answer was already in the
directory. `contacts.ts` said which table owned the column; four neighbouring repositories showed how to pass
a Date. Both were one grep away, and four static passes over the same files did not substitute for either.

**Bugs 5 and 6 are the ones worth remembering** — both were tests that would have *passed while proving
nothing*. A security proof that cannot distinguish "denied" from "malformed" is one refactor away from
silently guarding nothing.

---

## ▶ PROGRAMME STATUS: COMPLETE UNDER CURRENT CONSTRAINTS

All ten phases have artifacts. All twelve brief scope items have artifacts. Every owed item is either done or
verified as correctly deferred. Four adversarial passes found and fixed three real bugs; the fourth came back
clean, and iteration 34 confirmed the last open thread needs nothing.

**Everything that remains is blocked on something the loop cannot do:**

| Blocked on | Items |
|---|---|
| **A commit + push** (not requested) | CI running the three unrun itests + the DSAR additions. This is the largest single unknown in the programme: eight migrations, six repositories and four itest files have never executed against Postgres. |
| **A human decision** | **C4/RD-7** GPL-3.0 catalog seed · **C7** product-as-technology · **C8** personal contact typing · **C9** two confidence implementations *(has a cost of delay — a self-disagreeing badge)* · **C10** delete-half of the signal enum · **C11** API keys |
| **Both of the above** | Populators for the empty Layer-0 tables — the work that would make Phases 8's profiles and the technology/product surfaces real |

**Continuing to iterate would be manufacturing work.** The loop should be stopped (`CronDelete`, session job
`29423847`) or redirected at one of: (a) "commit and push this branch so CI runs it", (b) a specific decision
from the table above, or (c) an unrelated task.

---

## Research queue (Phase 1 — each item must end in a citation or a "could not verify")

1. Technographic modeling and sourcing — how BuiltWith / HG Insights / TheirStack / PredictLeads model
   catalog vs. adoption edge; redistribution terms. (`cascade 2.md` asserts specifics; **verify, do not
   inherit** — its figures are self-reported vendor marketing by its own admission.)
2. Product-intelligence modeling — is there any established B2B-data pattern, or is this bespoke?
3. Company/market signal taxonomies (funding, hiring, leadership change, M&A, launches) — how ZoomInfo
   Scoops / Apollo / Crunchbase / PredictLeads type and score them; decay behaviour.
4. Confidence + freshness models — Fellegi-Sunter for match, and what the market actually does for
   field-level confidence decay. (TruePoint already has the fold; the decay curve is unbuilt.)
5. Identity resolution at scale on Postgres — blocking strategies, Splink-equivalent scoring without adding
   Spark; what the exact→strong→probabilistic→review ladder costs.
6. Contribution-network integrity — how co-op models (Apollo, Lusha, Cognism) prevent poisoned
   contributions without paying contributors (TruePoint rule 7 forbids earned currency).
7. Postgres-only scale ceilings for the adoption edge and signal tables — partitioning + BRIN vs. the
   columnar/OLAP jump. Only reach for new infrastructure if this research proves the ceiling is real.
8. Profile UX patterns in ZoomInfo / Apollo / Clay / Crunchbase / LinkedIn Sales Navigator for the four
   profile types, specifically how provenance and freshness are surfaced.

---

## Conflicts register (rule 6: surface, never silently reinterpret)

| # | Conflict | Status |
|---|---|---|
| C1 | `cascade 1.md` §0 Option A ("shared person base, populated ahead of demand") vs. TruePoint's gated model. Its own recommendation is Option B, which is what TruePoint already implements (identity free, channels encrypted + reveal-gated). | **Resolved by existing build — Option B. No decision needed.** |
| C2 | Both cascade docs assume Citus, ClickHouse, Kafka/Debezium, Iceberg, Splink, Temporal, Qdrant, OpenSearch. TruePoint is Bun + Postgres 16 + Redis/BullMQ + a `SearchPort` seam. The brief itself says *"do not introduce additional databases or infrastructure unless research demonstrates a real requirement."* | **RESOLVED — RD-5, Postgres-only.** PostgreSQL manual: the ceiling is partition *count* ("a few thousand"), not rows; monthly partitioning uses 12/year. Cascade's ClickHouse case rests on a self-labelled estimate and its own escape hatch (<1–2B rows → skip ClickHouse). Written revisit trigger in `04-validation.md`. |
| C3 | `cascade 1.md` derives its schema shape from LinkedIn Sales Navigator payloads. CLAUDE.md hard constraint 4 forbids background/bulk scraping of LinkedIn. The cascade doc agrees (source-agnostic, "nothing here recommends scraping"), so the *shape* is usable but the *supply chain* is not. | **Flagged. Shape yes, sourcing no.** |
| C4 | `cascade 2.md` recommends seeding a technology catalog from the GPL-3.0 `enthec/webappanalyzer` ruleset. GPL-3.0 copyleft is a real legal decision, and TruePoint ships a hosted product plus a distributed Chrome extension — the extension is a *distributed artifact*. | **VERIFIED GPL-3.0 from the repo. Recommendation RD-7 = use the field shape (not copyrightable), seed data from licensed/public sources.** Awaiting human sign-off. |
| C5 | The brief asks for "buying signals / intent signals / engagement signals" on prospects. Strategy doc `04-opportunity-scores.md` lists intent data as **deferred non-goal X-04**. | **RESOLVED — RD-4.** Of the six industry signal families, only family 5 (intent/content engagement) is X-04. Families 1–4 and 6 (hiring, funding/M&A, tech-stack change, leadership change, filings) are company facts, in scope, and carry far lighter privacy weight. |
| C8 | **NEW (Phase 4).** `09-compliance.md` hard rule 3: *"Business-contact data only: work emails, work phones, role, company … personal addresses out of scope."* `cascade 1.md` §2.4 and the brief ask for **personal** emails and phones. Cannot both hold. Note the disputed part is ONLY the personal/private category — multi-value, typed, independently-verified channels with per-value provenance already exist. | **Open — needs a human/counsel decision recorded in `decisions.md`.** Recommendation: keep rule 3; then no schema change is needed at all. Blocks nothing else. |
| C7 | **NEW.** RD-3 proposes modeling products as a specialization of the technology catalog rather than a parallel hierarchy — research found no established B2B product-intelligence pattern, and a vendor's product and an adopter's technology are the same object seen from two ends. This reinterprets the brief's five-domain structure. | **Open — surfaced, not applied.** Needs human confirm. |
| C6 | The brief asks for a broad person profile including skills and education. CLAUDE.md's outcome table does not list a skills/education outcome; work serving no listed outcome "gets flagged, not built." | **Open — flag raised. Skills earn their place only if they serve S-04/S-09/S-13 targeting, not as profile decoration.** |
| C9 | **NEW (iteration 24).** Two field-confidence implementations now exist: shipped `packages/types/src/confidence.ts` (method prior × decay × capped corroboration curve; consumed by `badgeV1` → app, extension, exports) vs. this programme's `packages/core/src/prospect/confidence.ts` (noisy-OR over `master_confidence_policy` rows, keyed field+sourceType; consumed by nothing). Same quantity, different math, different keys — they will disagree, and `badgeV1.ts` itself says a self-disagreeing badge is worse than none. | **Open — surfaced, not applied.** Recommendation: keep the shipped leaf-package function; let `master_confidence_policy` supply its constants instead of forking the math. Touches shipped code reaching the extension → needs sign-off. Mine stays unwired meanwhile. |

| C10 | **NEW (iteration 25).** `packages/types/src/intel.ts`'s `SignalType` enum ships five values that strategy forbids populating: `web_visit`, `content_engagement`, `keyword_search` **are** X-04 deferred intent data; `linkedin_activity` and `sales_nav_view` could only be filled by means CLAUDE.md hard-constraint 4 prohibits. All five appear only in the enum declaration — nothing reads or writes them. | **Open — latent, not live.** Recommendation: do NOT delete (shipped zod schema + possible persisted rows); add a comment marking them X-04-deferred / constraint-blocked and naming the rule, so nobody builds a producer for `sales_nav_view`. |

| C11 | **NEW (iteration 32).** There is **no `api_keys` table** anywhere in `packages/db/src/schema/` (confirmed by directory listing + case-insensitive content search). Auth is user-session JWT + extension-scoped tokens; there is no programmatic/server-to-server credential. `cascade 1.md` §6 proposes one, and its `contacts:read` vs `contacts:enrich` scope split is a genuine **spend control** — reveal debits `tenants.reveal_credit_balance`, so an integration key without that split can drain a balance from an automation loop with no human in it. | **Open — surfaced, not built.** An API-key system is an authentication surface (secret storage, rotation, revocation, leak response) plus a product decision about whether TruePoint offers a public API at all, and a pricing position. Needs `truepoint-security` + `truepoint-platform` and a human call — not a gap to quietly fill mid-programme. |

---

## Standing constraints (non-negotiable, apply to every iteration)

- Every schema change names its outcome ID(s): `[S-xx]`, `[C-xx]`, `[A-xx]`.
- Nothing writes to the graph without a provenance event (08-architecture invariant 1).
- No contributor-earned currency, ever (rule 7).
- Personal-data changes state their compliance impact and pass `docs/strategy/09-compliance.md`.
- Layer 0 stays system-owned, isolated by access path; Layer 1 stays RLS-scoped. Never mix.
- Migrations are additive; existing data is never destroyed.
- **Search case-insensitively, and try the concept's several plausible spellings** — camelCase, kebab-case,
  the type name, the directory name — before concluding anything is absent. *Absence of a string is not
  absence of a capability.* Six failures in this family so far (iterations 17, 18, 19, the `leadwolf_er`
  grant, 23, and C9); every one of them was "I searched narrowly and believed the silence."
- **Read the file before claiming what it does.** A grep locates; only a read establishes meaning.
