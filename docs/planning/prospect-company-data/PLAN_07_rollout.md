# Phase 7 — Migration & Rollout: PLAN

> **Gate: PLAN.** Phase 7 of the prospect↔company data initiative — **landing the two-layer target on a live,
> billions-row, multi-tenant system without downtime, without a data-loss window, and without ever opening the
> shared graph to the customer role.** This gate freezes: the ordered **expand → backfill → dual-write →
> shadow-read → per-workspace flag-cutover** sequence (D1–D8), the **grant-off wall** as the first, tested
> migration step (the centerpiece), the new **least-privilege roles**, the per-workspace **`migration_cutover_state`**
> control table + the shadow-read parity gate, the **CONCURRENTLY execution lane**, the dual-write seam, the
> Stage-A-offline / Stage-B-per-workspace choreography, the RLS-safety posture, the scale-gate, failure modes,
> and the open questions. **Converts:** `BRAINSTORM_07_rollout_options.md §6` — the DECISION *"Adopt Option D — a
> phase-gated spine (B's discipline) with a per-workspace, shadow-read-gated read cutover (C's granularity), no
> hard contract: build globally and offline; flip per-workspace, on proof, reversibly"* — and
> `RESEARCH_07_migration.md §7` — the RECOMMENDATION *"an expand → backfill → dual-write → shadow-read →
> flag-cutover rollout with NO hard contract in v1, run as two sequenced backfills (build Layer 0 offline on the
> lake, then attach the overlay per-workspace under RLS), treating the `master_*` grant-off as a first-class,
> tested migration step."* It answers the seven `BRAINSTORM_07 §6` open questions + the six `RESEARCH_07 §8`
> questions inline and re-lists them in **Open questions**. **Depends on / cites:** `PLAN_00_constraints_and_scope.md`
> (C1–C10 + the §8 checklist), `PLAN_01_canonical_entities.md` (the `master_*` tables being built), `PLAN_02_affiliation_edge.md`
> (the SCD2 edge + `current_company_id` the read cutover serves + the `MatchPort` attach), `PLAN_03_merge_and_provenance.md`
> (the materialized OV + `search_outbox` the shadow-read compares), `PLAN_04_tenant_owner_views.md` (the grant-off
> wall, `leadwolf_reveal`, the two-only Layer-0 paths), `PLAN_05_search_and_cache.md` (the master-backed read
> surface being cut over + the blue/green reindex), `PLAN_06_lifecycle.md` (the post-cutover freshness machine).
> Ground truth: ADR-0021/0037/0036/0015/0007, `03-database-design.md §5.1/§5.2`, and the **shipped** migration
> machinery `applyMigrations.ts:28-146`, `migrate.ts:20-30`, `client.ts:30-68,95-111`, `rls/contacts.sql:17-48`,
> `schema/featureFlags.ts:15-44`, `core/src/enrichment/bulk/matchPort.ts`, `bulk/masterGraphMatcher.ts:26-34`,
> `core/src/import/runImport.ts:230-241`, `enrichmentJobs.ts:41-160`. **No code, schema, SQL, or settings are
> modified by this gate — only this file is written; the DDL/role/sequence below is the Phase-7 freeze, a
> *target rollout*, not an applied migration.**

---

## 0. Lineage — what this PLAN converts and freezes

`RESEARCH_07` fixed the migration's **shape** — overwhelmingly *expand + backfill + cutover with NO hard
contract* (the overlay keeps `contacts.account_id` and the old read path; Layer 0 is added *underneath*,
`RESEARCH_07 §1`), a *two-stage build-before-attach* backfill (offline Stage A on the lake/Spark → per-workspace
Stage B attach, `§5`), the *Postgres online-DDL lock rules* (`§3`), and the *centerpiece security control* — the
**grant-off wall** (`REVOKE ALL ON master_* FROM leadwolf_app` + least-privilege roles + a gating itest, `§4`),
because the shipped runner blanket-`GRANT`s every table to the customer role (`applyMigrations.ts:63-69`).
`BRAINSTORM_07` took that as settled and decided the one open thing — the **rollout axis**: build globally and
offline (B's phase discipline for the cheap shared steps), flip the one risky customer-visible step (the D6 read
cutover) **per-workspace, gated by that workspace's own shadow-read parity** (C's containment + B's proof), no
hard contract (Option D, rejecting big-bang A, global-flip B-alone, and flag-without-proof C-alone).

This PLAN **paves that road**. It does five things:

1. **Freezes the security-first migration objects** (Target schema) — the grant-off `REVOKE` + the
   least-privilege roles (`leadwolf_er`/`leadwolf_search_sync`/`leadwolf_shadow`, joining the
   `leadwolf_reveal`/`leadwolf_verify`/`leadwolf_sweep` of `PLAN_04`/`PLAN_06`), the per-workspace
   `migration_cutover_state` control table + parity ledger, and the CONCURRENTLY execution lane.
2. **Freezes the ordered step sequence** (§1) — D1→D8 as independently-deployable, individually-reversible moves,
   each tagged with its migration class, RLS-safety note, flag, rollback, and scale-gate.
3. **Freezes the dual-write + shadow-read mechanics** (§2) — the one `MatchPort` attach (backfill ≡ live, no
   skew), the per-workspace parity gate that distinguishes legitimate `account_id`↔`master_employment` curation
   divergence from a wrong answer, and the 1%→100% population ramp.
4. **Freezes the RLS posture** (RLS policy implications) — grant-off as *the* wall, the new gating itest, the
   no-FORCE-lockout guarantee, and the rule that the shadow reader runs under a least-privilege role, never
   `leadwolf_app`.
5. **Freezes the boundaries** — scale-gate (Stage-A offline ER, Stage-B throttle, shadow double-cost,
   CONCURRENTLY), failure modes, and the residual open questions with owners named.

> **Trace, explicit.** Every choice names the `BRAINSTORM_07 §6` DECISION clause (or the `§3` HC adjudication /
> `§4` challenge-to-A) and the `RESEARCH_07 §7` recommendation point it crystallizes, and cites the locked
> constraints (`PLAN_00` C1/C3/C4/C7/C8) it obeys. Phase 7 **builds** the path that lands C7 (the projection
> boundary) and the rest of the initiative without ever relaxing C8 (FORCE-RLS overlay + the isolation itest);
> **security has final say** (CLAUDE.md precedence). The migration is *additive and reversible by construction*:
> Layer 0 is added under a fully-retained `account_id` and read path — there is **no hard contract in v1**.

---

## Target schema

Phase 7 introduces **no customer entity** — its artifacts are (a) the grant-off `REVOKE` + new least-privilege
roles, (b) one system-owned per-workspace control table + a parity ledger, and (c) a non-transactional index lane.
The backfill ledger is the **shipped** `enrichment_jobs`/`chunks`/`rows` (`enrichmentJobs.ts:41-160`) — the
`backfill_runs` ledger `RESEARCH_07 §2.5` asks for, already built; no new table.

### 0.1 The grant-off wall + least-privilege roles (the FIRST migration step — `RESEARCH_07 §4`; `BRAINSTORM_07 §6`)

The single most important DDL in the whole initiative. The instant `master_*` are created in `public`, the **next**
migrate's blanket `GRANT … ON ALL TABLES IN SCHEMA public TO leadwolf_app` + `ALTER DEFAULT PRIVILEGES`
(`applyMigrations.ts:63-69`) hands the customer role full DML on the entire shared universe — and Layer 0 has **no
`workspace_id`**, so **no fail-closed RLS predicate** (C7; ADR-0021:81-84). One forgotten `WHERE` would be a
full-universe cross-tenant breach. The migration mirrors the shipped platform-staff REVOKE precedent
(`applyMigrations.ts:74-84`):

```sql
-- STEP 0 (runs in the SAME migrate that first creates any master_* table, AFTER the blanket GRANT):
-- least-privilege service roles (idempotent CREATE ROLE … the bootstrap idiom, applyMigrations.ts:37-59; no table lock)
CREATE ROLE leadwolf_er        NOLOGIN;   -- ER pipeline: writes golden + match_links from source_records
CREATE ROLE leadwolf_search_sync NOLOGIN; -- drains search_outbox → OpenSearch/ClickHouse/Typesense (PLAN_05 §2.6)
CREATE ROLE leadwolf_shadow    NOLOGIN;   -- the D6 shadow-reader of the master-backed view (NEW; §2.2)
-- (leadwolf_reveal — PLAN_04 §0.4; leadwolf_verify/leadwolf_sweep — PLAN_06 §RLS — added by their phases)

-- THE WALL: revoke the blanket grant from the customer role for every Layer-0 table (+ future ones).
REVOKE ALL ON master_persons, master_companies, master_employment, master_emails, master_phones,
              source_records, match_links
       FROM leadwolf_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM leadwolf_app;  -- belt: re-asserted per migrate

-- least-privilege grants (write for ER, read for search-sync/shadow, channel-decrypt for reveal):
GRANT SELECT, INSERT, UPDATE ON master_persons, master_companies, master_employment, source_records, match_links TO leadwolf_er;
GRANT SELECT ON master_persons, master_companies, master_employment TO leadwolf_search_sync, leadwolf_shadow;
GRANT SELECT ON master_emails, master_phones TO leadwolf_reveal;   -- ONLY the reveal tx decrypts a channel (PLAN_04 §0.4)
```

`leadwolf_app` ends with **no privilege** on any `master_*` (C7). The customer reaches Layer 0 by exactly two
paths — masked search + paid reveal (`PLAN_04 §RLS-2`) — never a direct grant. This `REVOKE` block is **re-run on
every migrate** (idempotent), so a later-added master table cannot silently re-open via the blanket `GRANT`.

### 0.2 `migration_cutover_state` — the per-workspace rollout state machine (NEW; system-owned) — DDL freeze

Option D's per-workspace flip needs a finer unit than the shipped **per-tenant** `tenant_feature_flags`
(`featureFlags.ts:29-44`; the granularity gap, `BRAINSTORM_07 §5`, OQ1). This system-owned control table is the
state machine the read-router consults (cached) to decide which read path a workspace gets, and which the
orchestrator advances.

```sql
CREATE TABLE migration_cutover_state (                    -- system-owned operational control; NO RLS (operator/orchestrator only)
  workspace_id      uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id)    ON DELETE CASCADE,
  stage             varchar(16) NOT NULL DEFAULT 'off'
                      CHECK (stage IN ('off','attaching','dual_write','shadow','cutover')),  -- the per-workspace ramp
  stage_a_coverage  numeric(4,3) NOT NULL DEFAULT 0,        -- fraction of this ws's universe present in Layer 0 (HC5 readiness, OQ4)
  shadow_samples    bigint NOT NULL DEFAULT 0,              -- # compared reads in the current window
  shadow_mismatch   bigint NOT NULL DEFAULT 0,              -- # divergences NOT explained by legitimate curation (§2.2)
  parity_rate       numeric(5,4),                           -- 1 − (unexplained_mismatch / samples); the go/no-go gate (OQ2)
  cutover_at        timestamptz,                            -- when stage flipped to 'cutover'
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cutover_stage ON migration_cutover_state (stage);   -- the orchestrator's ramp cohort scan

-- The shadow-read parity sample ledger (range-partition by sampled_at/month, like provider_calls 03:735).
-- Written by the leadwolf_shadow reader; read by the orchestrator to roll up parity_rate per workspace.
CREATE TABLE migration_shadow_samples (                    -- system-owned; NO leadwolf_app grant
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  workspace_id  uuid NOT NULL,
  query_class   varchar(24) NOT NULL,                      -- 'person_at_company' | 'detail' | 'account_facet' (the compared reads, OQ2)
  diverged      boolean NOT NULL,
  explained     boolean NOT NULL,                          -- TRUE = account_id↔master_employment legitimate curation divergence (HC4)
  sampled_at    timestamptz NOT NULL DEFAULT now()
);
```

- **`stage` is the read-router's switch (per workspace).** `off`/`attaching`/`dual_write`/`shadow` → serve the
  old `account_id`-join read; `cutover` → serve the `PLAN_05` master-backed flattened read. The router reads this
  (Redis-cached, short TTL) — never an OLTP lookup per request. **`account_id` + the old path stay live at every
  stage** (the instant rollback: set `stage` back, `RESEARCH_07 §1`, `BRAINSTORM_07 §6`).
- **`parity_rate` is the gate** (OQ2): a workspace advances `shadow → cutover` only when *its own* `parity_rate`
  crosses threshold over a minimum `shadow_samples`. `explained=TRUE` divergences (the person changed jobs and the
  overlay `account_id` is legitimately stale; the workspace filed under a parent account — HC4) do **not** count
  against parity; only *unexplained* mismatches do — the distinction an aggregate global flip (A/B) cannot tune
  per tenant (`BRAINSTORM_07 §3 HC4`, the sharpest argument for D).

### 0.3 The CONCURRENTLY execution lane (`RESEARCH_07 §3` Implementation status; OQ-research-1)

The shipped Drizzle migrator wraps each migration in a **DDL transaction** (`applyMigrations.ts:130-132`) and the
`rls/*.sql` files run as one implicit tx (`:138-143`) — so the partial indexes `idx_contacts_master`/
`idx_accounts_master` (`03:511,556`) and any big-table index **cannot** be built `CONCURRENTLY` through it
(`CREATE INDEX CONCURRENTLY` forbids a transaction). Phase 7 adds a **third execution lane**: a single-statement,
**non-transactional** migration helper (an operator runbook step or a tiny out-of-band runner distinct from the
Drizzle migrator and the `rls/*.sql` lane), each statement `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` + an
`INVALID`-index sweep (`SELECT … FROM pg_index WHERE NOT indisvalid` → `DROP`/recreate). The Drizzle migrator still
owns the additive `CREATE TABLE`/`ADD COLUMN`/role/grant DDL (transactional, fine); only the big-table indexes go
to the concurrent lane.

### 0.4 The ordered expand → backfill → dual-write → cutover sequence (D1–D8; the freeze)

Each step is independently deployable and individually reversible (the expand/contract guarantee, `RESEARCH_07
§2.1`). Class ∈ expand | backfill | dual-write | cutover; **no `contract`** (account_id retained — §0 / HC3).

| # | Step | Class | Axis | RLS-safety | Flag / gate | Rollback |
|---|---|---|---|---|---|---|
| **S0** | **Grant-off REVOKE + least-privilege roles** (§0.1) | expand | global | *the* wall: `leadwolf_app` loses all `master_*` grant; gating itest (`§RLS-3`) | ships **with** the first `master_*` create | drop roles; tables stay unreadable (fail-safe) |
| **S1** | Create `master_*`, `source_records`, `match_links` (`PLAN_01`) | expand | global | no `workspace_id`, no RLS, no `leadwolf_app` grant (S0) | — | `DROP TABLE` (additive, untouched overlay) |
| **S2** | `ADD COLUMN contacts.master_person_id / accounts.master_company_id` (nullable) (`03:518,495`) | expand | global | nullable add = metadata-only; overlay FORCE-RLS **unchanged** (`rls/contacts.sql:17-18`) | — | `DROP COLUMN` (account_id still serves) |
| **S2i** | Partial indexes `idx_*_master` via the **CONCURRENTLY lane** (§0.3) | expand | global | `SHARE UPDATE EXCLUSIVE`, no write lock | — | `DROP INDEX CONCURRENTLY`; `INVALID` sweep |
| **S3** | **Stage A**: offline ER build of Layer 0 on the lake/Spark (`RESEARCH_07 §5`) | backfill | **global, offline** | runs as `leadwolf_er`, **never** the OLTP primary; idempotent on `source_records.content_hash` (`03:464`) | per-cohort coverage metric → `stage_a_coverage` | re-runnable; output is additive golden rows |
| **S4** | **Stage B**: per-workspace attach — `MatchPort.matchRow` sets `master_*_id` (`PLAN_02`) | backfill | **per-workspace, RLS** | `withTenantTx`; PK-range batches + throttle; **free match, never the reveal seam** (HC2) | per-ws; `stage='attaching'` | `master_*_id` is NULL-able → NULL-out safe |
| **S5** | **Dual-write**: `runImport` resolves + sets `master_*_id` on every new row (`runImport.ts:230-241` gap) | dual-write | global (per-ws flag) | same `MatchPort` as S4 → no skew; per-ws `stage='dual_write'` | per-ws stage flag | flag-off → stops writing the new col |
| **S6** | **Shadow-read**: `leadwolf_shadow` compares `account_id`-join vs master-backed view per read (§2.2) | cutover prep | **per-workspace** | read-only; runs as `leadwolf_shadow` (master `SELECT`), **never** `leadwolf_app` (HC1) | `stage='shadow'`; writes `migration_shadow_samples` | read-only; no state to revert |
| **S7** | **Read cutover**: flip the read path to master-backed, gated by `parity_rate`, ramped 1%→100% | cutover | **per-workspace** | overlay walls unchanged; the index is masked + access-path-isolated (`PLAN_05 §RLS`) | `parity_rate ≥ θ` over min samples → `stage='cutover'` | set `stage` back → instant per-tenant rollback |
| **S8** | (optional, **later, separately gated**) demote/retire the old read path | contract | — | — | **explicitly out of scope for v1** (`BRAINSTORM_07 §6`) | n/a |
| **D8** | Overlay segmentation/quality cols + optional ADR-0022 visibility RLS (`03:540-546`) | expand (+ opt RLS) | global | nullable add safe; the **only** lockout risk is the optional visibility policy — `lock_timeout`+retry, policy created in the **same window** (`RESEARCH_07 §3`) | — | drop col; the visibility RLS is the one care-step |

---

## 2. The dual-write + shadow-read mechanics (the per-workspace parity gate)

### 2.1 One `MatchPort` for backfill **and** live write — no skew (`RESEARCH_07 §5`; ADR-0037:75-81)

Stage B's attach (S4) and the import dual-write (S5) are **the same call**: `MatchPort.matchRow` over the **one**
canonical `matchKeys.ts` normalizer (`matchPort.ts:69-71`; `Candidate.masterPersonId`, `:32`), short-circuiting
overlay-exact → master-candidate → none, writing **only** `master_person_id`/`master_company_id` and **never**
touching `is_revealed`/`revealed_by_user_id`/the credit pool (the free-match-not-reveal guard, HC2; the attach is
`matched_internal`, **0 credits**, `masterGraphMatcher.ts:15`). Because backfill and steady-state are one seam,
the two paths **cannot drift** — collapsing the only true virtue big-bang claimed (`BRAINSTORM_07 §4`). Today the
master matcher is a **shipped stub** returning `none` (`masterGraphMatcher.ts:26-34`), so matches degrade
gracefully to overlay+provider until the candidate index lands — never an error (HC5).

### 2.2 The per-workspace shadow-read parity gate (the Option-D crux; OQ2)

The shadow-read (S6) runs both reads in production and records divergence — **per workspace**:

```
  leadwolf_shadow (read-only; master SELECT; NEVER leadwolf_app — HC1):
    for a sampled read on a 'shadow'-stage workspace:
      old = account_id-join company (contacts.account_id → accounts)            -- the live answer today
      new = master-backed view (contacts.master_person_id → current_company_id → master_companies, PLAN_02 §2.2)
      diverged  = (old.company ≠ new.company)
      explained = diverged AND (  person changed jobs (master_employment closed edge ⇒ account_id is stale)
                                OR account_id files a parent/holding account (curation)
                                OR overlay deduped two domains the master keeps distinct  )   -- HC4 legitimate divergence
      INSERT migration_shadow_samples(ws, query_class, diverged, explained)
    -- orchestrator rolls up:  parity_rate = 1 − (count(diverged AND NOT explained) / count(*))  over the window
```

A workspace flips `shadow → cutover` only when **its own** `parity_rate ≥ θ` over a minimum sample (OQ2) — so the
messy-account tenants B-alone would average away (`BRAINSTORM_07 §3 HC4`) are *measured and tuned per tenant*
before they flip, and a regression's blast radius is **one tenant** (flag `stage` back, HC3). **Precedence at read
post-cutover** (OQ3): the read surfaces the master-derived current employer as the **golden facet** and keeps
`account_id` as the **workspace's own pointer** — survivorship protects human curation (`account_id` is *not*
silently overwritten, ADR-0015); they are two facets, not a swap. The population ramps 1%→100% across workspaces
(the LaunchDarkly percentage model, `RESEARCH_07 §2.4`).

### 2.3 The two-stage choreography (build-before-attach; `RESEARCH_07 §5`)

```
  STAGE A — global, offline, system-owned (S1+S3+S0)            STAGE B — per-workspace, online, RLS-scoped (S2+S4+S5)
  ──────────────────────────────────────────                    ──────────────────────────────────────────────
  source_imports.raw_data + provider_calls  ──► source_records   for each ws, withTenantTx(scope):  [stage machine §0.2]
       (existing overlay provenance)            │ ER (Splink-on-      S4 attach: MatchPort → set master_*_id  (0 credits, HC2)
                                                 ▼ Spark/Iceberg —    S5 dual-write: every NEW import row sets master_*_id
  master_persons ─ master_employment ─ master_companies  + match_links   S6 shadow: leadwolf_shadow compares old vs new (per-ws parity)
       [grant-off: REVOKE ALL FROM leadwolf_app — S0, the wall]          S7 cutover: parity ≥ θ → flip read to master-backed (ramped)
```

The dependency is forced: **you cannot set `master_*_id` until the rows it points at exist** — so global offline
build (A) precedes per-workspace attach (B). Stage A is the offline-snapshot backfill (Stripe's MapReduce model,
`RESEARCH_07 §2.2`) — **never** an OLTP loop on Aurora; Stage B is PK-range-batched (`uuid_generate_v7()` is
time-ordered, `applyMigrations.ts:28-35`), throttled, pausable, ideally off a replica, ledgered in
`enrichment_job_rows` (`match_method`/`match_outcome`/`match_confidence`, `enrichmentJobs.ts:142-149`).

---

## RLS policy implications

Two isolation regimes the migration must keep separate **throughout the transition** (C7/C8; the postures
`PLAN_04 §RLS` froze). The migration is precisely where the wall is most easily breached.

1. **The grant-off wall IS the migration (S0; C7).** The shipped blanket `GRANT … ON ALL TABLES TO leadwolf_app`
   + `ALTER DEFAULT PRIVILEGES` (`applyMigrations.ts:63-69`) makes Layer 0 *open by default* the instant the
   tables exist; the migration's first act is `REVOKE ALL ON master_* FROM leadwolf_app` + the least-privilege
   roles (§0.1), re-asserted every migrate. Layer 0 has **no `workspace_id`** ⇒ no fail-closed predicate ⇒
   grant-off, not RLS, is the wall (`RESEARCH_07 §4`; `PLAN_04 §RLS-2`).
2. **The overlay needs NO RLS change for the core path (C8).** S2/D8 only **add nullable columns** to
   `contacts`/`accounts`, already `ENABLE`+`FORCE ROW LEVEL SECURITY` (`rls/contacts.sql:17-18,28-29`); a nullable
   add is metadata-only and the `*_workspace_isolation` policies keep applying unchanged — **there is no
   transitional window where workspace isolation weakens** (the walls are untouched start to finish). The *only*
   lockout hazard is D8's **optional** ADR-0022 visibility RLS predicate: adding a policy/`FORCE` on a live table
   takes `ACCESS EXCLUSIVE`, so it runs with `lock_timeout`+retry and its policy is **created in the same window**
   or default-deny blanks the overlay (`RESEARCH_07 §3`).
3. **The migration's own gating itest (NEW, mandatory; blocks merge).** Beyond the shipped two-tenant isolation
   itest (`PLAN_00 §8`/C8, which must stay green), Phase 7 adds the Layer-0-specific assertion: **under
   `withTenantTx` (i.e. as `leadwolf_app`), a `SELECT` against any `master_*` table ERRORS (privilege denied)** —
   proving grant-off, not row-filtering, is the wall (`PLAN_04 §RLS-3.4`; `RESEARCH_07 §4`). Without it, the S0
   breach is invisible to CI.
4. **The shadow reader runs under a least-privilege role in APPLICATION code (HC1; the subtle one).** The S6
   shadow-read is a **new app read path that touches `master_*`** — it must run as `leadwolf_shadow` (master
   `SELECT`), **never** `leadwolf_app`/`withTenantTx`. Wire it under `withTenantTx` and it either fails grant-off
   (correct, but breaks the feature) or, if "fixed" by a grant, **breaches the wall**. So grant-off is enforced in
   app code for the shadow reader, not only in the migration grants — and the gating itest (§3) is extended to
   assert the shadow path uses `leadwolf_shadow`.
5. **`migration_cutover_state` / `migration_shadow_samples` are system-owned** — no `workspace_id`-as-RLS-key, no
   `GRANT … TO leadwolf_app`; written by the orchestrator + `leadwolf_shadow`, read by the read-router via a cached
   system lookup. They carry operational state (a stage, a parity rate), **never customer PII**.
6. **DSAR during the migration (`BRAINSTORM_07 §5`).** Erasure stays the audited platform fan-out keyed on
   `master_emails.email_blind_index` (`withPrivilegedTx`, `client.ts:30-35`; `PLAN_04 §RLS-3.5`). The migration
   adds one rule: a **suppressed/tombstoned subject is excluded from re-match/re-attach mid-backfill** — Stage B
   must not resurrect a `master_*_id` onto a row being erased (`is_suppressed`, `03:421`), and Stage A must not
   re-cluster a suppressed identity. The cascade is unchanged.

---

## Scale-gate analysis

Scale target: millions of users, **billions** of golden rows, two billions-row backfills (CLAUDE.md; C9). N+1 and
unbounded fan-out are failures. The migration's headline risk is **not data loss** (the migration is additive); it
is the cost/lock behaviour of the backfills + the grant breach. *What breaks first at 10×, and the fix:*

| Rank | What breaks first at 10× | Why | Fix (this PLAN) |
|---|---|---|---|
| **1** | **Stage-A ER cost** | resolving billions of `source_records` is the heaviest step; as an OLTP loop it saturates Aurora and degrades live traffic | **Offline on the lake/Spark/Iceberg, never the OLTP primary** (Stripe's offline-snapshot model, `RESEARCH_07 §2.2`; ADR-0021 topology); at 10× it is more Spark, not more Aurora; idempotent on `content_hash`, re-runnable to verify nothing missed (S3). |
| **2** | **`CREATE INDEX` on a billions-row table** | a non-concurrent index takes a write lock that queues all traffic; even CONCURRENTLY can fail to `INVALID` | The **non-transactional CONCURRENTLY lane** (§0.3) — `CREATE INDEX CONCURRENTLY IF NOT EXISTS` + an `INVALID`-index sweep + monitor; out of the Drizzle DDL transaction (S2i). |
| **3** | **Stage-B backfill I/O on the primary** | one big `UPDATE master_*_id` over the whole `contacts` table locks + floods | **PK-range batches** (`uuid v7` time-ordered) + throttle + pause-before-impact + DLQ resume from the cursor (`RESEARCH_07 §2.5`), ideally off a replica, ledgered in `enrichment_job_rows` (S4). |
| **4** | **Lock queue on the `ALTER`s** | an `ADD COLUMN`/visibility-policy `ALTER` stuck behind a long tx blocks every read of the big table | **`lock_timeout` (≤ a few s) + retry with backoff** on every big-table `ALTER` (the migrator already sets `lock_timeout:15000`, `applyMigrations.ts:112-115` — tighten per-statement); nullable add = metadata-only; FK via `NOT VALID` then `VALIDATE` (`RESEARCH_07 §3`). |
| **5** | **Shadow-read doubles read cost** | running both the old and new read for every sampled request during S6 | **Sample, don't shadow-everything** — a tunable per-workspace sample rate writes `migration_shadow_samples`; the comparison window closes once `parity_rate` stabilizes (S6/OQ2); off the primary where possible. |
| **6** | **The Stage-A catch-up delta** | the world mutates under the long offline build → the snapshot is stale at attach | **Continuous re-attach sweep** + a final reconciliation pass before each workspace's flip (the staleness window big-bang ignores, `BRAINSTORM_07 §4.2`; OQ6); dual-write (S5) closes the gap for *new* rows going forward. |

**Verdict.** Every first-breakage is a documented bound applied now (offline ER, CONCURRENTLY lane, batched
throttled backfill, `lock_timeout`+retry, sampled shadow, catch-up sweep). The migration is **overwhelmingly
expand + backfill + cutover with no hard contract**, which is the lowest-risk profile available — the overlay
loses nothing, Layer 0 is added *underneath* a fully-retained `account_id` and read path, so the only "destructive"
step (the eventual read demotion, S8) is **out of scope for v1** and reversible by a flag, never a `DROP`.

---

## Failure modes

| # | Failure | Cause | Mitigation |
|---|---|---|---|
| F1 | **The blanket grant silently exposes `master_*` to `leadwolf_app`** → full-universe cross-tenant breach (the worst case) | the shipped `GRANT … ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES` auto-grant Layer 0; no `workspace_id` ⇒ no fail-closed predicate | **S0 `REVOKE ALL ON master_* FROM leadwolf_app`** re-asserted every migrate + least-privilege roles + the **gating itest** (`leadwolf_app` `SELECT` on `master_*` errors). The one catastrophic (not merely operational) failure; §RLS-1 is its centerpiece. |
| F2 | **Big-bang stale-snapshot cutover** | flipping all tenants on an offline diff after a long build | **Rejected** (`BRAINSTORM_07 §6 reject A`): per-workspace shadow-gated ramp; `account_id` + old path retained; no global cliff. |
| F3 | **Aggregate parity averages away a per-tenant outlier** that breaks at flip | a global mismatch rate hides a messy-account workspace (HC4) | **Per-workspace** `parity_rate` gate (§2.2) — each ws flips on *its own* number, `explained` curation divergence excluded. |
| F4 | **The backfill double-charges reveals** | routing the attach through the reveal-and-charge path | The attach uses **only the free `MatchPort` match seam** (writes `master_*_id`, never `is_revealed`/credit); a **backfill invariant test** asserts per-workspace credit-pool delta = 0 and **zero** `contact_reveals` rows written by the attach (HC2). |
| F5 | **`master_*_id` made `NOT NULL` / `account_id` dropped** breaks staging + rollback | over-eager "clean" migration | **Rejected** (`RESEARCH_07 §7`): `master_*_id` stays nullable (ADR-0021:63-65 in-flight staging); `account_id` retained + demoted (the rollback path); no hard contract in v1. |
| F6 | **A non-concurrent index / validating FK / un-timed RLS `ALTER`** locks the big table | a write/access-exclusive lock queues all traffic | CONCURRENTLY lane (§0.3); `NOT VALID`+`VALIDATE`; `lock_timeout`+retry; same-window policy create for the optional visibility RLS (`RESEARCH_07 §3`). |
| F7 | **The shadow reader runs as `leadwolf_app`** | wiring the comparison under `withTenantTx` for convenience | It runs as **`leadwolf_shadow`** (§2.2); the gating itest asserts the shadow path is not `leadwolf_app` (HC1; §RLS-4). |
| F8 | **A second, drifting backfill matcher** | a bulk-only matcher/normalizer for the backfill | **Rejected** (ADR-0037:75-81): backfill and live write are the **same** `MatchPort`/`matchKeys` call (§2.1) — cannot drift. |
| F9 | **The Stage-A catch-up delta is missed** | rows mutated during the long offline build | Continuous re-attach + a final reconciliation before each ws flip (S6/OQ6); dual-write (S5) closes the new-row gap. |
| F10 | **A suppressed/erased subject re-attached mid-backfill** | Stage B/A ignores suppression during the run | Suppression gate excludes `is_suppressed` from re-match/re-attach (§RLS-6); DSAR cascade unchanged. |
| F11 | **A workspace half-flipped** (some rows new path, some old) mid-ramp | per-row rather than per-workspace switch | The switch is the **per-workspace `stage`** (§0.2), not per-row — a ws is wholly on the old or new read path; `account_id` serves the un-attached rows under both. |
| F12 | **The optional visibility RLS blanks the overlay** | adding `FORCE`/a policy without the policy in the same window | `lock_timeout`+retry + same-window policy creation (D8; `RESEARCH_07 §3`); D8's RLS is the one care-step and is optional/separable. |

---

## Pre-build thinking pass (the applicable items — `truepoint-architecture`; `PLAN_00 §8`)

- **1 Source of truth (during the move).** The overlay remains truth until S7 flips a workspace's read; Layer 0
  becomes truth incrementally as S3 populates and S4/S5 attach — "candidate truth" until per-ws shadow proves
  parity, then read truth. Never two *authoritative* sources at once (C1; `RESEARCH_07 §6.1`).
- **2 Failure modes / idempotency.** Stage A idempotent on `source_records.content_hash`; Stage B idempotent
  (deterministic keys resolve the same row to the same `master_*_id`), **fill-only / never-clobber** a user-edited
  or just-revealed overlay value (survivorship, ADR-0015); backfill workers are BullMQ + DLQ, resume from the PK
  cursor. Full list above.
- **3 Duplicate prevention.** Stage A false-merge bounded by Splink's calibrated thresholds (≤0.5%) with
  low-confidence pairs to `match_links.review_status` (`03:481-483`) — never a silent merge; Stage B cannot dupe
  the overlay (the per-workspace partial-unique blind-index constraints still hold, `contacts.ts:156-164`).
- **4 Audit & change history.** Stage B per-row outcome in `enrichment_job_rows`; Stage A lineage in
  `source_records` + `match_links`; every privileged cross-tenant touch via `withPrivilegedTx`/`withPlatformTx`
  writes `platform_audit_log` in the same tx (`client.ts:30-35,95-111`); cutover stage changes audited.
- **5 Security / isolation.** S0 grant-off + the "`leadwolf_app` cannot read `master_*`" itest + the shadow reader
  as `leadwolf_shadow` are the gating controls; the overlay FORCE-RLS posture + the two-tenant itest are untouched
  and must stay green — the migration's non-negotiable (security has final say).
- **6 Scalability / 10×.** Stage-A ER offline (lake/Spark, not the primary); CONCURRENTLY lane; batched/throttled
  Stage B; `lock_timeout`+retry; sampled shadow. Scale-gate table.
- **7 Observability.** Per-stage: Stage-A rows resolved / review-queued / false-merge rate; Stage-B
  `match_outcome` distribution, rows attached, batches/sec, cursor; S6 per-ws `parity_rate` (the go/no-go) +
  `explained`-vs-unexplained split; index build progress + `INVALID` count; lock-timeout retry count; per-ws
  `stage` ramp. Runbook: pause = stop the queue (idempotent resume); read-path regression = set `stage` back
  (instant, per-tenant).
- **8 Rollback.** Every step reversible: expand → drop/ignore the nullable col; backfill → `master_*_id` NULLable
  + `account_id` still serves, so NULL-out is safe; dual-write → flag-off; read cutover → set `stage` back
  (per-tenant, instant). The only irreversible-ish action (drop `account_id` / the old path, S8) is **out of scope
  for v1**.
- **9 Edge cases.** Domainless/keyless contact → no deterministic key → `master_*_id = NULL` (tolerated staging,
  like today's `account_id = NULL`); hand-edited overlay value disagreeing with master → don't overwrite (HC4
  survivorship); concurrent reveal during S4 → reveal writes the master-derived value, backfill is fill-only (no
  clobber); DSAR mid-backfill → suppression gate halts re-attach; a ws mid-import during the S5 ramp → the per-ws
  flag means the row either dual-writes or doesn't, never half (F11).
- **10 Assumptions (load-bearing).** (a) `account_id` is retained throughout (the rollback path); (b) Stage A runs
  offline on the lake (not the primary); (c) the per-ws shadow `parity_rate` distinguishes curation divergence
  from a wrong answer (HC4); (d) the master matcher stub degrades gracefully to overlay+provider until the
  candidate index lands (HC5).
- **11 Misuse.** A workspace cannot trigger or read the migration machinery (no `leadwolf_app` grant on Layer 0 /
  the control tables); the per-ws ramp is operator-driven; a tenant cannot self-advance its `stage`.
- **12 Load behaviour (10×).** Bottleneck order = the Scale-gate ranks (Stage-A ER → big-table index → Stage-B I/O
  → lock queue → shadow double-cost → catch-up delta), each with its named fix.
- **13 Worst case.** F1 — the blanket grant silently exposes `master_*` to `leadwolf_app` → one bad query = a
  full-universe cross-tenant breach. Prevented by S0's explicit `REVOKE` + the grant-off gating itest. This single
  failure is catastrophic rather than operational, and it is why S0 is the **first** migration step.

---

## Open questions

The seven `BRAINSTORM_07 §6` questions + the six `RESEARCH_07 §8` questions — each **resolved** here or handed
forward with an owner:

1. **Per-workspace vs per-tenant flip granularity.** *Resolved:* a **per-workspace** `migration_cutover_state`
   (§0.2) is the unit (the shipped `tenant_feature_flags` is per-tenant, too coarse for a multi-workspace tenant);
   the read-router consults the cached `stage`. *Residual:* whether to back `stage` by the shipped flag surface or
   keep the dedicated control table long-term (with `truepoint-platform`).
2. **Shadow-read scope, sampling, and the HC4 threshold.** *Resolved shape:* compare the "person at company with
   traits", detail, and account-facet reads; per-ws sample rate; `parity_rate ≥ θ` over min samples gates the flip,
   with `explained` curation divergence excluded (§2.2). *Residual:* the actual `θ`, sample rate, and min-sample
   count — calibrate from the first canary cohort (with `truepoint-operations`; `RESEARCH_05`-adjacent).
3. **`account_id` ↔ `master_employment` read-time precedence.** *Resolved:* post-cutover the read returns the
   master-derived current employer as the **golden facet** and keeps `account_id` as the **workspace pointer** —
   two facets, survivorship-protected, not a swap (§2.2, HC4). *Residual:* the exact UI surfacing of "your filed
   account vs the current employer" (with `truepoint-design`).
4. **Per-workspace Stage-A readiness signal.** *Resolved:* `migration_cutover_state.stage_a_coverage` (the
   fraction of *that workspace's* universe present in Layer 0) gates `attaching`→`dual_write` (HC5; not just "Stage
   A finished globally"). *Residual:* the coverage metric definition + the threshold (with `truepoint-data` ER).
5. **The backfill no-charge guard.** *Resolved:* the attach uses only the free `MatchPort` seam; a **backfill
   invariant test** asserts per-ws credit-pool delta = 0 and zero `contact_reveals` written by the attach; a
   concurrent live reveal is fill-only-ordered so neither clobbers the other (HC2/F4). *Residual:* the exact test
   harness location (a new `packages/db/test/backfillNoCharge.itest.ts`).
6. **The Stage-A catch-up delta.** *Resolved direction:* a continuous re-attach sweep + a final reconciliation
   pass before each workspace's flip (F9/§Scale-gate-6). *Residual:* continuous vs single final pass per ws — tune
   from the measured Stage-A wall-clock (with `truepoint-operations`).
7. **Shadow-reader role + grant-off enforcement in app code.** *Resolved:* the shadow read runs as
   **`leadwolf_shadow`** (master `SELECT`, never `leadwolf_app`); the grant-off gating itest is extended to cover
   this *application* read path, not just the migration grants (HC1; §RLS-4). *Residual:* the exact `leadwolf_shadow`
   grant DDL (with `truepoint-security`) + the CONCURRENTLY-lane runner mechanism (§0.3).
8. **(research §8) Least-privilege role split.** *Resolved:* `leadwolf_er` (write), `leadwolf_search_sync` +
   `leadwolf_shadow` (read), `leadwolf_reveal` (channel decrypt), `leadwolf_verify`/`leadwolf_sweep` (Phase 6) —
   six purpose-scoped roles (§0.1). *Residual:* whether to merge `leadwolf_search_sync`/`leadwolf_shadow` (both
   master-read) into one read role — a security/operability tradeoff (with `truepoint-security`).
9. **(research §8) Backfill orchestration & throttle policy.** *Handed forward:* per-workspace vs global batching
   for Stage B, concurrency/rate caps, pause/resume, replica-read — owned by ADR-0036 (bulk-job model) + ADR-0024
   (SLOs).
10. **(research §8) Dual-write ordering & latency budget.** *Resolved direction:* the import-path `master_*_id`
    attach (S5) is a bounded `MatchPort` call (cache-first), flag-gated; sync-on-thread vs async-via-outbox is the
    import-latency SLO decision. *Residual:* the SLO + sync/async choice (with `truepoint-platform`).
11. **(research §8) Co-op CONTRIBUTE-TO back-pressure during migration.** *Handed forward:* if overlay edits begin
    feeding `source_records` (ADR-0021:60-62) while the backfill runs, the write-back isolation interacts with
    Stage A — `RESEARCH_04` open-Q 6; **deferred** (CONTRIBUTE-TO is off by default).

> **Implementation status (gap → work-to-do, never license to skip a rule).** **Shipped and reused:** the entire
> migration machinery — the Drizzle migrator + idempotent `rls/*.sql` + bootstrap + the blanket `GRANT` / the
> platform-staff `REVOKE` precedent (`applyMigrations.ts:28-146`), the off-pooler direct-host runner with
> `lock_timeout`/`statement_timeout` (`migrate.ts:20-30`, `applyMigrations.ts:112-115`), the role/GUC machinery
> (`client.ts:30-68,95-111`), the `MatchPort`/`matchKeys` seam + the `masterGraphMatcher` **stub**
> (`matchPort.ts`, `masterGraphMatcher.ts:26-34`), the `enrichment_jobs`/`chunks`/`rows` backfill ledger
> (`enrichmentJobs.ts`), and the per-tenant feature-flag surface (`featureFlags.ts:15-44`). **Designed-but-unbuilt
> and finalized by this PLAN:** the S0 grant-off `REVOKE` + the six least-privilege roles, the
> `migration_cutover_state` + `migration_shadow_samples` control tables, the CONCURRENTLY execution lane, and the
> per-workspace shadow-parity gate. These land the still-unbuilt upstream — Layer 0 (`PLAN_01`), the SCD2 edge +
> `current_company_id` (`PLAN_02`), `field_provenance` + `search_outbox` (`PLAN_03`), `revealed_channels` +
> `leadwolf_reveal` (`PLAN_04`), the master-backed read surface (`PLAN_05`), the freshness machine (`PLAN_06`) —
> all 100% docs today (`PLAN_00` C1). The import path **admits the dual-write gap** (`runImport.ts:230-241` does
> not yet set `master_*_id`). None of these gaps relaxes a constraint: when built, the migration stays additive +
> reversible (no hard contract, `account_id` retained), Layer 0 stays grant-off (the wall, S0/C7), the overlay
> stays FORCE-RLS with the isolation itest green (C8), the attach stays a free match never a reveal (C4/HC2), the
> backfill stays offline-on-the-lake + batched-on-the-overlay, and the read flips per-workspace on measured parity,
> reversibly. The deferrals (the S8 hard contract, the exact `θ`/sample rate, the co-op back-pressure) are
> **deferral, not omission** — each is reachable additively, and the destructive S8 is a separately-gated *later*
> decision, never part of the landing migration. Security has final say (CLAUDE.md precedence).
