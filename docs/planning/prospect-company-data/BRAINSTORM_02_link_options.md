# Phase 2 — The Linking Layer (person↔company): Link-Model Options

> **Gate: BRAINSTORM.** Phase 2 of the prospect↔company data initiative — the **person↔company edge**,
> ADR-0021's *"central design object."* This gate generates the distinct ways the durable link *could* be
> modelled, names each one's strongest argument and the failure that kills it, stress-tests them against the
> hardest real cases, challenges the obvious edge-table default, and ends with a single DECISION that proceeds
> to the PLAN. It does **not** write the plan (the frozen column list / DDL / migration is the Phase-2 PLAN
> gate), nor design the field-provenance *merge engine* (Phase 3 / U1) or the overlay↔master *reconciliation
> signal* (Phase 3 / U3). **Depends on:** `RESEARCH_02_linking_patterns.md` (the cross-vendor evidence + the
> recommended edge model) and `BRAINSTORM_00_scope.md §5` (Framing A — the deterministic-only skeleton, the
> `master_*_id`-as-mutable-pointer rule, the provenance seam reserved at freeze). **Ground truth:** the planned
> `master_employment` DDL (`03-database-design.md:428-436`), ADR-0021 (the two-layer model), ADR-0015/ADR-0037
> (entity resolution + the `MatchPort` seam), the shipped `matchKeys.ts` normalizers, `dedup.ts`. **No code,
> schema, SQL, or settings are modified — only this file is written.**

---

## 0. What this gate inherits, decides, and must not pre-empt

`RESEARCH_02 §6` already settled the *coarse* question — **an edge, never a single mutable pointer** — with a
unanimous cross-vendor record (PDL `experience[]`, ZoomInfo/Sales-Nav job-change signals, Apollo/Cognism
persistent account nodes; `RESEARCH_02 §1.8`). `BRAINSTORM_00 §5` then fixed the *build envelope*: the edge
**co-lands** with the Layer-0 entity tables as one deterministic-only skeleton on the existing Aurora stack,
`master_*_id` is a **re-pointable pointer** (not a stable identity), and the provenance seam is **reserved at
freeze** but built in Phase 3 (`BRAINSTORM_00 §5.1-5.2`). So this gate does **not** re-litigate "edge vs FK as
the *concept*."

What is genuinely still open — and what this gate decides — is the **internal shape of the edge** and **how it
binds to the overlay**:

1. Is the durable link a flag-and-dates row (SCD2), a fully bi-temporal assertion set, or a *projection* over
   an immutable evidence log? The three are different storage contracts with different correctness and cost.
2. Where does **edge provenance + confidence** physically live — scalar columns on the edge, or a child
   evidence table? (`RESEARCH_02 §5` open Q1.)
3. How do the **two coexisting links** reconcile: the overlay's `contacts.account_id` (workspace account,
   upsert-by-domain, `contacts.ts:98,72-74`) vs `contacts.master_person_id → master_employment →
   master_company_id` with `accounts.master_company_id` bridging (`03-database-design.md:495,518,556`)?

**Explicitly deferred (a later gate owns each):** the field-level *merge/survivorship* engine (U1, Phase 3);
the job-change *signal* surfaced into a revealed overlay (U3, Phase 3); the Splink probabilistic tail and the
billions-scale Citus/OpenSearch/Iceberg topology (the gated SCALE TRACK, `BRAINSTORM_00 §5.1`). This gate
decides the **link's shape**, so those build *into* it without a destructive migration — never around it.

---

## 1. The forces every candidate is judged against

Seven hard cases (the central challenge) and five cross-cutting constraints. Each model in §2 is scored against
these in §3.

| # | Hard case | Why it is hard |
|---|---|---|
| H1 | **Job change without losing history** | The old affiliation must remain queryable; "title changed *within* the same company" (ZoomInfo signal 2) is only expressible if prior `(company,title)` is retained (`RESEARCH_02 §1.2`). |
| H2 | **Multiple concurrent affiliations** | Board seat + operator role; advisor + employee; contractor across two clients. ≥2 affiliations are simultaneously live; exactly one (or zero) should drive the firmographic backfill. |
| H3 | **Ambiguous company match** | Which domain wins for a short/shared name ("Apex"→5 companies); freemail/role domains (`gmail.com`) that are *not* an employer; subsidiary vs parent (`aws.amazon.com` vs `amazon.com`); rebrand/redirect (`fb.com`→`meta.com`) (`RESEARCH_02 §2.4`). |
| H4 | **Company-less prospects** | Founder pre-domain, freelancer, student, stealth, between jobs. The link must represent "no company" distinctly from "company not yet resolved." |
| H5 | **RLS under a shared edge** | The edge is **system-owned, NOT workspace-RLS-scoped** (ADR-0021:33-35), while overlays are FORCE-RLS per workspace (`rls/contacts.sql:28-33`). One canonical edge must serve N workspaces without a `workspace_id` predicate and without leaking. |
| H6 | **Billion-row read paths** | "Person at company with these company traits" must not be a per-row join (N+1 at billions); hot companies (every `@google.com`) create fan-out hotspots (`RESEARCH_02 §4`). |
| H7 | **Provenance + confidence on the edge** | Which source asserted the affiliation, how sure, corroboration count, when learned — the U2 gap the planned DDL omits (`03-database-design.md:432-434` carries no provenance). |

| Cross-cutting constraint | Binding on the edge |
|---|---|
| **Multi-tenant RLS** | No `workspace_id` on the edge; isolation is by **access path** (masked search → paid reveal), enforced by the system/admin role boundary (`client.ts:30,95`), never an RLS predicate. |
| **Per-owner visibility** | Ownership/assignment of the affiliation is **overlay** state (`accounts.owner_user_id/assigned_team_id/visibility`, `03-database-design.md:503-505`), never on the shared edge. |
| **Canonical identity (4-signal)** | Company end resolved by `primary_domain`/PSL (`matchKeys.ts:74-81`) + `linkedin_company_id`; reuse the shipped normalizers — **no second normalizer** (ADR-0037). |
| **Field/edge provenance (U2)** | The undesigned surface: `{source, confidence, observed_at}` per affiliation; design the *seam* now, build the *merge* in Phase 3 (`BRAINSTORM_00 §5.1`). |
| **Scale** | Edge is the largest table in the graph (people × jobs); partial `WHERE is_current` index, Citus-shard by `master_person_id`, denormalized `current_company_id` cache (`03-database-design.md:436,413`). |

---

## 2. The candidate link models

Four **distinct** models, not variations: a pointer (A), a flag-and-dates row (B), a fully temporal assertion
set (C), and a projection over an immutable log (D). A and B are the two the project has actually shipped/planned;
C and D are the unbuilt extremes that the decision must consciously accept or reject.

### Model A — Direct denormalized FK, extended to Layer 0 (the `account_id` pattern, promoted)

> **Thesis.** Keep the link a single FK, just move it up a layer: `master_persons.current_company_id`
> (`03-database-design.md:413`) *is* the link; the person carries `job_title`/`seniority_level`/`department`
> as scalar columns (it already does, `:414-417`); history, if wanted, is a denormalized `previous_company_id`
> or a JSONB `job_history` blob on the person. No edge table. This is the shipped `contacts.account_id` shape
> (`contacts.ts:98`) literally re-used as the master-graph link.

```
  master_persons
    ├─ current_company_id ──▶ master_companies   (the link IS this FK)
    ├─ job_title, seniority_level, department     (scalar, on the person)
    └─ job_history jsonb  (optional denormalized tail: [{company, title, start, end}])
```

- **Strongest argument.** *Zero new structure, fastest read.* The hot query "person at company with traits"
  is a single FK join the search doc already flattens (`RESEARCH_02 §2.5`); there is no fan-out, no
  multi-row aggregation, no "which row is current." It is the cheapest possible thing that satisfies H6, and
  it is *already the code* — `dedup.ts:37-42` and the overlay both think in `(name, current company)` today.
- **The failure mode that kills it.** **It cannot represent H2 at all and corrupts H1.** A person with a
  board seat *and* an operator role has two simultaneous employers; a single `current_company_id` must pick
  one and silently drop the other — the exact limit #2 `RESEARCH_00 §3` indicts. A JSONB `job_history` tail
  is unqueryable at scale (no index on "everyone who left Stripe in Q2"), un-deduplicatable (the same stint
  appears under two sources as two array entries with no merge key), and carries no per-affiliation
  confidence — it reproduces the provenance blindness (H7) one layer up. It is the model **every vendor in
  `RESEARCH_02 §1` abandoned**; promoting it to Layer 0 promotes the bug.
- **Sequences.** Trivial to build, impossible to extend — adding H2/H7 later means introducing the edge table
  anyway *and* backfilling the JSONB tail into it (a destructive migration). It buys a week and costs the
  initiative.

### Model B — SCD2 employment edge (the ADR-0021 shape), provenance as edge columns

> **Thesis.** The planned `master_employment` (`03-database-design.md:428-436`): one row per affiliation,
> `is_current boolean` + `started_on`/`ended_on date` validity range, `UNIQUE(master_person_id,
> master_company_id, started_on)`, partial `idx_employment_current … WHERE is_current`. A job change **closes
> the old row** (`ended_on`, `is_current=false`) and **opens a new one**; `master_persons.current_company_id`
> is a **recomputed cache** of the `is_current` row. Close the U2 gap by adding `source`, `confidence
> numeric(4,3)`, `observed_at` (and a corroboration `source_count`) **as scalar columns on the edge**.

```
  master_persons ──┐
                   │  master_employment (EDGE, 0..N)            ┌──▶ master_companies
                   ├─ master_person_id ─┐                      │     (primary_domain / alt_domains
                   │  master_company_id ─┼──────────────────────┘      / parent_company_id)
                   │  title, department, seniority_level
                   │  is_current, started_on, ended_on          ◀─ SCD2 validity (H1)
                   │  source, confidence, observed_at, source_count  ◀─ U2 provenance columns (H7)
                   └─ current_company_id = recomputed cache of the is_current edge  (H6 read)
  UNIQUE(person, company, started_on)   partial idx WHERE is_current
```

- **Strongest argument.** *It is the cross-vendor consensus shape and the planned target.* It natively
  delivers H1 (closed rows are history), H2 (0..N rows, multiple can be `is_current`), and H4 (zero rows =
  company-less). It reuses the existing two-threshold ER routing for edge acceptance (`match_links.review_status`,
  `03-database-design.md:481-482`) and the shipped domain normalizer (`matchKeys.ts:74-81`). It is `RESEARCH_02
  §6`'s recommendation and `BRAINSTORM_00`'s co-landed skeleton — the path of least architectural surprise.
- **The failure mode that kills it.** **`is_current` + `current_company_id` re-introduce the very
  mutable-pointer staleness the initiative exists to kill — just one layer up.** Two concurrent writers (a job
  change and a re-enrichment of the same person) can leave two rows `is_current=true`, or the cache pointing at
  the loser, with **no immutable record to reconcile against** — because the provenance lives in *mutable scalar
  columns on the same row that the writer overwrites*. When a later source corrects the affiliation, the old
  `source`/`confidence` is gone; the edge cannot be unwound or re-evaluated (the survivorship "record what was
  combined for unwinding" rule, shared ground-truth PROVENANCE, is unmet). Model B *as scalar-columns-only* is a
  prettier `account_id`: it has history of *state* but no history of *assertions*. This is the failure the
  DECISION must repair, not the one that disqualifies B — see §5.
- **Sequences.** Co-lands with the entity tables (the FK forces it, `BRAINSTORM_00 §1`); deterministic-only
  populate; the `confidence`/`source` columns are the reserved provenance seam Phase 3 fills.

### Model C — Bi-temporal affiliation with full assertion history (valid-time × transaction-time)

> **Thesis.** Every affiliation row carries **two** time axes: **valid-time** (`valid_from`/`valid_to` — when
> the person actually held the role) *and* **transaction-time** (`tx_from`/`tx_to` — when *we believed* it).
> A correction never updates a row; it **closes the transaction-time of the old belief and inserts a new one**.
> Provenance (`source`, `confidence`) is on every assertion. The "current truth" is the row where both
> `valid_to` and `tx_to` are open (∞). This is the payroll/audit-grade temporal model (`RESEARCH_02 §2.2`).

```
  master_employment_assertion  (append-only; nothing is ever UPDATEd)
    master_person_id, master_company_id, title, …
    valid_from, valid_to      ◀─ when the role was real
    tx_from,    tx_to         ◀─ when we held this belief  (close + re-insert on correction)
    source, confidence
  "as we know it now"  = WHERE tx_to = 'infinity'  AND valid_to >= today (or NULL)
  "as we knew it on D" = WHERE tx_from <= D < tx_to  AND valid_from <= D < valid_to   (reproducible)
```

- **Strongest argument.** *It is the only model where a retroactive correction is lossless and historical
  queries are reproducible "as we knew it then."* "We learned on Mar-15 that she actually left on Feb-15" is a
  first-class fact, not a destructive overwrite. Provenance is *inherently* preserved because rows are
  immutable — H7 and the unwind/audit requirement are satisfied by construction, not bolted on. For a regulated
  data-broker (ADR-0021 names TruePoint *"squarely a data broker,"* Consequences) reproducible-belief audit is
  not nothing.
- **The failure mode that kills it.** **It is over-engineered for prospecting and roughly doubles every schema
  and query for a property the product does not sell.** A sales-intelligence graph never needs to *reproduce a
  past belief* — it needs "where do they work now" and "did they change jobs." The bi-temporal join discipline
  (two `BETWEEN`s on every read) is a permanent tax on the hottest path (H6) at billions of rows, and the
  four-timestamp grain makes the `UNIQUE` key (already subtle, §5) genuinely hard. `RESEARCH_02 §2.2/§6`
  rejected it explicitly: *"payroll-grade over-engineering for a prospecting graph"* at ~2× cost. The audit
  value it buys is already covered cheaper by an **immutable `source_records` log + one transaction-time field**
  (Model D / the "1.5-temporal" answer).
- **Sequences.** Would *replace* the planned DDL, not extend it — a far larger freeze, and it front-loads
  complexity `BRAINSTORM_00` explicitly deferred. No phase needs it.

### Model D — Edge-as-projection over an immutable assertion log (event-sourced; provenance in the evidence layer)

> **Thesis.** Split the link in two. The **truth** is the already-planned immutable evidence log:
> `source_records` (per-source raw assertions, `content_hash UNIQUE`, `resolved_person_id`/`resolved_company_id`
> set by ER; `03-database-design.md:461-471`) governed by `match_links` (cluster membership + `match_probability`
> + `review_status`; `:473-485`). The **`master_employment` edge is a derived projection** — a materialized,
> survivorship-merged current-state view *recomputed* from the accepted assertions for a `(person, company)`
> pair. The edge is disposable and rebuildable; the log is append-only and authoritative.

```
  source_records  (immutable, append-only — the assertion log; the lineage)
    source_name, content_hash, raw_data, match_keys{email_bi, domain, li_id, phone},
    resolved_person_id, resolved_company_id, ingested_at
        │  (ER accepts/queues/rejects)
        ▼
  match_links  review_status ∈ auto|pending|confirmed|rejected   match_probability
        │  (survivorship projection — recompute on every accepted assertion)
        ▼
  master_employment  (DERIVED edge: is_current, started_on/ended_on, confidence, source_count)
        │
        └─ master_persons.current_company_id  (cache of the cache)
```

- **Strongest argument.** *It is the most TruePoint-native model and it makes Model B correct.* The pipeline
  it requires — immutable source evidence → ER cluster → survivorship-merged golden projection — **is exactly
  the master-graph pipeline ADR-0021/ADR-0015 already specify** (`source_records` + `match_links` already exist
  in the planned DDL, `:461-485`). It dissolves Model B's killer failure: because the edge is a *projection*,
  the `is_current` flag and `current_company_id` cache being momentarily stale is harmless — they are
  reconstructable from the immutable log, and concurrent writers reconcile by *recomputing the projection*, not
  by racing to overwrite scalar columns. Provenance (H7) lives where it belongs — in `source_records` (which
  source, raw payload) + `match_links` (how sure) — answering `RESEARCH_02 §5 Q1` ("columns vs child table")
  with *both*: a thin denormalized projection on the edge for read speed, backed by the log for truth/unwind.
- **The failure mode that kills it.** **The full projection machinery is the deferred SCALE TRACK, not the
  MVP.** Survivorship-merging assertions into a golden edge is the Splink/ER work `BRAINSTORM_00 §5.1` gated to
  M12/M13; building D *fully* now violates the deterministic-only skeleton decision and front-loads the
  longest-lead component (Model B's failure becomes Model B's-via-C problem all over again). Built *naively*
  (recompute the projection synchronously on every assertion) it is an N+1 write-amplification bomb at billions.
  D is correct as the **target architecture** but cannot be the **first build** in isolation.
- **Sequences.** The log half (`source_records`/`match_links`) co-lands with the skeleton (it is in the planned
  DDL); the *projection recompute* is deterministic-only now (one assertion → one edge) and becomes a real
  survivorship merge on the SCALE TRACK. This is precisely `BRAINSTORM_00`'s "design the seam, defer the engine."

### 2.5 Summary

| Model | One-line | Strongest argument | The failure that kills it |
|---|---|---|---|
| **A — direct FK extended** | `current_company_id` + JSONB job tail; no edge | Zero structure, fastest read, *is* the current code | Cannot express H2; JSONB history unqueryable/unmergeable; promotes the abandoned bug |
| **B — SCD2 edge, provenance columns** | `is_current`+dates+`UNIQUE(person,company,started_on)`; `source/confidence` scalar | Consensus shape; the planned target; native H1/H2/H4; reuses ER routing | `is_current`/`current_company_id` are mutable pointers with no immutable record to reconcile against → staleness one layer up; provenance overwritten on correction |
| **C — full bi-temporal** | valid-time × transaction-time; append-only; reproducible belief | Lossless retroactive correction; audit-grade; provenance by construction | ~2× schema/query on the hottest path for a property prospecting never sells; replaces (not extends) the DDL |
| **D — edge as projection over an immutable log** | `source_records`/`match_links` = truth; `master_employment` = derived view | Most TruePoint-native; *makes B correct* (edge rebuildable from log); provenance in the log (answers Q1: both) | Full survivorship projection is the deferred SCALE-TRACK ER; naive recompute = write-amplification at billions |

---

## 3. Stress-test matrix — the seven hard cases × the four models

| Case | A (FK) | B (SCD2 edge) | C (bi-temporal) | D (projection over log) |
|---|---|---|---|---|
| **H1 job change w/o losing history** | **Fails** — overwrites `current_company_id`; JSONB tail is lossy/unqueryable | **Pass** — close old row, open new; history is queryable rows | **Pass+** — history *and* "as we knew it" reproducible | **Pass** — every assertion retained in the log; projection re-derives current |
| **H2 concurrent affiliations** | **Fails** — one pointer, drops the second | **Pass** — N rows, ≥1 `is_current`; needs a *primary* tiebreak (Q3) | **Pass** — N open `valid_to`; same tiebreak need | **Pass** — N accepted clusters; primary chosen at projection time |
| **H3 ambiguous company** | Binds the wrong domain silently (no review state) | Review via `match_links.review_status` before the edge materializes (`:481`) | Same routing, on the assertion | **Best** — ambiguity is a `pending` `match_link`; *no edge* until confirmed; freemail → no `resolved_company_id` |
| **H4 company-less** | `current_company_id` NULL, but conflates "none" vs "unresolved" | **Pass** — zero edges = company-less; a `pending` edge = unresolved (distinct) | Pass | **Best** — zero accepted clusters = company-less; `source_record` with null `resolved_company_id` = unresolved |
| **H5 RLS under shared edge** | Edge is one FK; same Layer-0/no-`workspace_id` rule applies | **Pass** — Layer-0 system-owned, access-path isolation (ADR-0021:33-35) | Pass (more rows, same rule) | **Pass** — log + edge both Layer-0; overlay reads neither directly |
| **H6 billion-row read** | **Best** — single FK, no fan-out | **Pass** — partial `WHERE is_current` index + `current_company_id` cache (`:436,413`) | **Worst** — two `BETWEEN`s per read, permanent tax | **Pass** — reads hit the *projection* (= B's read path); log is cold/offline |
| **H7 provenance on edge** | **Fails** — none | Partial — scalar columns, but overwritten on correction (no unwind) | **Pass** — immutable by construction | **Best** — `source_records` raw + `source_count` + `match_links.match_probability`; unwindable |

**What the matrix shows.** No single pure model wins every case. **A** wins only H6 and loses the structural
cases (H2/H7) the initiative exists to fix. **C** wins the provenance/audit cases but loses the hot read path
(H6) it would tax forever. **B** and **D** each pass all seven — but they pass them *differently*: **B** is the
right **read/storage grain** (SCD2 rows, indexed, cache-backed — H1/H2/H4/H6), while **D** is the right
**truth/provenance grain** (immutable log, review-gated, unwindable — H3/H7 and the unwind requirement B fails).
They are not competitors; **B is the projection D produces.** The hardest cases below make this concrete.

### 3.1 Job change without losing history (H1) — and why the *cache* is the real risk

SCD2 (B/D) answers H1 by construction: a move is *close-old + open-new*, not an overwrite. The danger is not the
edge rows — it is the **`current_company_id` denormalization** (`03-database-design.md:413`). `RESEARCH_02 §4`
already named this *"the single most expensive correctness bug here"*: every job change must atomically (a) close
the old edge, (b) open the new edge, (c) recompute the cache, (d) emit a job-change signal, idempotent on
`source_records.content_hash` (`:464`). In **Model B** (c) races every concurrent writer with nothing immutable
to fall back to; in **Model D** (c) is a pure *recompute from the log* — if it lags, the next recompute fixes it,
and the log is the tie-breaker. This is the decisive reason the DECISION takes B's *grain* but D's *derivation
discipline*: **the cache must be a derived projection, never an independently writable field** (`RESEARCH_02 §2.5`).

### 3.2 Multiple concurrent affiliations (H2) — the *primary* tiebreak

B/C/D all hold N live rows; none of them, as planned, says **which one drives `current_company_id`** when two are
`is_current` (advisor + day job; board seat + operator). PDL's answer is an explicit `is_primary` flag chosen by
the pipeline (`RESEARCH_02 §1.1`). The planned DDL has *no* primary-selection rule (`:413,433`). The candidate
rule (carried as an open question, not decided here): **the email-domain-matched affiliation wins** — if the
person's primary `master_emails.email_domain` (`:443`) resolves to one of the companies, that edge is primary;
else the highest-`confidence`/most-recent `started_on` edge. This reuses the strongest company key
(`matchKeys.ts:74-81`) rather than inventing a heuristic. Note H2 also stresses the `UNIQUE` key — see §5.

### 3.3 Ambiguous company match (H3) — where Model D pulls ahead

The domain→company hazards (`RESEARCH_02 §2.4`) are *resolution-state* problems, and Model D models resolution
state natively: an ambiguous bind is a `match_links` row with `review_status='pending'` and **no
`master_employment` edge materializes until it confirms** (`:481`). Concretely:

- **Freemail/role domains** (`gmail.com`, `info@`): the assertion's `resolved_company_id` stays NULL → no edge →
  the person is *company-less for that signal* (H4), never bound to a fake "Gmail Inc." A **freemail/role-domain
  blocklist** (open Q4, `RESEARCH_02 §5`) gates this at `match_keys` extraction, reusing `registrableDomain`
  (`matchKeys.ts:74-81`) — it must yield *no domain key*, not a wrong one.
- **Short/shared name** ("Apex"): below the high cutoff → `pending` → clerical review queue, never auto-bound
  (Clearbit's traffic-tiebreak is a heuristic, not truth, `RESEARCH_02 §2.4`).
- **Subsidiary vs parent / rebrand**: `parent_company_id` hierarchy + `alt_domains[]` keep them distinct-but-linked
  (`03-database-design.md:393,397`) — the edge points at the resolved leaf; the hierarchy answers "rolls up to."

In **Model B without the log**, the same ambiguity has nowhere to *sit* between "asserted" and "accepted" except
a `review_status` column on the edge itself — which means a half-resolved edge row exists and must be filtered out
of every read (a fail-open risk). D's "ambiguity is a pending `match_link`, not a tentative edge" is cleaner.

### 3.4 Company-less prospects (H4)

The edge being `0..N` (B/C/D) makes this native: **zero edges = company-less** (founder/freelancer/student/stealth);
`current_company_id` NULL; firmographic facets absent; `master_persons.has_email/has_phone` still apply
(`:418-419`). The model must keep three states **distinct**, which Model A cannot: (i) *no company* (zero accepted
assertions), (ii) *company not yet resolved* (a `source_record` with null `resolved_company_id` or a `pending`
match_link), (iii) *name-only company, no domain* (a low-confidence `name_normalized` assertion, `:395`, held in
review — never auto-bound). Conflating (i) and (ii) is exactly the degenerate-FK defect (`RESEARCH_02 §2.6`).

### 3.5 RLS under a shared canonical edge (H5) — the structural crux

This is the constraint no external vendor faces and the one §0 flagged. The edge (and, in D, the log behind it)
is **Layer-0 system-owned with no `workspace_id`** (ADR-0021:33-35,39-40). The overlay is FORCE-RLS per workspace
(`rls/contacts.sql:28-33`, `NULLIF(...,'')` fail-closed). The reconciliation (full treatment in §4):

```
  Layer 0 (system-owned, NO RLS)                     Layer 1 (per-workspace, FORCE RLS on workspace_id)
  master_persons ─ master_employment ─ master_companies
        ▲                    ▲                    ▲
        │ master_person_id   │ (edge is read only │ master_company_id
        │ (soft FK)          │  by access path)   │
        │                    │                    │
  contacts.master_person_id  └── reveal copies ──▶ contacts.account_id ──▶ accounts.master_company_id
        └─ workspace_id = current_setting('app.current_workspace_id')   ◀─ the only wall a workspace sees
  Access to the edge:  masked search (returns IDs) → paid reveal → COPIES a point-in-time snapshot into overlay
```

The edge is reachable only via the audited system/admin path (`withPrivilegedTx`/`withPlatformTx`,
`client.ts:30,95`) and the masked-search→reveal product flow; a workspace transaction (`withTenantTx`,
`client.ts:48-68`) under `leadwolf_app` can **never** address it. Putting a `workspace_id` on the edge to "make
RLS work" is the rejected anti-pattern — it would shatter the dedup-once promise into N per-tenant edges
(`RESEARCH_02 §4`, Reject #3). All of B/C/D satisfy H5 identically; **A** does too, but only because its single
FK is degenerate. H5 does **not** discriminate between B, C, D — it discriminates against any model that wants
the edge to be tenant-scoped.

### 3.6 Billion-row read paths (H6)

The read contract is "person at company with traits in one query" → the flattened search doc (ADR-0035), backed
by the partial `idx_employment_current … WHERE is_current` (`:436`) and the `current_company_id` cache (`:413,426`),
Citus-sharded by `master_person_id` (`RESEARCH_02 §4`). **B and D share this read path** (D *reads* its projection,
which is a B-shaped edge); **C taxes it** with two temporal `BETWEEN`s forever; **A** is fastest but answers the
wrong question (it cannot express H2 so its "one query" is a lie for dual-role people). Hot-company fan-out (every
`@google.com` person) is bounded by querying *person→current edge* (1 row via the partial index), never
*company→all people* on the OLTP path (that is a search/facet query, ClickHouse, not an OLTP join). The
billion-row case therefore **endorses B's grain and rejects C's**, and is neutral B-vs-D on read.

### 3.7 Provenance + confidence on the edge (H7) — columns vs child table, resolved

`RESEARCH_02 §5 Q1` posed it as either/or: scalar columns on `master_employment` **or** a child
`employment_evidence` table mirroring `match_links→source_records`. The stress test shows it is **both, at two
grains**:

- **The immutable assertion grain** already exists: `source_records` (raw payload, `content_hash`, which
  `source_name`, `resolved_*_id`; `:461-471`) + `match_links` (`match_probability`, `review_status`, `:473-485`).
  This is Model D's log; it is *where corroboration and unwind live* (`source_count` = how many source_records
  agree; the survivorship-input the shared ground-truth PROVENANCE section requires).
- **The denormalized projection grain** is a *thin* set of columns on the edge — `confidence`, `source_count`,
  `observed_at`/`last_verified` — so the hot read (H6) never joins the log. These are a **derived cache** of the
  log, recomputed with the edge, never hand-set (the §3.1 discipline).

Model B-alone (columns only) loses the unwind; Model C (immutable rows) gets it but at 2× cost; **Model D gives
both at the right grains** — the log is the truth, the edge columns are the cache. This is the decisive H7 finding.

---

## 4. Reconciling the two coexisting links (the overlay tension)

The sharpest practical question: a contact now has **two** company links, and they must not fight.

```
  OVERLAY (per-workspace, RLS)                         LAYER 0 (system-owned)
  contacts.account_id ───────▶ accounts                master_persons
    (workspace company,          ├─ master_company_id ────────────────┐ (overlay→golden bridge, :495,511)
     upsert-by-domain,           └─ (workspace-private:                │
     :98, :72-74)                    owner, visibility, icp_fit)       ▼
  contacts.master_person_id ──────────────────────────▶ master_persons ─ master_employment ─ master_companies
    (overlay→golden bridge, :518,556)                                          (the shared edge — Layer 0)
```

Three facts resolve the tension:

1. **`contacts.account_id` is a workspace *snapshot*, not a competing source of truth.** It is the workspace's
   curated company (upsert-by-domain, unique `(workspace_id, domain)`, `contacts.ts:72-74`) — the thing the user
   put the contact under, owns, assigns, and scores. A **reveal copies a point-in-time snapshot** of the
   currently-resolved company/title from the edge into `account_id`/`job_title` (the existing reveal-copies-value
   mechanic, ADR-0021:48-51). After reveal, the overlay snapshot is *frozen by ownership*; the Layer-0 edge keeps
   evolving. **A later Layer-0 job change does NOT rewrite `account_id`** — that would violate "user-owned values
   are not silently overwritten" (ADR-0015 survivorship). It surfaces as a **job-change signal** (U3, Phase 3,
   the ZoomInfo/Sales-Nav model) the workspace may act on. This gate only *reserves* that seam; Phase 3 designs it.

2. **`accounts.master_company_id` and `contacts.master_person_id` are the bridges, nullable only for in-flight
   staging** (ADR-0021:63-65). They are how the overlay snapshot is *traceable back* to the shared identity — so a
   re-reveal, a deletion cascade, or a "this account is really Stripe" reconciliation can find the golden node.
   They are the re-pointable pointers `BRAINSTORM_00 §5` mandates: when the deferred ER merges two master companies,
   `accounts.master_company_id` re-points; `accounts.account_id`/`domain` (the workspace's own key) does **not**.

3. **The overlay does NOT get its own employment edge table.** The affiliation *history* lives once, at Layer 0.
   The overlay's `account_id` is the single current company the workspace cares about; it does not need
   `started_on`/`ended_on` (it is not curating the person's career, only "who is this prospect, at which account,
   for my pipeline"). If a workspace genuinely needs per-contact role history, that is read **by access path** from
   the shared edge at reveal/refresh time — never duplicated into N per-workspace SCD2 tables (which would
   re-fragment the universe ADR-0021 unifies). **This is a consequence the PLAN must state explicitly**, because
   the naive instinct ("mirror master_employment into the overlay") is the exact dedup-defeating mistake.

**DSAR note.** Erasure is keyed on the golden identity (`email_blind_index`, `:442`) and cascades *through* the
edge: `master_employment.master_person_id ON DELETE CASCADE` (`:430`) drops the affiliations; the overlay copies
tombstone (`contacts.deleted_at` + PII null, `contacts.ts:147`); a GLOBAL suppression row blocks re-import
(`list-plan/02-data-model.md:307-329`). The edge is *in* the blast radius — Model D's log (`source_records`) is too,
which is why D's append-only log must itself honour the erasure cascade (a real obligation the PLAN inherits).

---

## 5. Challenging the obvious default (Model B, the planned edge table)

The obvious choice — reinforced by the planned DDL and `RESEARCH_02 §6`'s recommendation — is **"just build
`master_employment` as written (Model B) and add provenance columns."** It is right enough to be dangerous, and it
must be challenged head-on.

**Prong 1 — B-as-written re-introduces the mutable-pointer disease it was meant to cure.** `is_current boolean`
and the `current_company_id` cache are *mutable state with no immutable backing*. The whole indictment of
`contacts.account_id` (`RESEARCH_00 §3`) was "a single mutable current pointer with no history and no provenance."
B keeps the *rows* immutable-ish but makes the **current-selection** and the **provenance columns** mutable and
overwrite-on-correction. Under two concurrent writers (a job-change worker and a re-enrichment worker on the same
person) you can land two `is_current=true` rows or a cache pointing at the closed row, and — critically — **no
record of what the provenance *was*** before the overwrite. The unwind/audit requirement (shared ground-truth
PROVENANCE: *"merges are reversible/audited… record what was combined for unwinding"*) is unmet. B alone is a
better `account_id`, not a different category.

**Prong 2 — B's `UNIQUE(master_person_id, master_company_id, started_on)` has concrete holes (`:434`).** `started_on`
is `date` and **nullable** (the DDL sets no `NOT NULL`, `:433`). In Postgres, NULLs are distinct in a UNIQUE index,
so **two edges with NULL `started_on` for the same person+company do not collide** — the constraint silently
permits duplicate affiliations exactly in the company-less/unknown-start case (H4) that is most common for sparse
imported rows. Worse, it cannot represent a **boomerang** (rehired by the same company with the *same* recorded
start) or two **concurrent roles at the same company** (advisor→board with overlapping unknown dates, H2) without a
collision-or-loss. The "obvious" constraint is under-specified; the PLAN must decide a real edge identity (a
surrogate `id` always exists, `:429`, but the *dedup* key needs `COALESCE(started_on, ...)` or a `role`/`source`
discriminator — an open question, §7).

**Prong 3 — provenance-as-scalar-columns answers `RESEARCH_02 §5 Q1` with the *worse* half.** Q1 asked "columns on
the edge vs a child evidence table." Columns-only cannot hold *corroboration* (N sources agreeing is `source_count`
arithmetic with no record of *which* N), cannot *unwind* a bad merge, and cannot route the gray-zone bind through
review without a half-resolved edge existing. The child-table half **already exists in the planned DDL** as
`source_records`+`match_links` (`:461-485`) — the evidence layer Model D names. Not using it is leaving the right
tool in the box.

**Conclusion of the challenge.** Model B is the correct **grain and read path** but is **incomplete as a source of
truth**. The fix is not to reject B — it is to recognize that **B is the projection of D**: keep B's SCD2 edge and
its denormalized `confidence`/`source_count`/`observed_at` *as a cache*, and make `source_records`+`match_links`
(D's log) the *truth* the cache is derived from. C is rejected outright (its bi-temporal tax buys reproducible-belief
audit the product does not sell, `RESEARCH_02 §2.2`); the single useful thing C offered — a transaction-time field —
is absorbed as the cheap `observed_at`/`last_verified` on the edge (the "1.5-temporal" answer, `RESEARCH_02 §6.2`).

---

## 6. DECISION

**Direction chosen: Model B's SCD2 employment edge as the durable, read-optimized grain — defined as a derived
projection over Model D's already-planned immutable assertion log (`source_records` + `match_links`), with C
rejected except for its one cheap transaction-time field.** In one sentence: **the person↔company link is the
planned `master_employment` SCD2 edge (`is_current` + `started_on`/`ended_on` + a real dedup identity), carrying a
*thin denormalized* `{confidence, source_count, observed_at}` provenance cache and a recomputed
`master_persons.current_company_id`, where the edge and its cache are a *derived projection* of the immutable
`source_records`→`match_links` evidence log (the truth/unwind layer), populated deterministically-only in the
skeleton and re-derived by the full survivorship ER on the gated SCALE TRACK.**

Concretely, the direction that proceeds to the PLAN:

1. **Grain = SCD2 edge (B), not a pointer (A) and not bi-temporal (C).** One row per affiliation; close-old +
   open-new on change; `0..N` per person (native H1/H2/H4); partial `WHERE is_current` index + Citus shard by
   `master_person_id` for H6 (`03-database-design.md:436`).
2. **Truth = the immutable log (D), reusing what is already planned.** `source_records` (raw assertion, lineage,
   `content_hash` idempotency) + `match_links` (`match_probability`, `review_status` auto/pending/rejected) are the
   authoritative, unwindable, review-gated layer (`:461-485`). The edge is a **recomputed projection** of accepted
   assertions — disposable, rebuildable, concurrency-safe-by-recompute (kills B's §5 Prong-1 failure).
3. **Provenance at two grains (resolves Q1 = both).** Corroboration/unwind in the log; a *thin* derived
   `{confidence, source_count, observed_at/last_verified}` cache on the edge for the hot read (never hand-set;
   recomputed with the edge). This is the reserved U2 seam `BRAINSTORM_00 §5.1` mandates — designed now, the merge
   engine built in Phase 3.
4. **Edge acceptance routes through the *existing* two-threshold ER machinery, not a new edge `review_status`.**
   Auto-accept ≥ high cutoff → materialize the edge; gray zone → `match_links.review_status='pending'`, *no edge
   yet*; reject below (ADR-0015; `:481-482`). Ambiguous/freemail/short-name binds (H3) sit in the log as pending,
   never as a half-resolved edge.
5. **Domain→company via the shipped PSL normalizer, freemail blocklist yields no edge.** Reuse
   `registrableDomain` (`matchKeys.ts:74-81`) — no second normalizer (ADR-0037); `primary_domain` keyed,
   `alt_domains[]`/`parent_company_id` for redirects/hierarchy (`:393,397`); freemail/role domains → no company
   key → company-less, not a fake node.
6. **Layer-0 system-owned; overlay binds by snapshot + bridge.** No `workspace_id` on the edge or the log (H5);
   `contacts.account_id` is the workspace's frozen reveal snapshot; `contacts.master_person_id` /
   `accounts.master_company_id` are the nullable, re-pointable bridges; a Layer-0 job change surfaces as a *signal*
   (U3, Phase 3), never an overlay overwrite; the overlay gets **no** mirrored employment table (§4.3).

**What this DECISION explicitly rejects:**

- **Model A (direct FK extended) as the link model.** It cannot express concurrent affiliations (H2), its JSONB
  history is unqueryable/unmergeable, and it carries no provenance — the abandoned pattern `RESEARCH_02 §1.8`
  indicts. It survives *only* as `contacts.account_id`, the overlay reveal snapshot — never as the link's truth.
- **Model C (full bi-temporal) entirely** except its single transaction-time field. The valid-time × tx-time
  grain is ~2× cost on the hottest path for reproducible-belief audit prospecting does not sell
  (`RESEARCH_02 §2.2/§6`). Its useful kernel is absorbed as `observed_at`/`last_verified` on the edge.
- **Model B *alone* (scalar provenance, no log).** It re-introduces mutable-pointer staleness one layer up and
  loses unwind/corroboration (§5 Prongs 1+3). B is adopted *only as the projection of D*.
- **Building Model D's full survivorship projection now.** The probabilistic merge is the deferred SCALE TRACK
  (`BRAINSTORM_00 §5.1`); the skeleton recomputes the projection *deterministically* (one accepted assertion → one
  edge) and the real survivorship merge lands on the gated track — design the seam, defer the engine.
- **A `workspace_id`-scoped edge or a per-workspace mirror of `master_employment`.** Either re-fragments the
  universe ADR-0021 unifies and bleeds RLS into the shared graph (H5; §4.3).

> **Implementation status.** None of this exists in code: Layer 0 is 100% docs (`BRAINSTORM_00 §5.1` note); the
> only `master_person_id` in the codebase is the FK-less soft column on `enrichment_job_rows`
> (`RESEARCH_00 §2`); the overlay carries no `master_*_id`; the live link is the degenerate `contacts.account_id`
> (`contacts.ts:98`). The DECISION is therefore all work-to-do. The "reject D's full projection now" line is
> **deferral, not omission** — the deterministic skeleton is the bridge *toward* the survivorship projection, and
> the mint-then-merge re-point debt (`BRAINSTORM_00 §6 Q1`) is the obligation it carries, never a license to skip it.

---

## 7. Open questions carried into the PLAN

The direction is well-formed but hands six concrete questions to the Phase-2 PLAN gate (distinct from
`BRAINSTORM_00 §6`'s skeleton-wide questions; these are *edge-specific*).

1. **The edge's real dedup identity (the §5 Prong-2 hole).** `UNIQUE(master_person_id, master_company_id,
   started_on)` (`:434`) is unsafe with nullable `started_on` (NULLs don't collide) and cannot represent
   boomerang/concurrent same-company roles. **Q:** make `started_on` `NOT NULL DEFAULT` a sentinel, key on
   `COALESCE(started_on, 'epoch')`, or add a `role`/`source` discriminator to the key? What *is* the affiliation
   identity for H2/H4?
2. **Provenance reservation — the minimum that keeps Phase 3 additive.** The DECISION reserves thin
   `{confidence, source_count, observed_at}` columns + leans on `source_records`/`match_links`. **Q:** is that the
   exact reserved set, and does the edge also need a denormalized `review_status`/`is_provisional` flag to filter
   pending binds out of reads, or is "pending lives only in `match_links`, the edge never materializes early"
   sufficient? (Answers `RESEARCH_02 §5 Q1/Q5` precisely.)
3. **The multi-affiliation *primary* tiebreak (H2, §3.2).** Which of ≥2 `is_current` edges sets
   `current_company_id`? **Q:** ratify "email-domain-matched edge wins, else highest-confidence/most-recent
   `started_on`" — and does `is_current` become a partial-unique-per-person constraint or stay an unconstrained flag
   with a separate `is_primary`?
4. **Freemail/role-domain blocklist (H3, `RESEARCH_02 §5 Q4`).** **Q:** source-of-truth list (config vs a
   PSL-private section) and where it gates — at `match_keys` extraction in `matchKeys.ts` (so no domain key is ever
   produced) or at edge materialization?
5. **The deterministic projection recompute (the D-half made cheap).** Skeleton-era, "accepted assertion → edge" is
   1:1, but even then a second source for the same `(person, company)` must merge into the existing edge, not
   duplicate it. **Q:** is the recompute synchronous in the import tx (idempotent on `content_hash`, `:464`) or an
   async sweep, and what is the write-amplification bound at import scale (the H6 write-side)?
6. **The cache-staleness contract (§3.1).** `current_company_id` + flattened search docs must converge after a job
   change. **Q:** does the close-old/open-new/recompute-cache/emit-signal run as one atomic tx, and what is the
   acceptable cache-lag SLO before the search doc is allowed to serve a person at the wrong company (the
   eventual-consistency boundary, `RESEARCH_05`/ADR-0035)?
