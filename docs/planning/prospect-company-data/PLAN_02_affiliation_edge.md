# Phase 2 — The Affiliation Edge (person↔company): PLAN

> **Gate: PLAN.** Phase 2 of the prospect↔company data initiative — the **person↔company edge**, ADR-0021's
> *"central design object."* This gate freezes the concrete `master_employment` schema (columns, indexes, FKs,
> unique constraints, provenance/confidence cache), the job-change / multi-affiliation / company-less /
> ambiguous-match flows, the overlay-reconciliation rules, the Layer-0 RLS posture, and the scale-gate fixes.
> **Converts:** `BRAINSTORM_02_link_options.md §6` (the DECISION — *B's SCD2 edge as a derived projection over
> D's immutable `source_records`→`match_links` log; C rejected except its one transaction-time field*) and
> `RESEARCH_02_linking_patterns.md §6` (the RECOMMENDATION — *a confidence-scored SCD2 edge that extends, not
> replaces, the planned `master_employment`*). It answers the six edge-specific open questions
> `BRAINSTORM_02 §7` handed forward. **Depends on / cites:** `PLAN_00_constraints_and_scope.md` (C1–C9 locked
> constraints), the planned DDL (`03-database-design.md:428-486`), ADR-0021/0015/0037/0022/0025/0035,
> `matchKeys.ts:74-81`, `rls/contacts.sql:16-48`, `client.ts:30,48-68,95`. **No code, schema, SQL, or settings
> are modified by this gate — only this file is written; the DDL below is the freeze `PLAN_01`+`PLAN_02`
> co-land, not an applied migration.**

---

## 0. Lineage — what this PLAN converts and freezes

`RESEARCH_02 §6` recommended *"a confidence-scored, SCD2-grain employment EDGE … treat the planned
`master_employment` as the correct skeleton that this initiative must extend with provenance and
resolution-state, not replace."* `BRAINSTORM_02 §6` sharpened that into the DECISION: **the link is the planned
SCD2 edge, but it is a *derived projection* of the immutable `source_records`→`match_links` evidence log** — B's
read/storage grain over D's truth/provenance grain, with C (full bi-temporal) rejected except for its one cheap
transaction-time field absorbed as `observed_at`. This PLAN is the *paving* of that road. It does three things:

1. **Freezes the edge schema** (§1) — the planned `master_employment` (`03-database-design.md:428-436`) extended
   with: a safe dedup identity (closing the `BRAINSTORM_02 §5` Prong-2 nullable-`started_on` hole), an
   `is_primary` selector with a DB-enforced "one primary per person" constraint, and the thin derived provenance
   cache `{asserting_source, match_method, confidence, source_count, observed_at, last_verified_at}` (the U2 seam,
   `PLAN_00` C2/C5).
2. **Freezes the lifecycle flows** (§2) — job-change close-old/open-new/flip-cache/emit-signal as one atomic tx;
   the multi-affiliation primary tiebreak; company-less vs unresolved as distinct states; ambiguous→review
   routing through the *existing* `match_links.review_status`, never a new edge review state.
3. **Freezes the boundaries** — Layer-0 RLS posture (§4), overlay reconciliation + firmographic backfill (§3),
   scale-gate fixes (§5). Deferred (named, not designed): the field-merge survivorship engine (U1, Phase 3), the
   overlay job-change reconciliation *signal* (U3, Phase 3), the Splink probabilistic tail + billions-scale
   Citus/OpenSearch/Iceberg topology (the gated SCALE TRACK, `PLAN_00 §7`).

> **Trace, explicit.** Every schema choice below names the brainstorm DECISION clause (`BRAINSTORM_02 §6.1-6.6`)
> or the research recommendation point (`RESEARCH_02 §6.1-6.6`) it crystallizes, and each of the six
> `BRAINSTORM_02 §7` open questions is resolved inline and re-listed in §8 with its answer.

---

## Target schema

The edge stays Model B's grain — **one SCD2 row per (person, company) stint** — and becomes the **deterministic
projection** of the immutable log (`BRAINSTORM_02 §6.1-6.2`). Truth = `source_records` (raw assertion,
`content_hash` idempotency) + `match_links` (`match_probability`, `review_status`), already in the planned DDL
(`03-database-design.md:461-486`); the edge below is the recomputed read cache over the *accepted* assertions.

### 0.1 `master_employment` (extended) — DDL freeze

```sql
CREATE TABLE master_employment (                          -- person↔company affiliation edge (SCD2; Layer 0)
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  master_person_id  uuid NOT NULL REFERENCES master_persons(id)   ON DELETE CASCADE,  -- DSAR blast radius (§4)
  master_company_id uuid NOT NULL REFERENCES master_companies(id) ON DELETE CASCADE,
  -- ── affiliation facts (as planned, 03:432) ──
  title             varchar(255),
  department        varchar(100),
  seniority_level   varchar(50) CHECK (seniority_level IS NULL OR seniority_level IN
                      ('c_suite','vp','director','manager','ic','other')),       -- reuse the person enum (03:415-416)
  -- ── SCD2 validity + current/primary state (H1/H2) ──
  is_current        boolean NOT NULL DEFAULT true,     -- ≥1 may be true per person (concurrent affiliations, H2)
  is_primary        boolean NOT NULL DEFAULT false,    -- the ONE edge that drives current_company_id (PDL is_primary)
  started_on        date    NOT NULL DEFAULT '-infinity',  -- sentinel = "start unknown": makes unknown-start dedup COLLIDE
  ended_on          date,                              -- NULL while current
  -- ── derived provenance cache (U2 seam; the TRUTH is source_records+match_links — Q1=both grains) ──
  asserting_source  varchar(50),                       -- winning source_name (apollo|zoominfo|coop|public_registry|manual)
  match_method      varchar(20),                       -- deterministic_domain|deterministic_email|fuzzy_name_company|manual
  confidence        numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),  -- Fellegi-Sunter (03:478)
  source_count      int NOT NULL DEFAULT 1,            -- corroboration (# accepted source_records agreeing) — survivorship input
  observed_at       timestamptz,                       -- the single transaction-time field (1.5-temporal, RESEARCH_02 §6.2)
  last_verified_at  timestamptz,                       -- freshness decay hook (ADR-0025; Phase 6)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_on IS NULL OR ended_on >= started_on),  -- a stint cannot end before it starts
  CHECK (is_primary = false OR is_current = true)      -- a primary edge MUST be current
);

-- Edge dedup identity — fixes BRAINSTORM_02 §5 Prong-2: started_on is NOT NULL (sentinel '-infinity' for
-- "unknown"), so two unknown-start stints for the same pair COLLIDE → upsert/merge into one edge (no NULL-pair
-- duplicates). A real boomerang has distinct known starts → distinct rows (correct).
ALTER TABLE master_employment
  ADD CONSTRAINT uniq_employment_stint UNIQUE (master_person_id, master_company_id, started_on);

-- At most ONE primary edge per person — DB-enforced so two concurrent writers can NEVER both win the primary
-- slot (kills the §5 Prong-1 cache race at the constraint layer). current_company_id is the company of THIS edge.
CREATE UNIQUE INDEX uniq_employment_primary ON master_employment (master_person_id) WHERE is_primary;

-- Hot read: person → current affiliation(s). Partial index ≈1 row/person → tiny, cache-warm (03:436 retained).
CREATE INDEX idx_employment_current ON master_employment (master_person_id) WHERE is_current;

-- Reverse direction (company → its current people). Kept for admin/recompute/cursor scans ONLY — NOT the OLTP
-- hot path; "everyone at @google.com" is a ClickHouse facet query, never an OLTP join (§5).
CREATE INDEX idx_employment_company ON master_employment (master_company_id) WHERE is_current;
```

Companion index on the log so the edge **recompute is a bounded index scan**, not a seq-scan of `source_records`
(the evidence behind a `(person, company)` edge is exactly its accepted assertions):

```sql
CREATE INDEX idx_source_records_employment ON source_records (resolved_person_id, resolved_company_id)
  WHERE resolved_person_id IS NOT NULL AND resolved_company_id IS NOT NULL;   -- co-lands with the edge (Q5)
```

`master_persons.current_company_id` (`03-database-design.md:413,426`) is **retained unchanged** and re-defined as
a *recomputed cache* of the `is_primary` edge's `master_company_id` — never hand-set (§2.2; `RESEARCH_02 §2.5`).

### 0.2 Column intent — what each addition buys, and which question it answers

| Column / constraint | Grain | Answers | Why (trace) |
|---|---|---|---|
| `started_on NOT NULL DEFAULT '-infinity'` | identity | **Q1** | NULLs are distinct in a UNIQUE index → nullable start let two unknown-start stints duplicate (`BRAINSTORM_02 §5 Prong-2`). A single canonical sentinel makes them collide and merge. |
| `uniq_employment_stint (person, company, started_on)` | identity | **Q1** | One edge per stint; boomerang = distinct known starts = distinct rows; same-company concurrent unknown-start roles collapse to one edge (§2.3). |
| `is_primary` + `uniq_employment_primary … WHERE is_primary` | current-selection | **Q3** | `is_current` is *unconstrained* (H2: ≥1 live affiliations); `is_primary` is the single DB-enforced selector that drives `current_company_id`. PDL's `is_primary` (`RESEARCH_02 §1.1`), DB-enforced so the §5 Prong-1 race is impossible. |
| `confidence, source_count, observed_at, last_verified_at, asserting_source, match_method` | derived cache | **Q1, Q2** | The U2 provenance seam (`PLAN_00` C5). Thin denormalized cache for the hot read; **truth/unwind live in `source_records`+`match_links`** (`BRAINSTORM_02 §3.7`). Recomputed with the edge, never hand-set. |
| `CHECK (is_primary ⟹ is_current)` / `CHECK (ended_on ≥ started_on)` | integrity | **Q6** | Invariants the atomic job-change tx must preserve (§2.1); cheap fail-closed guards. |
| `idx_source_records_employment` | recompute | **Q5** | Bounds the edge recompute to an index scan over a person's assertions (§5 write-side). |

> **No `review_status` on the edge (Q2 resolved).** Per `BRAINSTORM_02 §6.4`, an ambiguous bind lives **only** as
> a `match_links` row with `review_status='pending'`; the **edge does not materialize until the company side is
> `confirmed`/`auto`** (`resolved_company_id` set). There is therefore no half-resolved edge to filter out of
> reads (the fail-open risk `BRAINSTORM_02 §3.3` names) and no duplicate review machinery (`PLAN_00` reuse rule).
> The edge existing **is** the signal that resolution was accepted.

### 0.3 Edge ER sketch (Layer 0 — truth → projection)

```
  source_records  (immutable, append-only — TRUTH/lineage; content_hash UNIQUE → idempotent ingest, 03:464)
    resolved_person_id ─┐   resolved_company_id ─┐   match_keys{email_bi, domain, li_id, phone}
                        │   (set by ER pipeline)  │
        match_links  review_status ∈ auto|pending|confirmed|rejected   match_probability  (03:473-485)
                        │  (accepted assertions for a (person,company) pair → survivorship recompute)
                        ▼
  master_employment  (DERIVED edge: is_current/is_primary, started_on/ended_on, confidence, source_count)
                        │
                        └─▶ master_persons.current_company_id  (cache of the is_primary edge — §2.2)
  master_person ──0..N── master_employment ──N..1── master_company  (primary_domain / alt_domains / parent_company_id)
```

---

## 1. Edge resolution & lifecycle flows

### 1.1 Job change — close-old / open-new / flip-cache / emit-signal (one atomic tx)

`RESEARCH_02 §4` named the cache going stale *"the single most expensive correctness bug here."* The fix is the
**Model-D derivation discipline** (`BRAINSTORM_02 §3.1`): the four steps run in **one Postgres transaction**,
idempotent on `source_records.content_hash` (`03:464`), and the cache is *recomputed from the edge set*, never
raced. An accepted assertion "person P is now at company C₂ (≠ current primary C₁), title T, since D":

```
  BEGIN (inside the ingest tx; idempotent on source_records.content_hash)
   1. INSERT source_records(...) ON CONFLICT (content_hash) DO NOTHING     -- assertion logged first (truth)
   2. (ER) set resolved_person_id=P, resolved_company_id=C2; match_links row review_status=auto|confirmed
   3. CLOSE old:  UPDATE master_employment SET is_current=false, is_primary=false,
                    ended_on = COALESCE(NULLIF(D,'-infinity'), CURRENT_DATE)
                  WHERE master_person_id=P AND is_current AND master_company_id=C1
   4. OPEN new:   INSERT master_employment(P, C2, title=T, started_on=COALESCE(D,'-infinity'), is_current=true,...)
                  ON CONFLICT (master_person_id, master_company_id, started_on)
                    DO UPDATE SET is_current=true, title=EXCLUDED.title, source_count=source_count+1,
                                  confidence=greatest(..), observed_at=now(), updated_at=now()   -- merge, not dup
   5. PRIMARY:    recompute is_primary across P's current edges by the §2.2 tiebreak (exactly one wins)
   6. CACHE:      UPDATE master_persons SET current_company_id = (primary edge's company), updated_at=now()
   7. SIGNAL:     INSERT employment_change_outbox(P, C1→C2, kind='employer_change', observed_at, content_hash)
  COMMIT
```

Steps 3–6 are **transactional truth**; step 7 is the **outbox row** an async worker drains (BullMQ, `apps/workers`)
to (a) propagate the flattened search doc (ADR-0035, §5), (b) feed **Phase 6** freshness/lifecycle (the
job-change *detection trigger* the task names), and (c) reserve the **U3 overlay reconciliation** seam (Phase 3 —
surface as a workspace *signal*, never an overlay overwrite; §3). The outbox is `content_hash`-keyed so a retried
worker re-emits exactly once. **Title-change-within-same-company** (ZoomInfo signal 2, `RESEARCH_02 §1.2`) is the
C₁==C₂ branch: no close/open, just an in-place title update + `kind='title_change'` outbox row.

> `employment_change_outbox` is a Layer-0 system table (range-partitioned by `observed_at` like `source_records`,
> `03:470`); its exact columns are Phase-6 territory — this PLAN **reserves the seam** (one outbox INSERT in the
> same tx, `PLAN_00 §8` audit rule), it does not freeze that table's shape.

### 1.2 Multi-affiliation & the primary tiebreak (Q3)

`is_current` is **unconstrained** — a board seat + an operator role at two *different* companies are two rows,
both `is_current=true` (H2 native, `BRAINSTORM_02 §3.2`). Exactly one drives the firmographic backfill, chosen by
this **ratified deterministic tiebreak** (recomputed in step 5 above):

1. **Email-domain match wins.** If the person's primary `master_emails.email_domain` (`03:443`) resolves via the
   shipped PSL key (`registrableDomain`, `matchKeys.ts:74-81`) to one current edge's company `primary_domain`/
   `alt_domains` → that edge is primary. (Strongest company key, `PLAN_00` C2 — reuse, don't invent.)
2. else **highest `confidence`**, 3. else **most-recent `started_on`** (ignoring the `'-infinity'` sentinel),
   4. else **lowest `id`** (uuid v7 = oldest insert) as a total-order tiebreaker so the rule is **deterministic
   under concurrency** and the `uniq_employment_primary` partial unique can never deadlock on "two equal winners."

The partial unique index makes the outcome **DB-enforced**: the recompute sets `is_primary=true` on the winner and
`false` on the rest within the tx; a concurrent writer that also recomputes serializes on the index (one wins, the
other re-derives). `current_company_id` is then unambiguous.

### 1.3 Company-less vs unresolved vs name-only (H4 — three distinct states)

The `0..N` edge keeps these **distinct**, which the degenerate `contacts.account_id` cannot (`RESEARCH_02 §2.6`):

| State | Representation | `current_company_id` |
|---|---|---|
| **Company-less** (founder pre-domain, freelancer, student, between jobs) | **zero** `master_employment` rows | `NULL` |
| **Unresolved** (company not yet matched) | a `source_record` with `resolved_company_id IS NULL`, or a `pending` `match_link` — **no edge** | `NULL` |
| **Name-only company** (no domain) | low-confidence `name_normalized` assertion (`03:395`) held `pending` in `match_links` — **never auto-edge** | `NULL` |

A non-freemail domain with no `master_company` yet → **mint a company node** keyed on `primary_domain` (the domain
*is* the identity, Clearbit, `RESEARCH_02 §1.6`) then open the edge. `master_persons.has_email/has_phone` facets
(`03:418-419`) still apply to company-less people, so they remain searchable.

### 1.4 Ambiguous company match → review routing (H3, Q4)

Domain→company hazards are **resolution-state** problems routed through the *existing* two-threshold ER machinery
(`BRAINSTORM_02 §6.4`; ADR-0015), never a new edge state:

- **Freemail / role domains** (`gmail.com`, `info@`) — gated at **`match_keys` extraction** (Q4 resolved): a new
  `companyDomainKey()` wrapper around `registrableDomain` (`matchKeys.ts:74-81`) returns **undefined** for a
  domain on a maintained freemail/role blocklist living in `@leadwolf/core` (e.g.
  `packages/core/src/enrichment/freemailDomains.ts`, seeded from a public list, versioned in code — **not** a
  PSL-private section, which would corrupt the pure eTLD+1 function). No domain key → `resolved_company_id` stays
  NULL → **no edge** → company-less for that signal, never a fake "Gmail Inc." `registrableDomain` itself stays
  pure (single normalizer, ADR-0037 / `PLAN_00` C2).
- **Short/shared name** ("Apex"→5 companies) — below the high cutoff → `match_links.review_status='pending'` →
  clerical-review queue; no edge until confirmed. Clearbit's traffic-rank tiebreak is a heuristic, not truth
  (`RESEARCH_02 §2.4`).
- **Subsidiary vs parent / rebrand / redirect** — `parent_company_id` hierarchy + `alt_domains[]` keep them
  distinct-but-linked (`03:393,397`); the edge points at the resolved leaf company; the hierarchy answers "rolls
  up to."

---

## 2. Overlay reconciliation & firmographic backfill (§3 of the task)

Three rules keep the **two** company links from fighting (`BRAINSTORM_02 §4`); the overlay never competes with the
edge — it *snapshots* it:

```
  OVERLAY (per-workspace, FORCE RLS)                  LAYER 0 (system-owned, NO RLS)
  contacts.account_id ─────▶ accounts                 master_persons
   (workspace company,        ├─ master_company_id ───────────────┐ (bridge, nullable, re-pointable; 03:495)
    upsert-by-domain,         └─ owner/visibility/icp_fit          ▼
    contacts.ts:98,197-198)      (workspace-private)    master_persons ─ master_employment ─ master_companies
  contacts.master_person_id ───────────────────────────▶          (the shared edge — Layer 0; 03:518,556)
   (bridge, nullable; 03:518)
```

### 2.1 How the three pointers agree

1. **`contacts.account_id` is a workspace *snapshot*, not a competing truth.** A reveal copies a **point-in-time**
   snapshot of the currently-resolved company/title from the edge into `account_id`/`job_title` (the existing
   reveal-copies-value mechanic, ADR-0021:48-51). After reveal the snapshot is **frozen by ownership**; a later
   Layer-0 job change does **not** rewrite it (would violate survivorship, ADR-0015) — it surfaces as a U3 *signal*
   (Phase 3). `accounts` dedup stays the overlay's own key: `uniq_accounts_ws_domain (workspace_id, domain)`
   (`03:510`).
2. **`accounts.master_company_id` / `contacts.master_person_id` are the bridges** — nullable only for in-flight
   staging (`PLAN_00` C4), **re-pointable** when deferred ER merges two master companies. The workspace's own
   `account_id`/`domain` never re-points; only the bridge does (`BRAINSTORM_02 §4.2`).
3. **The overlay gets NO mirrored employment table.** Affiliation *history* lives once, at Layer 0. Mirroring
   `master_employment` per-workspace is the **dedup-defeating mistake** (`BRAINSTORM_02 §4.3`) the PLAN explicitly
   **forbids**: it re-fragments the universe ADR-0021 unifies. A workspace needing role history reads it **by
   access path** at reveal/refresh, never into N per-workspace SCD2 tables.

### 2.2 Firmographic backfill — a derived projection, never an independently writable field

`current_company_id` and the flattened search doc (ADR-0035) are a **cache of the `is_primary` edge**, recomputed
transactionally on any job change (§1.1 step 6) — the PDL discipline (`RESEARCH_02 §2.5`): *the edge set is truth,
the denormalization is a cache.* Backfilling firmographics (industry, employee_band, revenue_range, technographics)
onto the **overlay** for query speed is served two ways, both read-only projections of `master_companies`:

- **At reveal/refresh:** the reveal path copies the resolved company's firmographics into the workspace's
  `accounts` row (one-time snapshot, owned thereafter — same survivorship rule).
- **At search time:** the flattened person+company search doc (ADR-0035, "person at company with these company
  traits" in one query) is built from `master_persons` ⋈ `current_company_id` → `master_companies`, **denormalized
  so no per-row join runs at query time** (`RESEARCH_02 §4`; §5 below). Recomputed when the current edge changes.

Neither path lets the overlay or the search doc be *independently written* — that would re-introduce limit-#1
staleness at a new layer (`RESEARCH_02 §2.5`).

---

## RLS policy implications

The edge is **Layer-0 system-owned and NOT workspace-RLS-scoped** (ADR-0021:33-35,39-40; `PLAN_00` C6). Concrete
posture — the inverse of the overlay's `rls/contacts.sql:16-48`:

- **No `workspace_id` column on `master_employment`** (nor on `source_records`/`match_links`/`master_*`). Adding
  one to "make RLS work" is the rejected anti-pattern (`RESEARCH_02 §4` Reject #3; `BRAINSTORM_02 §3.5`): it would
  shatter the dedup-once promise into N per-tenant edges and bleed isolation into the shared graph.
- **No RLS policy and no `GRANT … TO leadwolf_app`** on the master tables. A workspace tx runs `SET LOCAL ROLE
  leadwolf_app` + the two `set_config` GUCs (`client.ts:48-68`) — that non-BYPASSRLS role has **no table
  privilege** on `master_employment`, so a tenant query **cannot address the edge at all** (privilege-denied, not
  merely row-filtered). Isolation is by **access path**, not a predicate.
- **The only reachable paths** are the audited system/admin roles — `withPrivilegedTx` (`leadwolf_admin`,
  `client.ts:30`) and `withPlatformTx` (owner connection + a `platform_audit_log` row in the same tx,
  `client.ts:95`) — plus the **product flow**: masked search returns IDs → paid reveal copies a snapshot into the
  overlay. Masked search may return a *masked* form of the edge (person at company, title, dates); the corroborating
  channels (`master_emails`/`master_phones`) are **never** returned by search, only by paid reveal (`03:383-384`).
- **DSAR / deletion cascade.** A data subject is one `master_persons` identity found by `email_blind_index`
  (`03:442`). Erasure cascades **through the edge**: `master_employment.master_person_id ON DELETE CASCADE`
  (`03:430`) drops all affiliations; `match_links.source_record_id ON DELETE CASCADE` (`03:477`) and the
  `source_records` evidence are in the same blast radius (the append-only log **must honour erasure** —
  `BRAINSTORM_02 §4 DSAR note`); the overlay copies tombstone (`contacts.deleted_at` + PII null,
  `contacts.ts:147`); a GLOBAL suppression row blocks re-import (`list-plan/02-data-model.md:307-329`). The
  **golden identity**, not the overlay copy, is the unit of deletion (ADR-0021 deletion; `PLAN_00` C8).
- **Two-tenant isolation itest still blocks merge** for every overlay touch-point in this phase (the bridge writes
  on `contacts`/`accounts`): the mandatory model is `lists.itest.ts`/`emailIsolation.itest.ts` (`PLAN_00 §8`). The
  edge itself is covered by a **negative** access test: a `withTenantTx` under `leadwolf_app` selecting
  `master_employment` must **error (privilege denied)**, proving the access-path wall.

---

## Scale-gate analysis

Scale target: millions of users, **billions** of edges (people × jobs — the largest table in the graph,
`RESEARCH_02 §4`). N+1 and unbounded fan-out are failures. *What breaks first at 10×, and the fix:*

| Rank | What breaks first at 10× | Why | Fix (this PLAN) |
|---|---|---|---|
| **1** | **`current_company_id` cache goes stale / two `is_current` writers race** | Concurrent job-change + re-enrichment on the same person can flip the primary or leave the cache on the closed edge — *"the single most expensive correctness bug"* (`RESEARCH_02 §4`) | Atomic close/open/recompute/cache tx (§1.1) + **`uniq_employment_primary` partial unique** so two writers can never both hold primary (DB-enforced, §1.2); cache recomputed *from* the edge, never hand-set. Search-doc lag is bounded async (rank 4). |
| **2** | **Hot-company fan-out** (every `@google.com` person) | "company → all its people" on the OLTP path is an unbounded scan/join | Reads are **person → current edge** (1 row via `idx_employment_current`, the partial `WHERE is_current` index ≈1 row/person). "Everyone at company X" is a **ClickHouse facet / OpenSearch** query (ADR-0035), **never** an OLTP join. `idx_employment_company` exists only for cursor-bounded admin/recompute. |
| **3** | **"Person at company with traits" becomes an N+1 join** at billions | A per-result-row join to `master_companies` is fatal at scale | **Denormalized** `current_company_id` + the **flattened** person+company search doc (§2.2; ADR-0035) — one query, zero per-row joins; Citus-shard by `master_person_id` co-locates a person's edges + person + emails/phones. |
| **4** | **Write-amplification on ingest** (the D-projection recompute) | Naive "recompute all edges per assertion" is an N+1 write bomb (`BRAINSTORM_02 §2 Model D failure`) | Recompute is **per-(person,company) only**, an upsert on `uniq_employment_stint` + one person-cache update + one outbox row = **O(1) per accepted assertion** (Q5). Edge evidence recompute is a bounded index scan via `idx_source_records_employment`. Idempotent on `content_hash`. |
| **5** | **Fuzzy `name_normalized` edges auto-bind under load** | Auto-binding the gray zone breaches ADR-0015's ≤0.5% false-merge target | Gray-zone binds stay `match_links.review_status='pending'` — **no edge materializes** (§1.4); only `auto`/`confirmed` assertions produce edges. |

**Cache-staleness contract (Q6).** Steps 3–6 are one atomic Postgres tx → **detail reads and read-your-own-write
are always consistent** post-commit (truth is Postgres, `RESEARCH_05`/ADR-0035). Only the **search index** lags,
via the outbox→CDC propagation (step 7), under the ADR-0035 eventual-consistency SLO (browse/search may serve a
just-moved person at the old company for the convergence window; permissions are re-checked against Postgres truth
at read, so this is a *freshness* lag, never an *isolation* leak). The acceptable convergence SLO (e.g. p99 search-doc
lag) is set in `RESEARCH_05`/Phase 5, not frozen here.

---

## 3. Pre-build thinking pass (the applicable items)

- **1 Source of truth.** `source_records` (raw) + `match_links` (accepted, scored) are truth; `master_employment` +
  `current_company_id` are a **derived, rebuildable projection** (`BRAINSTORM_02 §6.2`). The edge is disposable —
  it can be dropped and re-derived from the log (rollback, item 8).
- **2 Failure modes + idempotency.** Ingest is idempotent on `source_records.content_hash` (`03:464`); the edge
  upsert is idempotent on `uniq_employment_stint`; the outbox is `content_hash`-keyed → exactly-once signal. Full
  failure list in §4 (Failure modes).
- **3 Duplicate prevention.** `uniq_employment_stint` (NOT-NULL sentinel start closes the NULL-collision hole);
  `uniq_employment_primary` (one primary/person); company dedup on `primary_domain UNIQUE` (`03:392`).
- **4 Audit + change history.** Every state change appends an immutable `source_records` row (lineage) and an
  `employment_change_outbox` row **in the same tx** (`PLAN_00 §8`); privileged reads write `platform_audit_log`
  (`client.ts:95`). History of *state* = SCD2 rows; history of *assertions* = the log.
- **5 Security.** No `workspace_id`, no RLS leak, no `leadwolf_app` GRANT (§ RLS). IDOR is impossible from a tenant
  tx (privilege-denied). Reveal copies a snapshot; PII channels never search-returned. The client never names a
  `master_*_id` — bridges are server-resolved.
- **6 Scalability.** Covered in Scale-gate. Partial indexes, denormalized cache, Citus shard key, O(1) write-amp,
  facet reads off OLTP.
- **7 Observability.** Emit: `employment.edge.opened/closed`, `employment.primary.recomputed`,
  `employment.change.signal` (kind=employer/title/department), review-queue depth (`match_links` pending count),
  cache-recompute lag, outbox backlog. Runbook hooks feed Phase 6 lifecycle + ops dashboards.
- **8 Rollback.** The edge schema is additive (new columns nullable/defaulted; `started_on` default sentinel keeps
  existing planned rows valid). The edge is **reversible by construction** — drop and re-derive from the immutable
  log; a bad recompute is fixed by the next recompute (concurrency-safe-by-recompute, `BRAINSTORM_02 §3.1`).
- **9 Edge cases.** Null/unknown start (sentinel); two `is_current` (allowed; primary tiebreak); boomerang (distinct
  starts → distinct rows); same-company concurrent role (collapses to one edge, §1.3); company-less vs unresolved vs
  name-only (three distinct states, §1.3); freemail (no edge); ambiguous (review, no edge); concurrent writers
  (serialize on the primary unique).
- **10 Assumptions (load-bearing).** (a) One person holds *few* jobs (edge fan-out per person is small → the partial
  index stays ≈1 row). (b) A single primary company is sufficient for the firmographic backfill (multi-primary is
  not a product requirement). (c) Same-company concurrent roles need not be modelled as separate edges (the edge is
  person↔company, not person↔role). If (c) proves false, a `role_discriminator` joins the dedup key (§8 Q1).
- **11 Misuse.** A workspace cannot mutate the shared edge (no privilege); co-op CONTRIBUTE-TO is opt-in/contractual
  and feeds a `source_record` ER *proposes* from — it **never** directly writes `master_employment` (ADR-0021:60-62).
- **12 Load behaviour at 10×.** Bottleneck order is the Scale-gate table (cache race → hot-company fan-out → N+1
  join → write-amp → fuzzy auto-bind), each with its fix.
- **13 Worst case.** A billion-row company (every employee of a megacorp) + a mass re-enrichment storm: bounded
  because reads are person→edge (1 row), writes are O(1)/assertion, and company→people is a facet query off OLTP.

---

## Failure modes

| # | Failure | Cause | Mitigation |
|---|---|---|---|
| F1 | **Stale `current_company_id`** after a job change | cache step lagged/raced the close/open | Atomic tx (§1.1) + recompute-from-edge; if the async search-doc lags, the next recompute self-heals (truth is Postgres). |
| F2 | **Two `is_primary` edges** for one person | concurrent recompute | **Impossible** — `uniq_employment_primary` partial unique serializes writers; the loser re-derives. |
| F3 | **Duplicate unknown-start stints** for one pair | NULL `started_on` distinct in a UNIQUE index | `started_on NOT NULL DEFAULT '-infinity'` → unknown-start rows collide → upsert merges (`source_count++`). |
| F4 | **Freemailer bound to a fake company** | `@gmail.com` treated as an employer | `companyDomainKey()` blocklist at extraction → no domain key → no edge (§1.4). |
| F5 | **Fuzzy edge auto-binds** past the cutoff | gray-zone match auto-accepted | Only `auto`/`confirmed` `match_links` produce edges; gray zone stays `pending`, no edge (§1.4, F-target ≤0.5%, ADR-0015). |
| F6 | **Layer-0 job change silently overwrites a revealed overlay** | treating the edge as overlay truth | Reveal snapshot is owned/frozen; a change is a **signal** (U3, Phase 3), never an overwrite (survivorship, ADR-0015). |
| F7 | **Edge readable by a tenant** | accidental `workspace_id`/GRANT | No `workspace_id`, no `leadwolf_app` GRANT, negative access itest (§ RLS). |
| F8 | **DSAR misses an affiliation** | cascade gap | `ON DELETE CASCADE` from `master_persons` (`03:430`) + log cascade + GLOBAL suppression; verification scan (`PLAN_00` C8). |
| F9 | **Outbox signal lost / double-emitted** | worker crash/retry | `content_hash`-keyed outbox row in the same tx → exactly-once drain; DLQ + backoff (BullMQ). |
| F10 | **Boomerang or same-company concurrent role lost** | dedup key too coarse | Boomerang = distinct known starts = distinct rows; same-company concurrent role collapses by design (assumption 10c; escalation = `role_discriminator`, §8 Q1). |

---

## Open questions

The six `BRAINSTORM_02 §7` questions, each **resolved** by this PLAN, plus the residual decisions handed forward:

1. **Edge dedup identity** — *Resolved:* `started_on date NOT NULL DEFAULT '-infinity'` + `uniq_employment_stint
   (person, company, started_on)`. *Residual:* if same-company **concurrent distinct roles** must be separate edges
   (assumption 10c fails), add a `role_discriminator` (e.g. `lower(title)` or `source`) to the key — deferred until
   a real case appears.
2. **Provenance reservation (minimum that keeps Phase 3 additive)** — *Resolved:* thin
   `{asserting_source, match_method, confidence, source_count, observed_at, last_verified_at}` columns as a derived
   cache; **no edge `review_status`/`is_provisional`** (pending lives only in `match_links`, the edge never
   materializes early). *Residual:* whether Phase 3 promotes the per-(person,company) evidence query into a
   materialized `employment_assertions` child table if `idx_source_records_employment` scans prove too broad.
3. **Multi-affiliation primary tiebreak** — *Resolved:* email-domain match → highest `confidence` → most-recent
   `started_on` → lowest `id`; `is_current` stays unconstrained, `is_primary` is the DB-enforced single selector.
   *Residual:* none for the skeleton; the survivorship engine (Phase 3/U1) may refine the confidence input.
4. **Freemail/role-domain blocklist** — *Resolved:* a versioned list in `@leadwolf/core`
   (`enrichment/freemailDomains.ts`), gated via a `companyDomainKey()` wrapper at **`match_keys` extraction**
   (`registrableDomain` stays pure). *Residual:* the list's update cadence/governance (ops, Phase 6).
5. **Deterministic projection recompute (sync vs async, write-amp)** — *Resolved:* **synchronous** in the ingest
   tx, idempotent on `content_hash`; a second source merges into the existing edge (upsert), never duplicates;
   write-amp is **O(1) per accepted assertion**; the job-change *signal* is async (outbox→worker). *Residual:* the
   full **survivorship** recompute (probabilistic merge over the cluster) is the gated SCALE TRACK (Phase 3+).
6. **Cache-staleness contract / SLO** — *Resolved:* close/open/recompute/cache/outbox is **one atomic tx**;
   Postgres is always consistent (read-your-own-write); only the **search index** lags via outbox→CDC under the
   ADR-0035 eventual-consistency SLO. *Residual:* the exact convergence SLO number is set in `RESEARCH_05`/Phase 5.

> **Implementation status.** None of this exists in code: Layer 0 is 100% docs (`PLAN_00` C1, `BRAINSTORM_02 §6`
> note); the only `master_person_id` in the codebase is the FK-less soft column on `enrichment_job_rows`
> (`RESEARCH_00 §2`); the overlay carries no `master_*_id`; the live link is the degenerate `contacts.account_id`
> (`contacts.ts:98`). Everything above is **work-to-do**, co-landing with `PLAN_01`'s entity tables as one
> deterministic-only skeleton (`PLAN_00 §7`). The "defer the survivorship recompute / U3 signal / SCALE-TRACK
> topology" lines are **deferral, not omission** — the deterministic skeleton is the bridge *toward* the
> projection, and the re-pointable-bridge merge debt (`PLAN_00` C4) is the obligation it carries, never a license
> to skip a rule.
