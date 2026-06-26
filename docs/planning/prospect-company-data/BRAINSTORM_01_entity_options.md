# BRAINSTORM 01 — Canonical-Entity Model Options for Golden Person + Company

> **Gate:** BRAINSTORM · **Phase:** 1 — Canonical Entity Model · **Depends on:**
> [RESEARCH_01_entity_modeling.md](./RESEARCH_01_entity_modeling.md) (the survey + recommendation this
> stress-tests), [RESEARCH_00_current_state.md](./RESEARCH_00_current_state.md) (what's built),
> [RESEARCH_03_mdm_merge.md](./RESEARCH_03_mdm_merge.md) (survivorship) and
> [RESEARCH_07_migration.md](./RESEARCH_07_migration.md) (rebuild/backfill cost). **Anchors:**
> [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md), [03 §5.1](../03-database-design.md)
> (the Layer-0 DDL), [06 §9](../06-enrichment-engine.md) (the ER pipeline). **Feeds:** the Phase-1 PLAN and
> Phase-3 (field-level provenance). This doc generates and stress-tests options and **ends in a DECISION**; it
> writes no schema and no plan.

---

## 0. What this gate decides, and against what

RESEARCH_01 already *recommended* an event-sourced, layered model. This gate's job is the adversarial one:
put that recommendation next to the genuinely different shapes it beat **on paper**, drive each one into the
hard cases until it breaks, and challenge the obvious choice **explicitly** before it proceeds to a plan. The
output is a single committed direction plus the open questions it carries — not a design.

**Decision criteria.** Every approach is scored against six stress axes (the hard cases named in the task) and
five cross-cutting constraints (the brief's invariants). The axes:

| # | Stress axis | Why it's decisive |
|---|---|---|
| S1 | **Billions-row resolution + rebuild cost** | The golden store is the hot OLTP + search-projection surface; a model that re-versions or re-parses on every change dies at 10× ([03 §12:722–738](../03-database-design.md)). |
| S2 | **RLS under a shared canonical** | Layer 0 is **system-owned**, no `workspace_id` predicate; isolation is by access path, not RLS ([ADR-0021:33–35](../decisions/ADR-0021-global-master-graph-and-overlay.md), [03 §9:698](../03-database-design.md)). A model that needs a per-workspace column on the golden row is disqualified. |
| S3 | **Company-less persons** | `master_employment.master_company_id` is `NOT NULL` ([03:431](../03-database-design.md)); a freelancer / unemployed / free-mail-only person has **no edge** and **no company key** — the model must resolve and store them anyway. |
| S4 | **Source corroboration (`source_count`)** | Survivorship is "most-recent × most-corroborated × highest-trust" ([06 §9:315](../06-enrichment-engine.md)); the model must count *how many distinct sources agree* per value, cheaply. |
| S5 | **DSAR purge provability** | Erasure is a platform fan-out keyed on `email_blind_index`; the golden identity (not the copy) is the unit of deletion ([ADR-0021:87](../decisions/ADR-0021-global-master-graph-and-overlay.md), [list-plan/02 §5.2](../list-plan/02-data-model.md)). The model must make "where did this value come from, and is it now gone everywhere" answerable. |
| S6 | **Reversibility / unmerge** | "`source_records` keeps every merge **reversible**" ([06 §9:319](../06-enrichment-engine.md)); a false merge (target ≤0.5%, [the brief]) must be undoable **at the granularity it was made**. |

**Cross-cutting constraints (a hard fail on any one disqualifies the approach):** (C1) Layer-0 system-owned,
no `tenant_id`/`workspace_id`/`owner`/`visibility` on any canonical or provenance table; (C2) per-owner
visibility stays Layer-1; (C3) build on the 4-signal identity hierarchy + `primary_domain` company key, don't
reinvent; (C4) field-level provenance (source/confidence/timestamp per field) must be reachable without a
later destructive migration; (C5) scale — billions of rows, N+1 and unbounded fan-out are failures.

---

## 1. The candidate approaches

Four *distinct shapes* (not parameter variations of one). They differ on the load-bearing question: **what is
the system of record, and at what granularity does provenance live** — the inline golden row (A), a
per-source-payload episode log (B), a bitemporal per-attribute version table (C), or a normalized per-cell
assertion ledger (D).

### Approach A — Self-describing golden row: per-field provenance embedded inline

The golden `master_persons` / `master_companies` row **is** the system of record. Each substantive attribute
carries its provenance as sibling columns or a single JSONB provenance map; there is no separate immutable log
that outranks the row.

```
master_persons (authoritative)
┌───────────────────────────────────────────────────────────────────────┐
│ id, full_name, job_title, current_company_id, seniority_level, …        │
│ provenance jsonb  =  {                                                   │
│    "job_title":  {src:"zoominfo", conf:0.91, observed_at:…, src_count:3, │
│                    pinned:false},                                        │
│    "full_name":  {src:"linkedin", conf:0.99, observed_at:…, src_count:7},│
│    "email[0]":   {src:"apollo",   conf:0.88, observed_at:…, src_count:2} │
│ }                                                                        │
└───────────────────────────────────────────────────────────────────────┘
   write path: ER resolves → app reads provenance map → per-field survivorship
   compare(incoming, current) → if incoming wins, overwrite value + its provenance cell
```

- **Flow.** A new observation resolves to an entity; the writer reads the current value + its provenance cell,
  applies the survivorship cascade ([06 §9:315](../06-enrichment-engine.md), `waterfall.ts` trust order lifted
  to the golden layer), and either overwrites the cell or bumps its `src_count`. No replay; the current state
  is always materialized in place.
- **Strongest argument.** **One row, one read, zero joins** to get value *and* its provenance — the search
  projection and the reveal path both read exactly what they show, and field-level provenance (C4) is satisfied
  *by construction* with no sidecar to design later. It is the lowest-latency read of the four.
- **The failure mode that kills it: irreversibility + write contention at billions (S6, S1).** Overwrite-in-place
  destroys the prior value, so a false merge or a bad provider write is **not reversible** — you cannot unmerge
  what you overwrote (fails S6, which [06 §9:319](../06-enrichment-engine.md) makes mandatory). The provenance
  JSONB also turns every field update into a **full-row rewrite of a wide jsonb column** on the hottest table in
  the system; at billions of rows with continuous "living-network" updates (Apollo-style, RESEARCH_01 §A.2) this
  is write-amplification and TOAST churn on the OLTP/search-projection surface (fails S1). And it keeps only the
  *winning* source per cell, not *all* sources, so `source_count` is a stored integer that cannot be
  recomputed or audited when a duplicate source re-arrives (S4 is brittle). **Rejected as the system of
  record** — but its read shape is exactly what the projection should *expose* (see Decision).

### Approach B — Event-sourced episode log + survivorship-projected golden (the ADR-0021 shape)

The immutable, append-only **`source_records`** table (one row per source *payload*, `content_hash`-idempotent)
is the system of record; `master_*` are a **lean current-state projection** rebuilt by ER + survivorship;
`match_links` records which source records form which golden cluster and the survivor link on merge. This is
exactly [03 §5.1:461–486](../03-database-design.md) + [ADR-0021:41–43](../decisions/ADR-0021-global-master-graph-and-overlay.md)
and the RESEARCH_01 recommendation.

```
source_records (immutable, the LOG)        match_links (ER output)         master_* (projection)
┌──────────────────────────┐  determ.keys ┌─────────────────────┐ surviv. ┌────────────────────┐
│ content_hash UQ          │─────────────►│ cluster_id          │────────►│ master_persons      │
│ raw_data jsonb (payload) │  +blocking   │ source_record_id    │         │ master_companies    │
│ match_keys jsonb         │  +Splink     │ match_probability   │         │ master_employment   │
│ resolved_person_id       │              │ is_duplicate_of     │         │ master_emails/phones│
│ ingested_at (partition)  │              │ review_status       │         │ (one lean row each) │
└──────────────────────────┘              └─────────────────────┘         └────────────────────┘
   history & time-travel = replay the log up to a timestamp; golden rows stay un-versioned
```

- **Strongest argument.** **Truth and history live in cold, append-only, lake-friendly storage; the golden row
  stays lean and hot.** Reversibility (S6) is real because the raw evidence is never destroyed —
  `match_links.is_duplicate_of` plus the surviving `source_records` let you split a cluster and re-project.
  DSAR (S5) is provable: one `email_blind_index` finds the golden identity, the log shows every source that ever
  asserted it. It is the only approach whose storage cost scales by *pushing history to S3/Iceberg partitioned by
  `ingested_at`* ([03:470,737](../03-database-design.md)) while the OLTP golden stays one row per entity. It is
  also already the accepted decision — lowest design risk.
- **The failure mode that *threatens* it: provenance granularity is the source payload, not the field.**
  `source_records` is **per-payload** and `match_links` is **per-(cluster, source_record)** — neither is
  per-field. So "which source gave *this* `job_title`, with what confidence, as of when, corroborated by how
  many sources" is answerable only by **re-parsing every `raw_data` jsonb in the cluster on demand** (an
  unbounded fan-out read at billions — fails C4/S4 as written), and unmerge is **whole-cluster**, not per-cell
  (you can split a person back into two, but you cannot reverse a single bad field-level survivorship pick).
  This is the gap RESEARCH_01 flagged as "reserve the seam, build it Phase 3" — i.e. **pure B is structurally
  incomplete for the field-provenance mandate** and needs a per-field layer bolted on. §3 challenges this head-on.

### Approach C — Full bi-temporal master; golden as a current-state view

Every golden *attribute* (or the whole row) is versioned on **two time axes** — valid-time (`valid_from`/
`valid_to`, when the fact is true in the world) and transaction-time (`tx_from`/`tx_to`, when we believed it)
— per the bitemporal/SCD2 literature (RESEARCH_01 §B.2/B.3). The "golden record" is not stored; it is the view
`WHERE tx_to = 'infinity' AND valid_from <= now() < valid_to`.

```
master_person_attr_versions (the store of record — bitemporal)
┌──────────────────────────────────────────────────────────────────────────────┐
│ master_person_id, attr ('job_title'), value, source, confidence,              │
│ valid_from, valid_to,  tx_from, tx_to                                          │
│  …a job change closes the old (valid_to=date) and inserts a new version        │
│  …a correction closes the old (tx_to=now()) and inserts a new tx-version       │
└──────────────────────────────────────────────────────────────────────────────┘
   golden = SELECT DISTINCT ON (attr) … WHERE tx_to='infinity' AND now() ∈ [valid_from,valid_to)
```

- **Strongest argument.** **Maximal correctness and native time-travel on every attribute.** You can ask "what
  did we believe Jane's title was, as of last March" and "what was actually true then" independently — both
  axes, no log replay. Job-change history (Apollo, RESEARCH_01 §A.2) and "user correction supersedes provider
  guess" are *both just new versions*; nothing is overwritten, so reversibility (S6) is intrinsic and per-field.
- **The failure mode that kills it: blanket bitemporality is a write-amplification and read-complexity
  non-starter at billions (S1).** Every firmographic tick, every re-verification, every corroboration writes a
  new version row; the version table grows without bound on the OLTP surface, and **every** "current value" read
  — including the search projection and the reveal path — pays a `DISTINCT ON` + double-interval predicate
  instead of a single-row lookup. Two interval pairs × every attribute × billions of entities × continuous
  updates is exactly the cost RESEARCH_01 §C.3 rejected as a *blanket* policy. It also answers `source_count`
  (S4) only by counting version rows, conflating "re-observed by the same source" with "corroborated by a new
  source" unless source identity is carried — at which point it has reinvented the assertion ledger (D) with
  heavier machinery. **Rejected as a blanket model**; valid-time is kept *selectively* where the domain is
  genuinely temporal (the employment edge + channel status — see Decision).

### Approach D — Cell-level assertion ledger; golden as a survivorship rollup

A single normalized **`field_assertion`** table is the unit of record: one row per *(entity, field, value,
source)* observation, each carrying its own provenance and time. There is no raw-payload log as the primary
store (raw payloads may still be archived in the lake for replay/audit, but ER consumes *extracted assertions*).
The golden value per field is a **materialized rollup** — one winning assertion per `(entity, field)` chosen by
the survivorship cascade.

```
field_assertion (the cell-level system of record)
┌───────────────────────────────────────────────────────────────────────────────┐
│ id, entity_type('person'|'company'), entity_id, field ('job_title'),            │
│ value_norm, value_enc?(PII), source_name, source_record_id→(lake/log),          │
│ confidence numeric(4,3), observed_at (valid-time), ingested_at (tx-time),       │
│ is_user_pinned bool, superseded_by uuid                                         │
└───────────────────────────────────────────────────────────────────────────────┘
   golden_person (rollup) = argmax_survivorship over assertions per (entity_id, field)
   source_count(field) = COUNT(DISTINCT source_name) of live assertions for that cell
```

- **Strongest argument.** **Provenance is intrinsic, not bolted on — every assertion *is* a provenance record,
  at exactly the granularity the market merges (per-field, RESEARCH_01 §A.7).** `source_count` (S4) is a literal
  `COUNT(DISTINCT source_name)` per cell; "where did this email come from" (S5/DSAR) is one indexed read;
  per-field unmerge (S6) is exact — drop/supersede the offending assertion and re-roll that one cell;
  "human-entered outranks provider guess" is an `is_user_pinned` flag on the winning assertion. It is the only
  shape that satisfies C4 **as a first-class structure** rather than a reserved seam.
- **The failure mode that *threatens* it: assertion-row explosion and rollup-refresh cost (S1).** N entities ×
  M fields × K sources × T re-observations is a vastly larger row count than one golden row per entity; the
  ledger is itself a billions→trillions-row table and the golden rollup must be kept fresh (incremental
  materialized view / trigger / CDC). Done naively (recompute the rollup on every assertion insert; no
  dedup of identical re-observations) it is an N+1/write-amplification disaster. It is **viable only** if the
  ledger is append-mostly, partitioned, dedup-keyed on `(entity, field, source, value_hash)`, and the golden
  rollup is refreshed incrementally for the touched cell only — i.e. it must be engineered like B's log, not
  like a hot OLTP table.

---

## 2. Stress-test matrix

Scoring: **✓** survives cleanly · **~** survives only with the noted engineering · **✗** fails the axis.

| Axis | A (inline golden) | B (episode log + projection) | C (blanket bitemporal) | D (assertion ledger) |
|---|---|---|---|---|
| **S1** Billions + rebuild | ✗ full-row jsonb rewrite per field; hot-table churn | ✓ golden lean; history cold in S3/Iceberg | ✗ version-row explosion on OLTP; `DISTINCT ON` reads | ~ ledger huge but cold/partitioned; rollup incremental |
| **S2** RLS shared canonical | ✓ no ws column needed | ✓ no ws column needed | ✓ no ws column needed | ✓ **iff** assertion carries `source_name`, never `source_workspace` |
| **S3** Company-less persons | ✓ value-cells, no edge | ✓ person row, no edge, no company key | ✓ attr versions, no edge | ✓ assertions on person fields, no edge |
| **S4** Corroboration `source_count` | ✗ winner only; count not recomputable | ~ requires re-parsing payloads per field | ~ version-count conflates re-obs vs new source | ✓ `COUNT(DISTINCT source_name)` per cell |
| **S5** DSAR purge provability | ~ provenance in row, but no immutable lineage to prove erasure | ✓ blind-index → identity → every source row | ✓ blind-index → identity → versions | ✓ blind-index → identity → every assertion |
| **S6** Reversibility / unmerge | ✗ overwrite destroys prior value | ~ **whole-cluster** only (not per-field) | ✓ per-attribute (close tx-version) | ✓ **per-cell** (supersede the assertion) |

Read down the columns: **A fails the two existential axes** (S1, S6). **C fails S1 as a blanket policy.** **B
and D are the survivors**, and they fail *opposite* axes — B is weak exactly where D is strong (per-field
provenance, S4/S6) and D is weak exactly where B is strong (lean hot golden, S1). That complementarity is the
whole decision (§4).

### The decisive cases, in prose

**S1 — billions + rebuild (the scale gate).** The golden store doubles as the OLTP source-of-truth *and* the
feed for the OpenSearch/ClickHouse masked index ([ADR-0021:72–77](../decisions/ADR-0021-global-master-graph-and-overlay.md)).
Any approach that versions or re-writes the *golden* row on every observation (A's jsonb rewrite, C's version
insert) competes with the read path on the hottest table and bloats what must stay lean for index-sync. B and D
both pass **only because they keep the golden current-state small and push the high-cardinality history to a
cold, append-only, partitioned store** ([03:737](../03-database-design.md); RESEARCH_07 covers the backfill).
Rebuild cost: B re-projects a golden row by replaying its cluster's `source_records`; D re-rolls a cell by
re-running survivorship over that cell's assertions — D's rebuild is **finer-grained and cheaper** (one cell,
not the whole entity) but only if assertions are extracted, not re-parsed from `raw_data` each time.

**S2 — RLS under a shared canonical (the constraint that traps the careless).** All four pass *only* by
refusing the tempting column. The trap is specific: the field-provenance layer wants to record "who told us this"
— and a workspace's CONTRIBUTE-TO upload is a source. If that provenance row stored `source_workspace_id`, the
canonical layer would carry a per-workspace dimension and either (a) need an RLS predicate (breaking the
system-owned model, C1) or (b) leak one workspace's contribution identity into the golden value other
workspaces read. The rule for **every** approach: provenance records a **`source_name`** (`apollo|zoominfo|coop|
public_registry|…`, mirroring [03:463](../03-database-design.md)), and CONTRIBUTE-TO co-op contributions enter
as `source_name='coop'` — **opt-in, off by default** ([ADR-0021:60–62](../decisions/ADR-0021-global-master-graph-and-overlay.md))
— never as a workspace-identifying column on a Layer-0 row. MATCH-AGAINST (always on) writes no provenance;
only CONTRIBUTE-TO does. Isolation stays **by access path** (masked search + paid reveal), not by RLS.

**S3 — company-less persons.** `master_employment.master_company_id` is `NOT NULL` ([03:431](../03-database-design.md)),
so the model represents "no employer" by the **absence of an edge**, with `master_persons.current_company_id =
NULL` — clean in all four. Two real hazards the *resolution* layer (not the storage shape) must handle, called
out here so the plan owns them: (1) a person known only by a **free-mail domain** (`gmail.com`,
`outlook.com`) must **not** mint a company — the registrable-domain → company key (`matchKeys.ts`
`registrableDomain`, signal #3) must consult a free-mail/ISP exclusion list or it will fabricate a "Gmail
employs 2 billion people" super-cluster; (2) a company-less person has **no domain key**, so resolution falls to
person email / LinkedIn id / fuzzy name+location (signals #2/#1/#5) — weaker, higher false-merge risk, more
likely to route to clerical review (`match_links.review_status='pending'`). The storage shape is neutral; the
plan must specify the free-mail guard and the no-domain resolution fallback.

**S4 — corroboration.** This is where B and D split hardest. `source_count` ([03:446,457](../03-database-design.md))
is a survivorship input *and* a trust signal surfaced to users (Apollo's multi-source gate, RESEARCH_01 §A.2;
Cognism's fusion, §A.5). In **B** it is a denormalized integer on `master_emails`/`master_phones` that the
projector must maintain and that **cannot be recomputed** without re-scanning the cluster's payloads — drift-prone.
In **D** it is `COUNT(DISTINCT source_name)` over the cell's live assertions — always correct, always auditable,
recomputable. For email/phone channels the schema *already* carries `source_count`, so B is "good enough" there;
for **every other field** (title, name, seniority, firmographics) B has **no** corroboration count at all, while
D has it uniformly. This is the single strongest argument for a D-shaped layer underneath B.

**S5 — DSAR purge provability.** All survivors pass, but the *quality* of the proof differs. DSAR keys on
`email_blind_index` → the one `master_persons` identity → fan out to overlay copies + global suppression
([list-plan/02 §5.2:307–334](../list-plan/02-data-model.md)). B proves "every source that asserted this person"
at payload granularity; D proves it at **cell** granularity ("this phone came from source X on date Y, here are
all 3 corroborating assertions, all now tombstoned"). DPDP/GDPR "right to know the source of my data" is
answerable more precisely under D. **Caveat for both:** purging a person must tombstone the assertions/payloads
*and* re-roll or null the golden cells, and insert the global suppression so re-import can't resurrect
([list-plan/02 §5.2:323](../list-plan/02-data-model.md)) — the cascade is identical in shape; D just has more,
finer rows to tombstone.

**S6 — reversibility / unmerge.** The false-merge target is ≤0.5% (the brief), and a clerical-review reject
([06 §9:318](../06-enrichment-engine.md)) must be undoable. B reverses at the **cluster** level: split via
`match_links.is_duplicate_of`, re-project two golden rows. That handles "two people wrongly merged into one."
It does **not** handle "the right person, but one field took the wrong source's value" — for that you need D's
per-cell supersede. Both granularities are real failure modes; only B+D together cover both.

---

## 3. Challenging the obvious choice — why `source_records` + `match_links` might be wrong

The default is B: it is the accepted ADR, the built-toward schema, and RESEARCH_01's pick. The gate must try to
break it before endorsing it. Four genuine challenges:

1. **B's provenance granularity is wrong for the stated mandate.** The brief and RESEARCH_01 §B.6 make
   **field-level** provenance mandatory (source/confidence/timestamp *per field*). B's units are the **payload**
   (`source_records`) and the **cluster** (`match_links`) — neither is the field. So B *as specified today*
   cannot answer the core provenance question without an unbounded re-parse of `raw_data` jsonb, and cannot
   reverse a per-field survivorship error at all. Endorsing "B" without qualification endorses a model that
   **does not meet its own requirement**. (This is the load-bearing finding.)

2. **`source_count` on only two tables is an inconsistency, not a design.** B gives corroboration counts to
   email/phone (because those tables happen to have the column) and to *nothing else*. A user looking at a
   golden `job_title` or `employee_band` has no "how many sources agree" — yet that is exactly the trust signal
   every competitor surfaces (RESEARCH_01 §A.7). Either every golden field gets its own `_source_count` column
   (A's bloat, rejected) or corroboration is computed from a per-field assertion store (D). B alone has no good
   answer.

3. **Replay-to-reconstruct is more expensive than it looks at billions.** "History = replay the log" (RESEARCH_01
   §C.2) is elegant but the replay unit is the whole cluster's payloads; reconstructing "what did we believe
   about this one field as of date X" replays *everything* about the entity. D reconstructs one cell from one
   cell's assertions. For the operations the product actually performs at scale — re-survivorship when a
   higher-trust source lands, audit of one field, per-field unmerge — D's granularity is strictly cheaper.

4. **But the challenge does *not* break B's backbone.** The immutable, `content_hash`-idempotent log + cluster
   match-links is still the right **lineage and merge-reversibility substrate** (S5/S6 cluster-level), the right
   **lake-friendly cold store** (S1), and the right **idempotent-ingest guarantee** ([03:464](../03-database-design.md)).
   The challenge lands on *granularity*, not on *whether to keep the log*. The conclusion is therefore **not**
   "reject B" but "**B is necessary and insufficient** — it must be completed by a D-shaped per-field layer, and
   the right move is to design that layer as a first-class assertion ledger, not as an afterthought sidecar."

The opposite challenge — "why not pure D, drop the payload log?" — also fails: without the immutable raw-payload
log you lose verbatim source evidence for audit/legal, idempotent re-ingest by `content_hash`, and the ability
to *re-extract* assertions if extraction logic changes. D's assertions are *derived*; B's payloads are *raw*.
You need both: raw for proof and replay, derived for per-field survivorship and corroboration.

---

## 4. DECISION

**Proceed with B as the backbone, completed by D as the field-provenance layer, with C applied selectively —
i.e. a three-part canonical model:**

1. **`source_records` (B) remains the immutable raw-evidence system of record** — append-only,
   `content_hash`-idempotent, range-partitioned by `ingested_at`, cold in S3/Iceberg
   ([03:461–471,737](../03-database-design.md)). `match_links` remains the cluster/merge substrate and the
   **whole-entity** unmerge mechanism ([03:473–486](../03-database-design.md)). This is unchanged from ADR-0021
   — no re-litigation of the accepted decision.

2. **The golden tables (`master_persons`/`master_companies`/`master_employment`/`master_emails`/`master_phones`)
   stay a lean, un-versioned current-state projection** — one row per entity, keyed by the deterministic unique
   keys ([03 §11:716](../03-database-design.md)), shaped for OLTP + index-sync. They **expose** value + winning
   provenance the way A reads (one row, cheap), but they are **derived**, not authoritative.

3. **Field-level provenance is a first-class, D-shaped per-cell assertion ledger** (Phase-1 reserves the seam;
   Phase-3 builds it): one normalized provenance table — `{entity_type, entity_id, field, value_norm,
   value_enc?, source_name, source_record_id, confidence, observed_at (valid-time), ingested_at (transaction-time),
   is_user_pinned, superseded_by}` — that is the recomputable basis for survivorship, `source_count` (=
   `COUNT(DISTINCT source_name)` per cell), per-cell unmerge, and DSAR cell-lineage. It is **system-owned**
   (`source_name`, never `source_workspace`), append-mostly, partitioned, and dedup-keyed on
   `(entity, field, source, value_hash)` so re-observations don't explode it. The golden cell is the rollup of
   its live assertions; the rollup refreshes **incrementally for the touched cell only**.

4. **Bitemporality (C) is applied selectively, not blanket** — valid-time on the genuinely temporal domains
   only: the employment edge (`started_on`/`ended_on`/`is_current`, already present, [03:433](../03-database-design.md))
   and the contact-channel status lifecycle — using **close-don't-delete** (Graphiti-style invalidation,
   RESEARCH_01 §B.2). The assertion ledger already carries both time axes per cell (`observed_at` +
   `ingested_at`), so general time-travel falls out of the ledger without versioning the golden rows.

**Why this and not the pure recommendation.** RESEARCH_01 recommended B + "reserve a field-provenance seam."
This gate's refinement, earned by §2/§3, is sharper: **the reserved seam must be designed as a D-shaped
assertion ledger, because that is the only structure that makes `source_count`, per-cell unmerge, recomputable
survivorship, and cell-level DSAR all fall out for free** — treating it as a loose "sidecar" risks rebuilding it
as inline columns (A's bloat) or per-payload re-parsing (B's gap). The decision is B's backbone + D's ledger +
C's selectivity — each approach contributing exactly the axis it wins (B→S1/S5/S6-cluster, D→S4/S6-cell/C4,
C→temporal correctness on the edge).

**Explicitly rejected:** **A** (inline golden as system-of-record) — fails S1 (hot-row rewrite) and S6
(overwrite destroys evidence); kept only as the *read shape* the projection exposes. **C as a blanket policy** —
fails S1 (version explosion); kept only selectively on temporal edges/channels. **Pure D without the raw log** —
loses verbatim evidence, idempotent re-ingest, and re-extractability. **Pure B without the ledger** — fails its
own field-level-provenance mandate (§3).

### Open questions carried to the PLAN

- **OQ1 — Ledger granularity vs. cost.** Is one `field_assertion` table for *all* fields right, or do
  high-churn channels (email/phone, which already have `source_count`/`last_verified_at` on `master_emails`/
  `master_phones`) keep their existing per-channel shape while only the *flat* attributes (title, name,
  seniority, firmographics) get the generic ledger? (Avoids double-storing channel corroboration.)
- **OQ2 — Golden-cell rollup mechanism.** Trigger on assertion insert, incremental materialized view, or
  CDC/outbox-driven projector ([ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md))? What
  bounds rollup-refresh fan-out so a single high-corroboration cell update isn't an N+1?
- **OQ3 — Where the ledger physically lives.** Postgres (Citus-sharded, like the golden OLTP) or the S3/Iceberg
  lake with only the *winning* assertion mirrored to Postgres for the hot read? Trade: in-Postgres = simpler
  recompute; lake = cheaper at trillions but slower per-cell audit.
- **OQ4 — Encryption of asserted PII.** Email/phone assertions hold PII; do they store `value_enc` + a
  blind-index per assertion (so DSAR/dedup work on the ledger directly) or only reference the
  `master_emails`/`master_phones` channel row? (Ties to OQ1.)
- **OQ5 — Unmerge interaction.** When `match_links` splits a cluster (whole-entity unmerge, B), how do the
  cell-level assertions re-partition across the two resulting golden identities, and which survivorship re-runs?
- **OQ6 — Free-mail / no-domain resolution (S3).** Where does the free-mail/ISP exclusion list live and how is
  it versioned, and what is the exact fallback key order for a company-less person — owned by the ER plan, but
  the entity model must not assume a domain exists.
- **OQ7 — `is_user_pinned` provenance under CONTRIBUTE-TO.** A human correction is the highest-trust assertion,
  but if it originates in a workspace it must enter the canonical layer as `source_name='coop'` (opt-in) — how
  is "human-pinned" reconciled with "off-by-default contribution" so an un-contributed workspace edit pins the
  *overlay* cell without touching the golden cell?

**Implementation status (gap → work-to-do, never license to skip a rule).** Only the Layer-1 overlay is built,
without the `master_*_id` FKs (`contacts.ts:98` is still the single direct `account_id`; per-workspace soft
dedup in `dedup.ts`). The entire Layer-0 backbone (B) is **designed in [03 §5.1](../03-database-design.md), not
built**; the D-shaped field-provenance ledger is **undesigned anywhere** and is the Phase-3 deliverable this
decision commits Phase-1 to reserve a seam for. None of these gaps relaxes a constraint: when built, every
canonical and provenance table is system-owned (no RLS columns, C1), survivorship stays per-field, corroboration
stays recomputable, and the deterministic resolution keys stay backed by DB unique constraints
([03:716](../03-database-design.md)) so concurrent ingests cannot mint duplicates.
