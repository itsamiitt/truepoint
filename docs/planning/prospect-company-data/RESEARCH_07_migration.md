# RESEARCH 07 — Online-Safe Migration & Rollout to the Two-Layer Target

> **Gate:** RESEARCH · **Phase:** 7 — Migration & Rollout · **Depends on:** the shared ground-truth brief for
> this initiative, [RESEARCH_00](./RESEARCH_00_current_state.md) (the frozen BUILT/PLANNED/UNDESIGNED baseline —
> esp. the gap inventory P1–P9/U1–U4 and the degenerate `contacts.account_id` link), [RESEARCH_01](./RESEARCH_01_entity_modeling.md)
> (the golden record being built), [RESEARCH_02](./RESEARCH_02_linking_patterns.md) §3 (the `master_employment`
> edge + the masked-search→reveal→copy access path), [RESEARCH_03](./RESEARCH_03_mdm_merge.md) (per-field
> provenance materialized on write), [RESEARCH_04](./RESEARCH_04_tenancy_projection.md) §7 (the access-path
> projection boundary — **"grant-off is the actual wall"**), [RESEARCH_05](./RESEARCH_05_read_path.md) (the
> read-path cutover surface). **Ground truth:** [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md),
> [ADR-0037](../decisions/ADR-0037-bulk-match-first-resolution-and-candidate-index.md),
> [ADR-0036](../decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md), [03 §5.1/§5.2](../03-database-design.md);
> the shipped migration machinery `packages/db/src/applyMigrations.ts`, `migrate.ts`, `client.ts`,
> `rls/contacts.sql`. **Feeds:** the Phase-7 BRAINSTORM and PLAN gates. This doc **researches and documents
> only** — it proposes no migration files, finalizes no DDL, and writes/modifies no code, schema, SQL, or settings.
> External claims are marked **[VERIFIED — url]** (a source states it) vs **[INFERRED]** (reasoned from public
> behaviour / general practice, not asserted as fact). Internal claims cite `file:line` or ADR/doc section.

---

## 0. Scope, method, epistemics

This document answers one question: **how does TruePoint get from the as-built state (Layer-1 overlay only, no
`master_*` tables, person↔company = a single `contacts.account_id` FK) to the two-layer target (system-owned
Layer 0 + overlay back-refs `master_person_id`/`master_company_id`) without downtime, without a data-loss window,
without ever opening the shared graph to the customer role, and without breaking the FORCE-RLS / two-tenant
isolation gate** — at a scale of billions of golden rows and millions of users.

It studies the patterns the large data systems actually use — **expand/contract (parallel-change)**, **dual-write
+ backfill + shadow-read**, the **shadow-table** strategy, **feature-flag percentage cutover**, **billions-row
backfill orchestration**, and the **Postgres online-DDL safety** rules (lock queue, `lock_timeout`,
`CREATE INDEX CONCURRENTLY`, `NOT VALID` + `VALIDATE CONSTRAINT`) — then maps each onto TruePoint's *exact*
migration machinery and the projection boundary RESEARCH_04 fixed, and recommends a rollout. It does **not**
redesign the edge (Phase 2), the golden record (Phase 1), per-field provenance (Phase 3), the projection (Phase 4)
or the read path (Phase 5); it consumes them and sequences the *moves* that land them safely.

The migration-tooling and Postgres-DDL facts below are documented and cited verbatim. Two facts are load-bearing
and **repo-specific** (verified against the shipped code, not a blog): (a) the migration runner already
blanket-`GRANT`s every table to `leadwolf_app` plus an `ALTER DEFAULT PRIVILEGES` (`applyMigrations.ts:63-69`),
which means a naïve `master_*` migration would **auto-grant the customer role the entire shared graph**; and
(b) the Drizzle migrator runs DDL inside a transaction, which `CREATE INDEX CONCURRENTLY` cannot. Both are
work-to-do flagged below as **Implementation status** items, never as license to skip a rule.

---

## 1. The migration, stated precisely — what actually changes

The target is not one change; it is the choreographed landing of RESEARCH_00's gap inventory. The migration's job
is to move each delta through a sequence that is reversible at every step and never blocks live traffic. The
deltas, classified by migration shape:

| # | Schema/behaviour delta | Spec | Migration class | Destructive? |
|---|---|---|---|---|
| D1 | **New Layer-0 tables** `master_companies`, `master_persons`, `master_employment`, `master_emails`, `master_phones`, `source_records`, `match_links` (no `workspace_id`, no RLS) | 03 §5.1 `:390-486`; ADR-0021 | **expand** (additive create) | no |
| D2 | **Overlay back-ref columns** `contacts.master_person_id`, `accounts.master_company_id` (nullable) + partial idx | 03 §5.2 `:518,556,495,511` | **expand** (add nullable col) → **backfill** → **dual-write** | no |
| D3 | **Layer-0 population** — build golden rows + `match_links` from existing `source_imports.raw_data` / `provider_calls` evidence via ER | ADR-0015/0021; 06 §9 | **backfill** (offline, billions) | no |
| D4 | **Overlay→master attachment** — set `master_*_id` on existing overlay rows by matching them to populated Layer 0 | ADR-0021:53-65 (match-against invariant) | **backfill** (per-workspace, RLS-scoped) | no |
| D5 | **Import-path dual-write** — every new overlay row resolves + sets `master_*_id` going forward | ADR-0021:53-65; `runImport.ts:230-241` admits the gap | **cutover** (code, flag-gated) | no |
| D6 | **Read-path cutover** — "person at company with traits" served from the master-backed flattened view, not the per-workspace `account_id` join | RESEARCH_05; 03 §12 | **cutover** (shadow-read → flag → contract) | read-only |
| D7 | **New least-privilege roles** + **explicit grant-off** of `master_*` from `leadwolf_app` | RESEARCH_04 §7 rule 1; `applyMigrations.ts:74-84` REVOKE pattern | **expand** (roles/grants) | no |
| D8 | **Overlay segmentation/quality cols** (`assigned_team_id`, `visibility`, `data_quality_score`, `freshness_status`) + optional ADR-0022 visibility RLS predicate | 03 §5.2 `:503-546`; RESEARCH_00 P7 | **expand** (add nullable col) → optional RLS change | no |

The single most important structural fact for *risk*: **the contraction is almost empty.** Unlike a classic
table-split, the overlay keeps `contacts.account_id` (it is the *workspace's own* account link, demoted from
"identity truth" to "a per-workspace pointer", not removed — 03 §5.2 `:517` retains it alongside the new
`master_person_id`). Nothing the customer reads is dropped; the master graph is *added underneath*. So the only
destructive step is the eventual demotion of the *read path* (D6), which is reversible by a flag, not a `DROP`.
**This migration is overwhelmingly expand + backfill + cutover, with no hard contract — which is exactly the
profile that rolls out safely.** The headline risk is therefore not data loss; it is (i) leaking the shared graph
to `leadwolf_app` via the blanket grant (§4) and (ii) the cost/lock behaviour of two billions-row backfills (§5–§6).

```
  TODAY                                 TARGET (landed incrementally, every step reversible)
  ─────                                 ──────
  contacts ──account_id──► accounts     master_persons ─ master_employment ─ master_companies   (Layer 0, NEW)
   (RLS, FORCE)            (RLS, FORCE)        ▲                                   ▲
                                              │ master_person_id (D2)             │ master_company_id (D2)
                                          contacts ──account_id──► accounts   (Layer 1, UNCHANGED walls)
                                          (FORCE RLS retained)   (account_id RETAINED, demoted)
```

---

## 2. How large data systems run online migrations (external, verified)

Every credible large-scale migration converges on the same skeleton: **never mutate in place; run old and new in
parallel; backfill the gap offline; verify by comparison; cut over behind a flag; only then contract.** Five
documented variants fill it in.

### 2.1 Expand / contract (parallel change) — the governing pattern

The canonical zero-downtime schema-change discipline splits one logical change into independently-deployable
phases so old and new code/schema coexist and **every phase is individually reversible**: *"Add new
columns/tables alongside the existing ones … Application code writes to both (dual-write) but reads from the old
… After verifying that the new columns are fully populated … drop the old column"*
**[VERIFIED — https://www.prisma.io/dataguide/types/relational/expand-and-contract-pattern;
https://www.tim-wellhausen.de/papers/ExpandAndContract/ExpandAndContract.html]**. The pattern explicitly *"requires
the ability to run application instances with old code and new code in parallel … every single step can be rolled
back once it has been deployed"* **[VERIFIED — https://www.datasops.com/blog/database-migrations-zero-downtime]**.
This is the spine of D1→D6.

### 2.2 Stripe — the four-step dual-write/backfill/shadow-read playbook

Stripe's published playbook is the reference for *online* (live-traffic) migration of a core OLTP store, and maps
1:1 onto TruePoint's needs:

1. **Dual-write** to old and new stores to keep them in sync; new rows go to both, and *"whenever objects are
   updated, they will automatically be copied over to the new table"* (lazy migration of touched rows).
2. **Move reads** to the new store — but first verify them: Stripe uses GitHub's **Scientist** to *"run
   experiments and compare the results of two different code paths, alerting you if two expressions ever yield
   different results in production"* (shadow reads).
3. **Move writes** to new-only, *"isolat[ing] as many code paths into the smallest unit possible so we can apply
   each change carefully."*
4. **Remove old data**, and harden against regressions by making the old field *raise* on access so any missed
   code path is found loudly.

The backfill itself is run **offline against snapshots, not the production DB**: *"we make snapshots of our
databases available to our Hadoop cluster … MapReduce to quickly process our data in an offline, distributed
fashion,"* then *"re-run the job afterward to verify no objects were missed"*
**[VERIFIED — https://stripe.com/blog/online-migrations]**. The offline-snapshot detail is decisive for TruePoint
at billions of rows (§5): the heavy ER backfill must not run as an OLTP loop on the primary.

### 2.3 Shadow-table strategy — sync mechanism + cheap rollback

The shadow-table writeup generalizes the same idea and is explicit about the **sync mechanism** and **rollback**:
a parallel copy is kept current by **triggers**, **CDC**, or **dual-writes** — *"trigger-based and CDC approaches
provide stronger consistency guarantees than ad-hoc dual-writes"* — validated by *"checksums, row counts, and
deep object comparisons,"* and rolled back trivially: *"If you find a problem during verification, simply discard
the shadow table before switching over; this will not impact users. Even after a cutover … switch back to the old
one (provided you kept it intact)."* Industry uses cited: **GitHub** (gh-ost), **Shopify** (LHM gem), **Uber**
(reverse-traffic on billion-record migrations)
**[VERIFIED — https://www.infoq.com/articles/shadow-table-strategy-data-migration/]**. TruePoint's analogue of
"keep the old intact for a while" is **retaining `contacts.account_id` + the overlay read path behind the flag**
(§1) so D6 reverses instantly.

### 2.4 Feature-flag / migration-flag percentage cutover

The read- and write-path cutovers (D5/D6) are decoupled from deploys and rolled out by percentage: *"perform an
incremental migration by performing a percentage rollout to the 'complete' variation, for example increasing the
rollout by 10% every hour … if an unexpected outcome occurs, you can revert to a previous stage with few or no
consequences."* Migration flags model the explicit stages (off → dual-write → shadow-read → new-read → new-only)
**[VERIFIED — https://launchdarkly.com/docs/guides/flags/migrations;
https://launchdarkly.com/blog/guide-to-dark-launching/]**. TruePoint already ships a feature-flag surface
(`packages/db/src/schema/featureFlags.ts`, `featureFlagRepository.ts`) to host these stages per-workspace.

### 2.5 Backfilling billions of rows — batch, throttle, idempotent, ledgered

The convergent backfill discipline: *"process by DATE partition or primary-key range and limit each statement
(e.g., LIMIT 10000) in a loop until rows=0 … Run in small, chronological batches … to reduce system load and
simplify recovery,"* *"write idempotent, restart-safe code … jobs must be safe to run multiple times,"* *"chunk,
throttle, and monitor resource usage … proactively pause the backfill before having any impact on user-facing
services,"* and *"write a backfill_runs log table capturing parameters, code hash, and user"*
**[VERIFIED — https://www.getgalaxy.io/learn/glossary/database-backfill;
https://medium.com/carwow-product-engineering/backfilling-50-million-records-quickly-eaa04ba5617f;
https://www.ml4devs.com/what-is/backfilling-data/]**. Every one of these maps onto a TruePoint primitive: PK-range
batching is natural because `uuid_generate_v7()` ids are time-ordered (`applyMigrations.ts:28-35`), the job is a
BullMQ worker (idempotent on `content_hash`), the throttle/pause is queue concurrency, and the `backfill_runs`
ledger is exactly what `enrichment_jobs`/`enrichment_job_rows` already model (`enrichmentJobs.ts`).

### 2.6 Cross-pattern synthesis

| Stage | Pattern term | TruePoint move | Reversibility |
|---|---|---|---|
| Expand | add new schema, additive | D1 create `master_*`; D2/D8 add nullable cols | drop (or ignore) — instant |
| Backfill | offline, batched, idempotent | D3 ER over snapshot/lake; D4 per-workspace match | re-run; NULL-out is safe (account_id still serves) |
| Dual-write | write old + new | D5 import path sets `master_*_id` going forward | flag-off → stops writing new col |
| Shadow-read | compare old vs new (Scientist) | D6 compare account-join vs master-backed view | read-only; no state |
| Cutover | percentage flag rollout | D6 flip read path 1%→100% per workspace | flag rollback — instant |
| Contract | drop old | **mostly N/A** — account_id retained | n/a (no destructive drop in v1) |

---

## 3. Postgres online-DDL safety (verified) — the lock rules every step obeys

The single most-cited failure mode in online schema change is the **lock queue**: a DDL statement needing
`ACCESS EXCLUSIVE` (e.g. `ALTER TABLE`) that gets stuck behind a long-running transaction will itself block
*every* subsequent statement, *"including other SELECT statements that only require ACCESS SHARE locks … the
table is effectively blocked for reads and writes until the ALTER TABLE statement completes"*
**[VERIFIED — https://xata.io/blog/migrations-and-exclusive-locks]**. The mitigation is universal: *"DDL
statements in migration sessions should always set lock_timeout to an appropriate value … values of less than 2
seconds are common"* and retry with exponential backoff
**[VERIFIED — https://xata.io/blog/migrations-and-exclusive-locks; https://pgroll.com/blog/schema-changes-and-the-postgres-lock-queue]**.
TruePoint's migrator already sets `lock_timeout: 15000` + `statement_timeout: 120000` (`applyMigrations.ts:112-115`)
and runs **off the pooler on the direct host** (`migrate.ts:20-30`) — the correct base; the gap is per-statement
lock-timeout discipline + retry for the few `ALTER`s on the big `contacts` table.

The operation-by-operation safety table TruePoint's migration must follow:

| Operation (needed by) | Lock taken | Safe? | Safe form |
|---|---|---|---|
| `CREATE TABLE master_*` (D1) | none on existing tables | ✅ | additive; only touches new objects |
| `ADD COLUMN … null, no default` (D2/D8) | brief `ACCESS EXCLUSIVE` (metadata-only in PG11+) | ✅ w/ `lock_timeout` | add nullable, **no volatile default**; *"add the column without a default value, then change the default"* **[VERIFIED — https://gemdocs.org/gems/online_migrations/0.5.1/; strong_migrations]** |
| `ADD CONSTRAINT … FK` validating (D2) | `ACCESS EXCLUSIVE` + full-table scan | ❌ as one step | add `… NOT VALID` (no scan, brief lock) then `VALIDATE CONSTRAINT` (takes only `SHARE UPDATE EXCLUSIVE` → reads/writes proceed) **[VERIFIED — https://www.postgresql.org/docs/current/sql-altertable.html]** |
| `CREATE INDEX … ` (D2 partial idx) | `SHARE` (blocks writes) | ❌ on a live table | `CREATE INDEX CONCURRENTLY` (`SHARE UPDATE EXCLUSIVE`, no write lock) — **but cannot run in a transaction**; can leave an `INVALID` index on failure → monitor + `DROP`/recreate **[VERIFIED — https://medium.com/dovetail-engineering/how-to-safely-create-unique-indexes-in-postgresql-e35980e6beb5; PG docs]** |
| `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` (D8 optional) | `ACCESS EXCLUSIVE` | ⚠️ short but exclusive | apply with `lock_timeout`+retry; **policies must exist or be created in the same window** or default-deny blanks the table **[VERIFIED — https://pglocks.org/?pgcommand=ALTER+TABLE+ENABLE/DISABLE+ROW+LEVEL+SECURITY; https://www.postgresql.org/docs/current/ddl-rowsecurity.html]** |
| Backfill `UPDATE` of `master_*_id` (D4) | row locks only | ✅ batched | PK-range batches + throttle (§2.5); never one `UPDATE` over the whole table |

**Implementation status (repo-specific).** The transactional Drizzle migrator (`applyMigrations.ts:130-132`,
`migrate(db,{migrationsFolder})`) wraps each migration in a DDL transaction — so the partial indexes
`idx_contacts_master`/`idx_accounts_master` (03 §5.2 `:511,556`) **cannot** be built `CONCURRENTLY` through it,
and the `…/rls/*.sql` files run via `sql.unsafe(multiStatement)` (`applyMigrations.ts:138-143`) execute as a
single implicit transaction too — also incompatible with `CONCURRENTLY`. Building these indexes online needs a
**third execution lane**: a dedicated single-statement, non-transactional step (operator runbook or a small
out-of-band migration helper), idempotent via `CREATE INDEX CONCURRENTLY IF NOT EXISTS` + an `INVALID`-index
sweep. This is work-to-do for the PLAN gate; the rule (build big-table indexes concurrently) is non-negotiable.

---

## 4. RLS-safe migration — the grant-off wall is the real boundary (centerpiece)

RESEARCH_04 §7 fixed the projection boundary: *"`leadwolf_app` holds **no grant** on `master_*`; RLS-off is
necessary, grant-off is the actual wall."* The migration is precisely where that wall is most easily breached,
because **the shipped migration runner grants by default**:

```
applyMigrations.ts:63-69  (GRANTS, run on EVERY migrate)
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadwolf_app;   ← hits master_* too
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT … TO leadwolf_app;                       ← and every FUTURE master_* table
```

The instant `master_persons` et al. are created in the `public` schema, the very next migrate's blanket
`GRANT … ON ALL TABLES` hands `leadwolf_app` full DML on the entire shared universe, and the `ALTER DEFAULT
PRIVILEGES` auto-grants any *later*-added master table the same way. Since Layer 0 carries **no `workspace_id`**
and therefore **no RLS predicate to fail closed** (ADR-0021:81-84; RESEARCH_04 C1), a single forgotten `WHERE` in
app code reading those tables under `leadwolf_app` would be a **full-universe, cross-tenant breach** — the worst
case in §6. RLS-off here is not "less safe than the overlay"; combined with the blanket grant it is *wide open*.

**The migration must therefore do for `master_*` exactly what the runner already does for the platform-staff
tables.** The shipped precedent is right there (`applyMigrations.ts:74-84`): after the blanket grant, it
`REVOKE ALL ON platform_audit_log / platform_staff / impersonation_sessions FROM leadwolf_app` precisely because
*"the customer app role must have NO access … even if a policy were later added by mistake."* The Layer-0 tables
join that list:

```
  -- the work the migration owes (illustrative, NOT a migration file — written by the PLAN gate):
  REVOKE ALL ON master_persons, master_companies, master_employment,
                master_emails, master_phones, source_records, match_links
         FROM leadwolf_app;
  GRANT  … ON those tables TO leadwolf_er, leadwolf_search_sync, leadwolf_reveal;   -- least-privilege service roles
```

Why this is the correct primitive and not a fight against the house RLS rule: the Postgres multi-tenant community
guidance **explicitly sanctions** "global/shared tables have no `tenant_id` and no RLS"
**[VERIFIED — https://www.postgresql.org/docs/current/ddl-rowsecurity.html; https://www.techbuddies.io/2026/01/01/how-to-implement-postgresql-row-level-security-for-multi-tenant-saas/]**
(RESEARCH_04 §3.2) — TruePoint hardens it from "no RLS" to "no RLS **and** no `leadwolf_app` grant **and** reachable
only by least-privilege ER/search-sync/reveal roles." The new roles are added the same idempotent way the bootstrap
already adds `leadwolf_app`/`leadwolf_admin` (`applyMigrations.ts:37-59`): `CREATE ROLE … IF NOT EXISTS`, no table
lock, no app-role lockout.

**The overlay side needs no RLS change at all.** D2/D8 only *add nullable columns* to `contacts`/`accounts`, which
are already `ENABLE`+`FORCE ROW LEVEL SECURITY` (`rls/contacts.sql:17-18,28-29`); the existing
`*_workspace_isolation` policies (`:20-22`) keep applying unchanged, and a nullable add is metadata-only (§3). So
there is **no "add FORCE to a live table and lock out the app role"** hazard for the core migration — that hazard
only appears if D8's *optional* ADR-0022 visibility RLS predicate is added, which must (per §3) be applied with
`lock_timeout`+retry and its policy created in the same window so default-deny never blanks the overlay.

**The migration's own isolation test (new, mandatory).** RESEARCH_00 §6 / RESEARCH_04 establish a two-tenant
isolation itest gates merge. This migration adds a *second* gating assertion that is unique to Layer 0:
**under `withTenantTx` (i.e. as `leadwolf_app`), a `SELECT` against any `master_*` table must error / return zero
rows — proving the grant-off wall.** Without it, the §4 breach is invisible to CI. This is the migration-specific
correctness rule; security has final say (CLAUDE.md precedence) and it is never traded for convenience.

---

## 5. Mapping to TruePoint — the migration choreography

The dependency order is forced by one fact: **you cannot backfill `master_*_id` until the rows it points at
exist.** So the backfill is *two-stage* — build Layer 0, then attach the overlay — and the two stages have very
different scale/locality profiles.

```
 STAGE A — BUILD LAYER 0 (offline, billions, system-owned)              [D1, D3, D7]
 ─────────────────────────────────────────────────────────────
 source_imports.raw_data  +  provider_calls.response_payload  ──►  source_records  (immutable evidence)
        (existing overlay-side provenance, RESEARCH_00 §5)               │  ER (Splink-on-Spark over the
                                                                         ▼  Iceberg lake — ADR-0021/P8, NOT the OLTP primary)
                                                          master_persons / master_companies / master_employment
                                                          + match_links (clusters, review_status)   [grant-off, §4]

 STAGE B — ATTACH OVERLAY (online, per-workspace, RLS-scoped)           [D2, D4, D5]
 ─────────────────────────────────────────────────────────────
 for each workspace, withTenantTx(scope):                              ← RLS keeps the backfill in-workspace
   batch contacts/accounts by PK range (uuid v7 = time-ordered) ──► MatchPort.matchRow ──► set master_*_id
                                                                         (overlay-exact → master-candidate → none)
 import path (D5) sets master_*_id on every NEW row, flag-gated         ← dual-write closes the gap going forward
```

Concrete choices the patterns dictate, grounded in shipped code:

- **Stage A is the offline-snapshot backfill (Stripe §2.2).** ER over billions must run on the S3/Iceberg lake +
  Splink-on-Spark (ADR-0021 scale topology; RESEARCH_00 P8), **never** as an OLTP loop on Aurora. Its output is
  written to the system-owned `master_*` under the `leadwolf_er` role (§4), idempotent on `source_records.content_hash`
  (the `UNIQUE` at 03 §5.1 `:464`). Re-running is a no-op for already-resolved evidence (Stripe's "re-run to verify
  nothing missed").
- **Stage B reuses the existing match seam — no parallel matcher.** The attach step calls the *promoted*
  `masterGraphMatcher` (today a stub returning `{method:"none"}`, `masterGraphMatcher.ts:26-34`) behind the
  shipped `MatchPort` (`matchPort.ts:69-71`), which already carries `Candidate.masterPersonId` (`:32`) and keeps
  `@leadwolf/db` out via an injected finder (`:40-45`). It reuses the *one* canonical normalizer (`matchKeys.ts`)
  — ADR-0037:75-81 forbids a second one (drift). The backfill is just "run match-first over rows that already
  exist," writing `master_*_id`; the per-row outcome is logged in the `enrichment_job_rows` ledger
  (`match_method`/`match_outcome`/`match_confidence`, `enrichmentJobs.ts:142-149`) — the `backfill_runs` ledger §2.5
  asks for, already built.
- **Dual-write (D5) is the expand-phase write.** Once D2's columns exist, the import path resolves + sets
  `master_*_id` for every new overlay row — the behaviour `runImport.ts:230-241` admits is missing today. It is the
  *same* `MatchPort` call as the backfill, so backfill and live writes converge on identical logic (no skew).
  Flag-gated per-workspace so it can be dark-launched then ramped (§2.4).
- **`master_*_id` stays nullable — by design, not laziness.** ADR-0021:63-65 reserves nullability for in-flight ER
  staging. A row that does not yet resolve (Stage A not caught up, or an unmatchable domainless/keyless contact)
  carries `NULL` and **still works** because `account_id` still serves the overlay (§1). RESEARCH_00 §9 already
  rejects any plan that makes these columns `NOT NULL` on day one — the migration honours that: the invariant is an
  *import-path + backfill* guarantee, not a column constraint.
- **Read-path cutover (D6) is shadow-read → flag → soft contract.** Per RESEARCH_05, "person at company with
  traits" moves from the per-workspace `account_id` join to the master-backed flattened view. Cut it over with
  Scientist-style shadow reads (compare the two result sets in production, §2.2), gate behind a per-workspace flag,
  ramp 1%→100% (§2.4), and **keep `account_id` + the old read path live** as the instant rollback (§2.3 "keep the
  old intact"). There is no `DROP` in v1 — the contract is a flag flip, not a destructive migration.

**Implementation status.** Stage A's ER engine, the `master_*` tables, the lake/Spark topology, the promoted
matcher, and the three least-privilege roles are all **planned, unbuilt** (RESEARCH_00 P1/P5/P6/P8; the matcher is
a shipped stub). The migration machinery (Drizzle migrator + idempotent `rls/*.sql` + bootstrap + GRANTS) **is**
shipped and is the right vehicle for D1/D2/D7/D8 — with the §3 CONCURRENTLY-lane and §4 grant-off additions. The
flag surface and the `enrichment_job_rows` ledger are shipped. The gap is the build, not the method.

---

## 6. Pre-build thinking pass — scale gates & failure modes

The mandatory pass (truepoint-architecture), answered for the *migration*:

1. **Source of truth (during the move).** The overlay remains truth until D6 cuts the read path; Layer 0 becomes
   truth incrementally as Stage A populates and D4/D5 attach. Never two *authoritative* sources at once — the
   master is "candidate truth" until shadow-read proves parity, then it is read truth (RESEARCH_05; RESEARCH_03's
   "materialized on write" keeps the read path join-free).
2. **Failure modes + idempotency.** Stage A idempotent on `source_records.content_hash`; Stage B idempotent because
   deterministic keys resolve the same row to the same `master_*_id` on re-run, and the write is **fill-only / never
   clobber** a user-edited or just-revealed overlay value (survivorship user>provider, ADR-0015; U3). Backfill
   workers are BullMQ with DLQ + exponential backoff; a crashed batch resumes from the last PK cursor.
3. **Duplicate prevention.** Stage A's false-merge is bounded by Splink's calibrated thresholds (≤0.5% target) with
   low-confidence pairs routed to the `match_links.review_status` clerical queue (03 §5.1 `:481-483`) — never a
   silent merge. Stage B cannot create overlay dupes: the per-workspace partial-unique blind-index constraints
   (`contacts.ts:156-164`) still hold.
4. **Audit & change history.** Stage B's per-row outcome lands in `enrichment_job_rows`; Stage A's lineage is
   `source_records` + `match_links`; any privileged cross-tenant touch goes through `withPrivilegedTx`/`withPlatformTx`
   which write `platform_audit_log` in the same tx (`client.ts:30-35,95-111`). DSAR continuity: a tombstoned/
   suppressed person (`is_suppressed`, 03 §5.1 `:421`) must be excluded from re-match/re-attach mid-backfill.
5. **Security / isolation.** The §4 grant-off + the new "leadwolf_app cannot read master_*" itest are the gating
   controls; the overlay FORCE-RLS posture and the two-tenant itest are untouched and must stay green. This is the
   migration's non-negotiable.
6. **Scalability / 10x — what breaks first.** (a) **Stage A ER cost** dominates — must be offline lake/Spark, not
   the primary (Stripe §2.2); at 10x it is more Spark, not more Aurora. (b) **`CREATE INDEX CONCURRENTLY`** on a
   billions-row `contacts`/`master_persons` is long-running and can fail to `INVALID` — monitor + sweep (§3). (c)
   **Lock queue** on D2/D8 `ALTER`s behind a long transaction — `lock_timeout`+retry (§3). (d) **Backfill I/O on the
   primary** for Stage B `UPDATE`s — PK-range batches + throttle + pause (§2.5), run against a replica/follower where
   possible and write back in bounded batches.
7. **Observability.** Per-stage metrics: Stage A rows resolved / review-queued / false-merge rate; Stage B
   `match_outcome` distribution, rows attached, batches/sec, cursor position; D6 shadow-read **mismatch rate** (the
   go/no-go signal); index build progress + `INVALID` count; lock-timeout retry count. Runbook: pause = stop the
   queue (idempotent resume); read-path regression = flag-off (instant).
8. **Rollback.** Every step reversible: expand → drop/ignore the nullable col; backfill → `master_*_id` is NULLable
   and account_id still serves, so NULL-out is safe; dual-write → flag-off; read cutover → flag-off (account_id path
   retained). The only irreversible-ish action is *dropping* `account_id` or the old read path — **explicitly out of
   scope for v1** (no hard contract).
9. **Edge cases.** Domainless/keyless contact → no deterministic key → stays `master_*_id = NULL` (tolerated
   staging state, not an error — same as today's `account_id = NULL`); hand-edited overlay value disagreeing with
   master → don't overwrite (U3 survivorship); concurrent reveal during Stage B → reveal writes the master-derived
   value, backfill must not clobber it (fill-only); a person who DSARs mid-backfill → suppression gate halts
   re-match; a workspace mid-import during D5 ramp → flag is per-workspace so the row either dual-writes or doesn't,
   never half.
10. **Worst case.** The blanket grant (`applyMigrations.ts:63-69`) silently exposes `master_*` to `leadwolf_app` →
    a single bad query = full shared-graph cross-tenant breach. Prevented by the §4 explicit REVOKE + the grant-off
    isolation itest. This is the one failure that is catastrophic rather than merely operational, and it is the
    reason §4 is the centerpiece.

---

## 7. Recommendation

**Adopt an expand → backfill → dual-write → shadow-read → flag-cutover rollout with NO hard contract in v1, run as
two sequenced backfills (build Layer 0 offline on the lake, then attach the overlay per-workspace under RLS), and
treat the `master_*` grant-off as a first-class, tested migration step — not an afterthought.** This is the
documented industry skeleton (expand/contract §2.1; Stripe four-step §2.2; shadow-table §2.3; migration-flag
percentage cutover §2.4; billions-row batched/idempotent/ledgered backfill §2.5) specialized to TruePoint's exact
machinery, and it inherits the lowest-risk profile available because the overlay loses nothing — Layer 0 is added
*underneath* a fully retained `account_id` and read path.

The five decisions that carry the most weight:

1. **Grant-off is the migration, not a footnote (§4).** The shipped blanket `GRANT … ON ALL TABLES TO leadwolf_app`
   + `ALTER DEFAULT PRIVILEGES` makes Layer 0 *open by default*; the migration must `REVOKE ALL ON master_* FROM
   leadwolf_app` (mirroring the platform-staff REVOKE at `applyMigrations.ts:74-84`), create least-privilege
   ER/search-sync/reveal roles, and ship a gating itest asserting `leadwolf_app` cannot read `master_*`. Without
   this, RLS-off Layer 0 + blanket grant = wide open.
2. **Two-stage backfill, build-before-attach (§5).** Layer 0 must be populated (offline, lake/Spark — never the
   OLTP primary, Stripe §2.2) before the per-workspace, RLS-scoped attach can set `master_*_id`. The attach reuses
   the shipped `MatchPort` + the one canonical normalizer (ADR-0037 anti-drift), with the same logic the live
   dual-write uses so backfill and steady-state never skew.
3. **Keep `master_*_id` nullable + keep `account_id` and the old read path (§1, §6.8).** Nullability is ADR-0021's
   in-flight-staging clause, not laziness; retaining `account_id` + the overlay read path is the "keep the old
   intact" rollback (§2.3) that makes the whole migration reversible by a flag rather than a restore.
4. **Obey the Postgres lock rules per statement (§3).** `lock_timeout`+retry on every `ALTER` to the big tables;
   `ADD COLUMN` nullable with no volatile default; FK via `NOT VALID` then `VALIDATE`; partial indexes via
   `CREATE INDEX CONCURRENTLY` on a **dedicated non-transactional lane** (the migrator's DDL transaction can't host
   it) with an `INVALID`-index sweep.
5. **Cut reads over behind a per-workspace flag with shadow-read parity as the gate (§2.2/§2.4).** Ramp 1%→100%,
   watch the mismatch rate, roll back by flag — decouple the risky read switch from deploys entirely.

**What I explicitly reject:**

- **A big-bang / maintenance-window cutover.** Billions of rows + millions of users make any lock-the-tables,
   transform-in-place migration a multi-hour outage and an un-rollback-able cliff; the entire §2 literature exists
   to avoid it. Expand/backfill/cutover is mandatory.
- **Running the ER backfill (Stage A) as an OLTP loop on the primary.** It would saturate Aurora and degrade live
   customer traffic; Stripe's offline-snapshot/MapReduce model (§2.2) and ADR-0021's Spark-on-Iceberg topology
   exist precisely to keep the heavy backfill off the serving path. Stage B's overlay `UPDATE`s are batched +
   throttled + pausable, ideally off a replica.
- **Relying on the blanket grant + RLS-off and "just being careful" in app code for Layer 0.** Verified-unsafe:
   no `workspace_id` means no fail-closed predicate (ADR-0021:81-84; RESEARCH_04 C1), so one forgotten `WHERE` =
   full-universe breach. The explicit REVOKE + least-privilege roles + the grant-off itest are required, not
   optional.
- **Making `master_person_id`/`master_company_id` `NOT NULL`, or dropping `contacts.account_id`, in this
   migration.** `NOT NULL` breaks the in-flight-staging window (ADR-0021:63-65; RESEARCH_00 §9 reject); dropping
   `account_id` removes the rollback path and the workspace's own account link (it is demoted, not replaced — §1).
   Any hard contract is a *later*, separately-gated decision, not part of the landing migration.
- **A second, bulk-only matcher or normalizer for the backfill.** ADR-0037:75-81 forbids it (drift); the shipped
   `matchKeys.ts` + `MatchPort` are the single source — the backfill is the *same* call as the live path
   (RESEARCH_00 §9 reject, restated for the migration).
- **`CREATE INDEX` (non-concurrent) or a validating `ADD CONSTRAINT` on a live big table, or enabling an
   optional visibility RLS predicate without a `lock_timeout`.** Each takes a write- or access-exclusive lock that
   queues all traffic behind it (§3); the safe forms (`CONCURRENTLY`, `NOT VALID`+`VALIDATE`, timed+retried
   `ALTER`) are non-negotiable at this scale.
- **Eroding the FORCE-RLS overlay posture or the two-tenant isolation itest gate to make Layer-0 integration
   easier.** Security has final say (CLAUDE.md precedence); the isolation tests are correctness rules, never traded
   for migration convenience.

---

## 8. Open questions handed to the BRAINSTORM gate (not decided here)

1. **CONCURRENTLY execution lane.** Exact mechanism for non-transactional `CREATE INDEX CONCURRENTLY` + `INVALID`
   sweep in this repo (operator runbook vs a small out-of-band helper distinct from the Drizzle migrator and the
   `rls/*.sql` lane) — §3 Implementation status.
2. **Least-privilege role split.** Whether ER, search-sync, and reveal are three roles or fewer, and their exact
   per-table grants on `master_*` (write for ER, read for search-sync, decrypt-channel for reveal) — extends §4 and
   RESEARCH_04 open-Q 3.
3. **Backfill orchestration & throttle policy.** Per-workspace vs global batching for Stage B, the concurrency/rate
   caps, the pause/resume control, and whether Stage B reads off a replica — owned by ADR-0036 bulk-job model +
   ADR-0024 SLOs.
4. **Shadow-read scope & parity threshold.** Which read queries get Scientist-style comparison, sampling rate, and
   the mismatch threshold that gates the D6 ramp — RESEARCH_05-adjacent.
5. **Dual-write ordering & latency budget.** Whether D5 attaches `master_*_id` synchronously on the import thread
   (bounded MatchPort call + cache) or async via the outbox — the import-path latency SLO decides; flag-gated either
   way.
6. **Co-op CONTRIBUTE-TO back-pressure during migration.** If a workspace's overlay edits begin feeding
   `source_records` (ADR-0021:60-62) while the backfill runs, the write-back isolation (a workspace must not learn
   which other workspace contributed) interacts with Stage A — RESEARCH_04 open-Q 6, flagged not decided.

---

### Sources (external, verified)

- Expand/contract pattern — Prisma Data Guide: https://www.prisma.io/dataguide/types/relational/expand-and-contract-pattern ; Tim Wellhausen: https://www.tim-wellhausen.de/papers/ExpandAndContract/ExpandAndContract.html ; datasops: https://www.datasops.com/blog/database-migrations-zero-downtime
- Stripe online migrations (four-step, MapReduce backfill, Scientist shadow reads): https://stripe.com/blog/online-migrations
- Shadow-table strategy (triggers/CDC/dual-write, gh-ost/LHM/Uber, rollback): https://www.infoq.com/articles/shadow-table-strategy-data-migration/
- Migration flags / dark launch / percentage cutover — LaunchDarkly: https://launchdarkly.com/docs/guides/flags/migrations ; https://launchdarkly.com/blog/guide-to-dark-launching/
- Billions-row backfill (batch/throttle/idempotent/ledger): https://www.getgalaxy.io/learn/glossary/database-backfill ; https://medium.com/carwow-product-engineering/backfilling-50-million-records-quickly-eaa04ba5617f ; https://www.ml4devs.com/what-is/backfilling-data/
- Postgres lock queue + lock_timeout: https://xata.io/blog/migrations-and-exclusive-locks ; https://pgroll.com/blog/schema-changes-and-the-postgres-lock-queue
- Safe DDL forms (NOT VALID+VALIDATE, CONCURRENTLY, add-column-no-default) — PG docs: https://www.postgresql.org/docs/current/sql-altertable.html ; strong/online_migrations: https://gemdocs.org/gems/online_migrations/0.5.1/ ; Dovetail: https://medium.com/dovetail-engineering/how-to-safely-create-unique-indexes-in-postgresql-e35980e6beb5
- ENABLE ROW LEVEL SECURITY lock level: https://pglocks.org/?pgcommand=ALTER+TABLE+ENABLE/DISABLE+ROW+LEVEL+SECURITY ; PG RLS docs: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Global/shared tables get no RLS (multi-tenant guidance): https://www.techbuddies.io/2026/01/01/how-to-implement-postgresql-row-level-security-for-multi-tenant-saas/
