# BRAINSTORM 03 — Field-Level Provenance & Multi-Source Merge: Storage-Substrate Options

> **Gate:** BRAINSTORM · **Phase:** 3 — Multi-Source Merge & Provenance Resolution · **Depends on:**
> [RESEARCH_03_mdm_merge.md](./RESEARCH_03_mdm_merge.md) (the survey + the JSONB-map recommendation this gate
> stress-tests), [RESEARCH_00_current_state.md](./RESEARCH_00_current_state.md) (the U1/U3 field-provenance gap),
> [RESEARCH_02_linking_patterns.md](./RESEARCH_02_linking_patterns.md) (the U2 **edge**-provenance gap — Phase-2
> consumer), [RESEARCH_06_freshness.md](./RESEARCH_06_freshness.md) (the two-clock freshness model — Phase-6
> consumer), and the sibling [BRAINSTORM_01_entity_options.md](./BRAINSTORM_01_entity_options.md) whose §4
> *committed Phase-1 to reserve a seam for a normalized "D-shaped" assertion ledger and left its granularity open
> as **OQ1*** — **this gate resolves that OQ1.** **Anchors:** [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md)
> (system-owned master, MATCH-AGAINST ≠ CONTRIBUTE-TO), [ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md)
> (the survivorship cascade + Splink gate), [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)
> (freshness), [03 §5.1/§5.2](../03-database-design.md) (the golden + overlay DDL), [06 §9](../06-enrichment-engine.md)
> (the ER pipeline). **Feeds:** the Phase-3 PLAN. This doc generates and stress-tests options and **ends in a
> DECISION**; it writes no schema, no migration, and no plan.

---

## 0. What this gate decides, and against what

RESEARCH_03 *recommended* a crosswalk-plus-materialized-**JSONB-map** model and explicitly rejected a normalized
per-field provenance table. The very next sibling, BRAINSTORM_01 §4.3, *committed* Phase-1 to "reserve a seam for a
first-class, **D-shaped per-cell assertion ledger**" — a normalized table — and parked its granularity as
[OQ1](./BRAINSTORM_01_entity_options.md) ("one `field_assertion` table for *all* fields, or do the channels keep
their per-channel shape?"). **Those two recommendations point at different substrates.** This gate's job is the
adversarial one: put the three storage substrates the task names — **(A)** wide per-field metadata columns, **(B)**
a normalized `field_provenance` table, **(C)** a JSONB provenance map — next to each other, drive each into the hard
cases until it breaks, **explicitly challenge the obvious normalized-table choice (B)**, and then resolve the
RESEARCH_03↔BRAINSTORM_01 tension with one committed direction. The output is that direction plus the open
questions it carries — *not* the plan.

**The decision is narrower than "the whole model."** BRAINSTORM_01 already locked the *backbone*: `source_records`
is the immutable raw-evidence log/crosswalk, `master_*` is a lean current-state projection, `match_links` is the
cluster/merge substrate ([03 §5.1:461–486](../03-database-design.md)). This gate decides only **where the per-field
*winning descriptor* lives and how survivorship is computed and reversed over it** — the U1 gap. Everything here sits
*on top of* the accepted backbone; none of it re-litigates ADR-0021.

**Decision criteria.** Each substrate is scored against seven stress axes (the hard cases the task names) and five
cross-cutting constraints (the brief's invariants).

| # | Stress axis | Why it is decisive |
|---|---|---|
| **S1** | **Storage / scale at billions × fields** | The golden row doubles as the OLTP source-of-truth **and** the OpenSearch/ClickHouse index feed ([03 §9:698](../03-database-design.md), [ADR-0021:72–77](../decisions/ADR-0021-global-master-graph-and-overlay.md)); any substrate that re-writes the golden row per field, or mints its own tens-to-hundreds-of-billions-row table, dies at 10×. |
| **S2** | **Survivorship recompute cost** | A new higher-trust source landing, or a re-verification tick ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md): email 90d / phone 180d / employment 60d → continuous churn), must recompute the winning value **cheaply and deterministically** ([06 §9:315–316](../06-enrichment-engine.md)). |
| **S3** | **User-correction outranks providers (the pin)** | "User-entered > verified-provider > inferred" ([ADR-0015:70–75](../decisions/ADR-0015-entity-resolution-dedup-engine.md)); a bare column cannot say "don't overwrite me." The substrate must carry a per-field, **two-layer** pin (overlay-private vs master-steward, the U3 split). |
| **S4** | **Conflict resolution + reversibility / unmerge** | False-merge target ≤0.5% ([22:152–153](../22-data-quality-freshness-lifecycle.md)); "`source_records` keeps every merge **reversible**" ([06 §9:319](../06-enrichment-engine.md)). The substrate must undo a bad merge at the granularity it was made — **and** undo a single bad field-survivorship pick. |
| **S5** | **Confidence feeds the Phase-2 link edge** | The `master_employment` edge needs its own **source / confidence / as-of** (the U2 gap — [RESEARCH_02 §2.3:224–227](./RESEARCH_02_linking_patterns.md)); the email-domain→`primary_domain` match strength is the edge's confidence input. The provenance substrate must cover *edge* attributes, not only scalar person/company fields. |
| **S6** | **Feeds Phase-6 freshness (two clocks)** | `observed_at` + `last_verified_at` + `verification_source` **per field** are the decay inputs ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)); the substrate must hold them on **both** clocks — master channel (Clock A) and overlay snapshot (Clock B) ([RESEARCH_06 §1:74–82](./RESEARCH_06_freshness.md)) — without conflating them. |
| **S7** | **Low-confidence human-review path** | Splink's review band ([03:481–482](../03-database-design.md), [22:161–171](../22-data-quality-freshness-lifecycle.md)) must record a clerical/customer field-pick **as durable provenance** ("manual actions are data, not side effects", RESEARCH_03 §B.6) so the next ER pass does not re-litigate it. |

**Cross-cutting constraints (a hard fail on any one disqualifies the substrate):** **C1** — Layer-0 master
provenance is system-owned: **no** `tenant_id`/`workspace_id`/`owner`/`visibility` on any master provenance
structure ([ADR-0021:33–35](../decisions/ADR-0021-global-master-graph-and-overlay.md)). **C2** — co-op privacy: a
provenance descriptor records a **platform-level `source_name`** (`apollo|zoominfo|coop|public_registry|user_edit`),
**never** a contributing workspace ([ADR-0021:53–65](../decisions/ADR-0021-global-master-graph-and-overlay.md);
MATCH-AGAINST writes no master provenance, only opt-in CONTRIBUTE-TO does). **C3** — build on the existing
substrate (`source_records`, `match_links`, the `source_count`/`last_verified_at`/`verification_source` already on
`master_emails`/`master_phones`, [03:446–447,457](../03-database-design.md)); don't reinvent. **C4** — the
billions-QPS search/read path pays **no join and no recompute** for provenance ([ADR-0021:72–77](../decisions/ADR-0021-global-master-graph-and-overlay.md)).
**C5** — DSAR answers "where did this field come from" at **cell granularity** and the erase cascade reaches the
descriptor ([list-plan/02 §5.2](../list-plan/02-data-model.md); [03:761](../03-database-design.md)).

---

## 1. The candidate substrates

Three *distinct shapes* (not parameter variations). They differ on the load-bearing question: **where does the
per-field winning descriptor physically live, and how is the candidate set behind it stored** — inline sibling
columns (A), a normalized one-row-per-`(entity,field,source)` table that *is* the candidate set (B), or one JSONB
column holding only the winner with the candidate set deferred to `source_records` (C).

### Substrate A — Wide per-field metadata columns on the master row

Each provenance-worthy attribute carries its descriptor as **physical sibling columns** on `master_persons` /
`master_companies` / `master_employment`. There is no provenance side-store; the golden row *is* the provenance.

```
master_persons (authoritative + self-describing)
┌──────────────────────────────────────────────────────────────────────────────┐
│ job_title              varchar(255)                                            │
│ job_title_source       varchar(50)        -- 'zoominfo'                         │
│ job_title_confidence   numeric(4,3)       -- 0.910                              │
│ job_title_observed_at  timestamptz        -- valid-time                         │
│ job_title_src_count    int                -- corroboration                      │
│ job_title_pinned       boolean            -- steward pin (master)               │
│ … × 6 columns PER provenance-worthy field × ~15 fields  →  ~90 columns          │
└──────────────────────────────────────────────────────────────────────────────┘
   write: ER resolves → read current cell → cascade(incoming,current) → overwrite the 6 cells
```

- **Strongest argument.** **Cheapest possible read with zero structure to design later** — value and provenance are
  the same row, same page; the search projection and the reveal path read exactly what they show, and C4 (no join,
  no recompute) is satisfied by construction. It is also the most index-friendly: `job_title_src_count >= 3` is a
  plain B-tree predicate, no JSONB/GIN.
- **The failure mode that kills it: rigidity + sparsity + it cannot hold the structure.** Every new
  provenance-worthy field is a **schema migration on the hottest billions-row table** (`ALTER TABLE … ADD COLUMN ×6`),
  the antithesis of the agility the firmographic/technographic field set needs; the table balloons to ~90+ mostly-**sparse**
  columns (most rows have a handful of sources); and a flat column set **cannot carry the per-field pin's actor/time
  tuple or the two-layer scope** without yet more columns. Worse, it keeps **only the winner** — `src_count` becomes a
  stored integer that drifts and **cannot be recomputed** when a duplicate source re-arrives (S2/S4 brittle), and a
  bad survivorship pick is an **in-place overwrite that destroys the prior value** (fails S4 — the CRDT lost-update,
  RESEARCH_03 §B.4). **Rejected as the substrate.** Its *read shape* (one row, value+winner side by side) is exactly
  what C delivers without the rigidity — keep the shape, drop the physical columns.

### Substrate B — A normalized `field_provenance` table (survivorship as a query over it)

One row per `(entity, field, source, value)` observation. This table **is** the candidate set and the system of
record for provenance; the golden value per field is a **query or materialization** (`argmax` survivorship, or a
maintained `is_current` flag). This is the literal substrate the task names, and — post-BRAINSTORM_01 §4.3 — the
*obvious* choice this gate is told to challenge.

```
field_provenance  (the cell-level candidate ledger — system-owned, NO workspace column)
┌──────────────────────────────────────────────────────────────────────────────┐
│ id, entity_type('person'|'company'|'employment'), entity_id,                   │
│ field_name ('job_title'), value_norm, value_enc?(PII), value_hash,             │
│ source_name, source_record_id → source_records, confidence numeric(4,3),       │
│ observed_at (valid-time), ingested_at (tx-time),                               │
│ is_current bool, is_pinned bool, superseded_by uuid                            │
│ UNIQUE (entity_type, entity_id, field_name, source_name, value_hash)           │
└──────────────────────────────────────────────────────────────────────────────┘
   golden_value(field)   = SELECT value_norm WHERE is_current        (or argmax cascade at read)
   source_count(field)   = COUNT(DISTINCT source_name) of live rows  ← recomputable, always correct
   per-cell unmerge      = supersede the offending row, re-roll THIS cell only
```

- **Strongest argument (this is BRAINSTORM_01 §4.3's own case).** **Provenance is intrinsic, at exactly the
  granularity the market merges (per-field, RESEARCH_03 §A.1–A.4).** `source_count` (S2/S4 corroboration) is a literal
  `COUNT(DISTINCT source_name)` per cell — recomputable, auditable, **uniform across *all* fields**, not just the two
  channels that happen to have the column today. "Where did this email come from" (S5/DSAR/C5) is one indexed read;
  per-cell unmerge (S4) is exact — supersede the one offending assertion and re-roll that single cell; the pin (S3)
  is `is_pinned` on the winning row; the review-band pick (S7) is a pinned row with the actor. It is the **only**
  substrate where corroboration and per-cell reversibility *fall out for free* rather than being reconstructed.
- **The failure mode that kills it as the blanket store: row explosion + write amplification + recompute-on-read
  (S1/S2).** At **billions of entities × ~15 fields × K sources × T re-observations** this is a
  **tens-to-hundreds-of-billions-row** object — *larger than `master_persons` itself* (RESEARCH_03 §C.1) — with its
  own shard cluster and GIN/B-tree index footprint roughly the same size again. The re-verification cadences
  ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)) **re-write it continuously**.
  If survivorship is a `SELECT … argmax` **at read**, every golden read (including the index feed) pays a per-cell
  aggregation — failing C4 catastrophically; if instead it maintains an `is_current` flag, every new observation does
  a read-modify-write across the cell's rows (flip the old current, insert the new) — write amplification on a
  trillions-row table. Either way it is the N+1/unbounded-fan-out failure the scale gate forbids (brief; [03 §12:722–738](../03-database-design.md)).
  **Rejected as the blanket master provenance store** — but see §3: its row-explosion objection is decisively weaker
  than it looks **for the few genuinely multi-valued, separately-verified channels**, where TruePoint *already*
  pays exactly this cost on purpose (`master_emails`/`master_phones`).

### Substrate C — A JSONB provenance map embedded per master record

One `field_provenance jsonb` column on each golden row (and each overlay row) holding **only the winning descriptor
per field**. The full candidate set is **not** in this column — it stays in the immutable `source_records` crosswalk
(RESEARCH_03 §B.3, §A.2). The map is a thin pointer-and-decision cache; survivorship is a deterministic cascade
re-projected from the entity's cluster evidence and **materialized** into the map on write.

```
LAYER 0  master_persons.field_provenance jsonb  (system-owned, NO workspace column)
{
  "job_title": { "wsr": "<source_record_id>", "src": "zoominfo", "conf": 0.91,
                 "obs": "2026-05-01", "ing": "2026-05-02", "n": 3, "pin": false },
  "full_name": { "wsr": "…", "src": "linkedin", "conf": 0.99, "obs": "…", "n": 7, "pin": false }
}                                  ▲ history is NOT here — it is in source_records (the crosswalk)

LAYER 1  contacts.field_provenance jsonb  (RLS-scoped, owner-scoped on read)
{
  "job_title": { "src": "master:verified", "conf": 0.91, "obs": "2026-05-01", "pin": false },
  "email":     { "src": "user_edit", "pin": true, "pin_by": "<user_id>", "pin_at": "<ts>" }
}                                  ▲ platform-level source label ONLY — never names a workspace (C2)
```

- **Strongest argument.** **It keeps A's one-row read with none of A's rigidity, and B's per-field structure with
  none of B's row explosion.** One column, no join, GIN-indexable for "show me where this came from"; a new field is a
  new JSON key, **no migration**; the descriptor cleanly carries the structured pin tuple and the two-layer scope; and
  because the *history* lives in `source_records`, the map holds only ~15 small descriptors per row (~200–600 B,
  RESEARCH_03 §C.1) — **+1 column, ~0.2–1.8 TB** at billions, no new table. It satisfies C4 perfectly: the OpenSearch
  doc indexes the *materialized winner*, the map is fetched only on detail read. It directly **generalizes the
  already-shipped per-channel provenance** (`master_emails.source_count`/`last_verified_at`/`verification_source`) to
  every flat field via one uniform structure (C3).
- **The failure mode that *threatens* it: corroboration and per-cell reversibility are not first-class.** The map
  stores `n` (source_count) and `wsr` (the *winning* source_record) — but **not the full candidate set**. So
  `source_count` is a **stored integer**, not a live `COUNT(DISTINCT)`: it is correct only as of the last projection
  and is recomputed by **re-scanning the entity's `source_records` cluster**, not by a one-line SQL count.
  Per-cell unmerge is likewise a **re-projection of the entity**, not a surgical `supersede` of one row. This is
  precisely the gap BRAINSTORM_01 §3 raised against the log-only model — and §3 below decides whether that gap is
  fatal or a micro-optimization.

---

## 2. Stress-test matrix

Scoring: **✓** survives cleanly · **~** survives only with the noted engineering · **✗** fails the axis.

| Axis | A (wide columns) | B (normalized table) | C (JSONB winner-map) |
|---|---|---|---|
| **S1** storage / scale at billions×fields | ✗ ~90 sparse cols on the hot table; every new field = migration | ✗ **10s–100s B rows**, > `master_persons`, re-written every cadence | ✓ +1 column; history cold in `source_records` |
| **S2** survivorship recompute | ✗ winner-only; `src_count` drifts, not recomputable | ✗ argmax-at-read (C4 fail) **or** is_current RMW (write-amp) | ~ re-project entity over its cluster — **bounded by cluster size** |
| **S3** user-correction pin (two-layer) | ~ a `_pinned` bool per col; no actor/scope tuple | ✓ `is_pinned` row + actor | ✓ structured pin tuple, per-layer map |
| **S4** conflict / reversibility / unmerge | ✗ overwrite destroys prior value | ✓ **per-cell** supersede + re-roll | ~ **per-entity** re-project (whole-entity, not one cell) |
| **S5** confidence feeds the Phase-2 edge | ~ edge gets its own ×6 columns (more bloat) | ✓ `entity_type='employment'` rows carry edge confidence | ✓ map on `master_employment`; same structure |
| **S6** feeds Phase-6 freshness (2 clocks) | ~ `_observed_at`/`_verified` per col, one clock per row | ✓ `observed_at`/`ingested_at` per row, both layers | ✓ `obs`/`ing`/verify in descriptor, map on both layers |
| **S7** human-review pick is durable | ~ a pinned bool, no review lineage | ✓ pinned row + `source_record_id` + actor | ✓ pinned descriptor + actor; pick survives next ER pass |
| **C1/C2** system-owned, no ws column / co-op | ✓ no ws column | ✓ **iff** `source_name`, never `source_workspace` | ✓ master map carries no ws; overlay map = platform label only |

Read down the columns: **A fails the two scale/structure axes (S1, S2) and the existential reversibility axis (S4).**
**B fails the two scale axes (S1, S2) as a *blanket* store but wins every provenance-quality axis (S3–S7).** **C
wins every axis except S2/S4, where it is "~" — bounded-but-not-surgical.** B and C fail **opposite** axes: B is
strong exactly where C is "~" (per-cell corroboration/unmerge) and weak exactly where C is strong (scale). That
complementarity is the whole decision (§3, §4).

### The decisive cases, in prose

**S1 — scale (the gate that eliminates A and blanket-B).** The golden store is simultaneously the OLTP truth and the
feed for the masked global index ([ADR-0021:72–77](../decisions/ADR-0021-global-master-graph-and-overlay.md)). A's
~90-column hot table and B's separate trillions-row ledger both lose on the same principle: **provenance must not
inflate the hot golden footprint, and must not mint a second object bigger than the golden table that is re-written
on every freshness tick** ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)).
C wins because the *winner* is one tiny column on the hot row and the *history* is the cold, partitioned, lake-bound
`source_records` we already keep ([03:470,737](../03-database-design.md)).

**S2 — recompute cost (the case that rescues C and re-frames BRAINSTORM_01's objection).** The threat to C is "you
must re-scan `source_records` to recompute the winner / `source_count`." **The recompute unit is the entity's
cluster, and clusters are small.** A person's cluster is the set of `source_records` that resolved to them — a
heavily-enriched person has on the order of tens of payloads (a handful of providers × a few imports × a few
re-verifications), **not** millions. Re-projecting one entity = parse ~10–40 `raw_data` jsonb payloads, extract the
field set, run the cascade `argmax` — **bounded and cheap, per entity, run only on new evidence / unmerge**, never on
the read path. BRAINSTORM_01 §3 called this "unbounded fan-out"; it is in fact **bounded by per-entity cluster
cardinality**, which the ER design keeps small (blocking + MinHash/LSH avoid the super-cluster, per the brief). The
genuine residual risk is the **high-degree super-node** (a celebrity CEO, or a free-mail super-cluster that the
free-mail guard must prevent — BRAINSTORM_01 S3/OQ6); that is the one case where per-entity re-projection degrades,
and it is the escape-hatch carried to OQ4.

**S3 — the pin, on two layers (the U3 split).** Classic MDM has one pin scope (the steward); TruePoint has two
([RESEARCH_03 §B.2,§C.2](./RESEARCH_03_mdm_merge.md)). An **overlay pin** (a workspace hand-edits `contacts.job_title`)
is workspace-private, lives in the **overlay** map, **blocks a later reveal/enrichment from overwriting that
workspace's value**, and **never** mutates the golden record (CONTRIBUTE-TO is opt-in,
[ADR-0021:60–62](../decisions/ADR-0021-global-master-graph-and-overlay.md)). A **master/steward pin** lives in the
**master** map, is audited via `withPlatformTx`, and affects every future reveal. Both A and B can hold a pin flag;
only C and B hold the *structured* pin (actor, time, scope) cleanly, and only the **two-layer map** (C) places the
pin on the correct layer without leaking the overlay edit into Layer 0. **This two-layer placement is independent of
A/B/C for the candidate set** — it is a property of *where the materialized descriptor lives*, and both layers need
the descriptor, which is the second reason C (a descriptor that exists identically on both layers) is the natural fit.

**S4 — reversibility, two granularities (where B genuinely beats C).** Two real failure modes: (i) **two people
wrongly merged into one** — undo by splitting `match_links.is_duplicate_of` and re-projecting two golden rows
([03:480](../03-database-design.md)); C and B both handle this via the backbone. (ii) **the right person, but one
field took the wrong source's value** — B undoes it surgically (`supersede` the one assertion, re-roll the one cell);
C re-projects the **whole entity** (cheap, per S2, but not surgical). For TruePoint the per-cell case is real but
**rare and recoverable by the cheap per-entity re-projection** — you do not need a trillions-row ledger to get it.
This is the crux of §3.

**S5 — feeding the Phase-2 edge (the U2 gap).** `master_employment` carries **only** `title, department,
seniority_level, is_current, started_on, ended_on` — **no source/confidence/as-of** ([03:428–436](../03-database-design.md);
the U2 gap, [RESEARCH_02 §2.3:224–227](./RESEARCH_02_linking_patterns.md)). The edge **is** a provenance-bearing
object: a `deterministic_domain` (verified email → `primary_domain`, [matchKeys.ts]) edge is high-confidence; a
`fuzzy_name_company` edge is low and routes to review ([RESEARCH_02 §2.3](./RESEARCH_02_linking_patterns.md)). The
provenance substrate must therefore cover **edge attributes**, treating the edge's existence + `is_current` as fields
with `{src, conf, obs}`. C does this with **one more entry-set in the same map shape** (a `field_provenance` map on
`master_employment`, or `entity_type='employment'` descriptors); A would need another ×6 columns on the edge; B would
add `entity_type='employment'` rows. The edge's `conf` becomes a first-class input to the Phase-2 link-acceptance gate
and to `current_company_id` denormalization ([03:413](../03-database-design.md), which must be *derived from* the
highest-confidence `is_current` edge, never hand-set — [RESEARCH_02 §2.1:63](./RESEARCH_02_linking_patterns.md)).

**S6 — feeding Phase-6 freshness (two clocks, not one).** Decay scoring needs `observed_at` + `last_verified_at` +
`verification_source` **per field**, on **two independent clocks**: Clock A on the master channel (the system
re-verifies the corpus once, on its own spend — [03:447,457](../03-database-design.md)) and Clock B on the overlay
snapshot (the workspace's frozen-at-reveal copy — [03 §5.2:544–546](../03-database-design.md),
[RESEARCH_06 §1:74–82](./RESEARCH_06_freshness.md)). Conflating them is the headline freshness error. The descriptor
must therefore exist **on both layers with independent timestamps** — which is exactly C's two-map shape: the master
map's `obs`/verify drive Clock A and the corpus re-verify priority queue; the overlay map's drive Clock B,
`freshness_status` (`fresh|aging|stale|expired`), and whether a re-reveal is a billable re-projection. A single-layer
substrate (a lone master ledger) cannot represent the overlay's *frozen* clock without copying the descriptor down —
i.e. it re-derives C's overlay map anyway.

**S7 — the human-review band.** Splink's middle band → `match_links.review_status='pending'`
([03:481–482](../03-database-design.md), [22:161–171](../22-data-quality-freshness-lifecycle.md)); a steward or
customer field-pick in that band must be recorded as a **pinned descriptor with the actor**, so the next ER pass reads
it as the highest-trust input and does not re-litigate it ("manual actions are data", RESEARCH_03 §B.6). All three
substrates can store the pinned flag; C and B store the actor/time cleanly. Note this is the **same mechanism as S3's
pin** — a review-band pick is just a steward pin minted from the review queue rather than a customer edit.

---

## 3. Challenging the obvious choice — is the normalized table (B) right after all?

After BRAINSTORM_01 §4.3, the "obvious" choice is **B** (a first-class normalized `field_provenance`/assertion
ledger). The gate must try to make it stick before rejecting it, and try to break C before adopting it. Four
genuine challenges, in both directions.

1. **B's strongest claim is real: per-field corroboration and per-cell unmerge fall out for free.** This is not
   hand-waving — `source_count = COUNT(DISTINCT source_name)` and `supersede`-one-row are genuinely cleaner in B than
   in C. The honest question is **what they cost** and **whether C can get them another way**. The cost is S1/S2: a
   trillions-row table re-written every freshness cadence. The "another way" is per-entity re-projection (S2), which
   is **bounded by cluster size** and produces the same `source_count` and the same post-unmerge result — just
   per-entity, not per-cell. So B's unique wins are real but **purchasable far more cheaply by C's bounded
   re-projection**; they do not justify a second store larger than the golden table.

2. **The "unbounded fan-out" charge against C was overstated.** BRAINSTORM_01 §3 argued C "re-parses every `raw_data`
   on demand" — true on the *read* path would be fatal, but C **never recomputes on read** (it reads the materialized
   map, C4); it recomputes only **on new evidence/unmerge**, over **one entity's small cluster**. The fan-out is
   bounded by cluster cardinality, and the ER design's whole job is to keep clusters small (blocking, the free-mail
   guard). The charge lands only on the high-degree super-node — a narrow, nameable case (OQ4), not the general one.

3. **B's row-explosion objection is decisively weaker for the genuinely multi-valued, separately-verified channels —
   and TruePoint *already* pays it there on purpose.** `master_emails`/`master_phones` are **already** a normalized
   per-`(person, channel-value)` table with `source_count`, `last_verified_at`, `verification_source`, `email_status`
   per row ([03:438–458](../03-database-design.md)). A person legitimately has *several* emails/phones, each with its
   own verification lifecycle and its own encrypted blind-index — that is a real multi-valued domain where one row per
   value earns its cost. **For flat scalar fields** (`job_title`, `full_name`, `seniority_level`, firmographics) a
   person has *one* current value; a normalized ledger there stores K source-rows to express one winner — pure
   overhead the descriptor map collapses. **This is the key that resolves BRAINSTORM_01's OQ1:** the "D-shaped"
   structure is warranted **only** for the multi-valued, separately-verified channels (where it already exists), and
   is **not** warranted as a *general* per-field ledger for scalar fields.

4. **But the challenge does not break B's *idea* — it relocates it.** B's idea (a per-field assertion with its own
   source/confidence/time) is correct; it is already realized for channels and is realized for scalar fields **as the
   per-field descriptor in C's map plus the verbatim per-payload evidence in `source_records`**. The descriptor *is*
   the winning assertion; the cluster's `source_records` *are* the candidate assertions (extractable on demand). So
   "C vs B" is not "winner-only vs all-assertions" — it is **"materialize the winner + defer candidates to the raw
   log (C)" vs "materialize every candidate as its own hot row (B)."** Given small clusters, C is strictly cheaper for
   the same answers.

The opposite challenge — "then drop B entirely, even for channels" — also fails: channels are genuinely multi-valued
and separately encrypted/verified, so collapsing them into a scalar descriptor would lose per-value status and the
per-value blind-index that DSAR/dedup need ([03:442,455](../03-database-design.md)). **You keep B exactly where it
already is (channels), and you use C everywhere else.** That is the synthesis.

---

## 4. DECISION

**Adopt Substrate C — a materialized JSONB winning-descriptor map on both layers — as the field-level provenance
substrate, fed by a deterministic per-entity-re-projected survivorship cascade over the `source_records` crosswalk,
and retain the existing normalized per-channel tables (a scoped, already-built instance of B) for the genuinely
multi-valued, separately-verified email/phone channels only. Reject Substrate A outright; reject Substrate B as a
*general* per-field ledger.** Concretely, the single direction that proceeds to the PLAN is five committed parts:

1. **`source_records` stays the crosswalk (the candidate set).** Unchanged from ADR-0021 — append-only,
   `content_hash`-idempotent, range-partitioned by `ingested_at`, cold in S3/Iceberg ([03:461–471,737](../03-database-design.md)).
   It is the MV-Register "retain every value" store; nothing is ever silently lost. The only requirement Phase-3 adds:
   the ER pipeline must write a `source_records` row **per field-contributing source** so the cluster is
   re-projectable per field ([06 §4:135–143](../06-enrichment-engine.md)).

2. **Survivorship is a pure deterministic per-field cascade, re-projected per entity — never blind LWW, never
   argmax-at-read.** The cascade is the named order **(human-pinned) → highest-`(source,field)`-trust → most-recent-verified
   → most-corroborated (`source_count`) → most-complete** ([ADR-0015:70–75](../decisions/ADR-0015-entity-resolution-dedup-engine.md),
   [06 §9:315–316](../06-enrichment-engine.md)), reusing `waterfall.ts:50–60` (trust order) and `dedup.ts:60–69`
   (`pickCanonical` tiebreaks) as signal sources. It runs over the **entity's cluster** on new evidence / unmerge —
   bounded by cluster size (§2 S2) — and **materializes** the result; the read path never recomputes (C4).

3. **The winning descriptor per field is a `field_provenance jsonb` map on the golden row (system-owned) AND on the
   overlay row (RLS-scoped).** Each key holds the small tuple `{winning_source_record_id, source_name, confidence,
   observed_at (valid-time), ingested_at (tx-time), source_count, is_pinned, pin_actor?, pin_at?}`. One column, no
   join, GIN-indexable, new fields need no migration; the master map carries **no** workspace column (C1) and the
   overlay map records a **platform-level source label only** (`master:verified|provider:apollo|user_edit`), never a
   contributing workspace (C2). This **generalizes the already-shipped per-channel provenance** to every flat field
   via one uniform structure (C3) and is the **read shape Substrate A wins on, without A's rigidity**.

4. **The pin lives on both layers, scoped correctly.** An **overlay pin** (user edit) is workspace-private, blocks a
   later reveal/enrichment from overwriting *that workspace's* value, and never mutates the golden record; a
   **master/steward pin** (set in the Splink review band, S7) is system-owned, audited via `withPlatformTx`, and
   affects every future reveal. The pin is the highest tier of the cascade (part 2) and a review-band pick is just a
   steward pin minted from `match_links.review_status` ([03:481–482](../03-database-design.md)). This resolves the U3
   overlay↔master reconciliation gap (RESEARCH_00 §7.2).

5. **Reversibility is replay, not a version table.** A whole-entity unmerge splits the cluster via
   `match_links.is_duplicate_of` and re-projects both sides' `source_records`, rebuilding each map
   ([06 §9:319](../06-enrichment-engine.md)); a per-field correction is the same re-projection scoped to the entity.
   No per-field SCD2/version chain — the immutable log already carries both time axes (`observed_at`/`ingested_at`).

**Where B is retained (the OQ1 resolution).** The normalized per-`(person, value)` shape is kept **only** for
`master_emails`/`master_phones` — already built into the design, genuinely multi-valued, each value separately
encrypted/blind-indexed/verified ([03:438–458](../03-database-design.md)). Their `source_count`/`last_verified_at`/
`verification_source` are the per-channel descriptor; the JSONB map references the *winning* channel per person. No
*general* `field_assertion` ledger for scalar fields is built. **This is a deliberate sharpening of BRAINSTORM_01
§4.3:** that gate reserved a seam for a D-shaped ledger and left granularity as OQ1; this gate, having stress-tested
the substrate against the merge/provenance hard cases specifically, **answers OQ1 in the narrow direction** —
D-shape for channels (exists), C-shape descriptor + bounded re-projection for everything else.

**How it feeds the consumers.** *Phase 2 (the edge):* `master_employment` gets the same `field_provenance` map shape
(or `entity_type='employment'` descriptors), giving the edge its missing `source/confidence/as-of` (the U2 gap); the
email-domain→`primary_domain` match strength is the edge's `confidence`, feeding the link-acceptance gate and the
`current_company_id` denormalization ([RESEARCH_02 §2.1,§2.3](./RESEARCH_02_linking_patterns.md)). *Phase 6
(freshness):* the descriptor's `observed_at`/`ingested_at`/`source_name`/verify fields are the per-field decay inputs;
because the map exists **on both layers**, Clock A (master re-verify priority queue) reads the master map and Clock B
(overlay `freshness_status`, billable re-reveal) reads the overlay map — the two clocks stay distinct
([RESEARCH_06 §1:74–82](./RESEARCH_06_freshness.md)).

**Explicitly rejected.** **A (wide per-field columns)** — fails S1 (sparse ~90-column hot table, migration per
field) and S4 (in-place overwrite destroys evidence); kept only as the *read shape* C reproduces. **B as a general
per-field ledger** — fails S1/S2 (tens-to-hundreds-of-billions of rows, re-written every freshness cadence, argmax-at-read
or is_current write-amplification); its unique wins (recomputable `source_count`, per-cell unmerge) are purchasable
far more cheaply by C's bounded per-entity re-projection (§3). **Blind LWW / whole-record overwrite** — the CRDT
lost-update anti-pattern (RESEARCH_03 §B.4); the current overlay `overwrite` exhibits it. **Reltio-style
derive-the-OV-at-read** — recomputing survivorship per attribute per read does not survive the billions-QPS index
feed (C4); materialize on write, recompute on new evidence only. **Any provenance structure carrying
`tenant_id`/`workspace_id` on the master, or naming a contributing workspace in an overlay descriptor** — breaks the
system-owned boundary and co-op privacy (C1/C2); security has final say (CLAUDE.md precedence).

### Open questions carried to the PLAN

- **OQ1 — descriptor `source_count` recompute trigger.** The map's `n` is a stored integer recomputed on
  re-projection. What *fires* a re-projection (new `source_record` for the cluster; a re-verify tick; an unmerge), and
  is a stored `n` accurate *enough* between re-projections, or does any read need a guaranteed-live count? (Bounds the
  Phase-6 ↔ Phase-3 interface.)
- **OQ2 — projection mechanism + fan-out bound.** Trigger on `source_records` insert, an incremental projector, or
  CDC/outbox-driven ([ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md))? What caps a single
  high-corroboration cell update so re-projecting one entity is never an N+1 against its own cluster?
- **OQ3 — overlay-map placement.** Is the overlay descriptor an extra `field_provenance jsonb` column on
  `contacts`/`accounts`, or a workspace-scoped child table? (The column keeps the one-row reveal read; a child table
  isolates the high-churn pin writes. Ties to Clock B and owner-scoped read.)
- **OQ4 — the high-degree super-node escape hatch.** Per-entity re-projection degrades for a celebrity/super-cluster
  entity (and the free-mail guard, BRAINSTORM_01 OQ6, must prevent the worst case). For the residual large clusters,
  is a *narrow* extracted corroboration index (a scoped instance of B, for high-degree entities only) ever needed, or
  does the cluster-size bound hold everywhere?
- **OQ5 — descriptor key shape vs PII.** The descriptor stores `winning_source_record_id` + non-PII metadata, never
  the PII value in clear (DSAR/erasure). Confirm channels (email/phone) reference the `master_emails`/`master_phones`
  row (which holds `value_enc` + blind-index) rather than duplicating PII into the map.
- **OQ6 — edge-provenance shape (Phase-2 handshake).** Does `master_employment` get its own `field_provenance jsonb`,
  or do edge attributes live as `entity_type='employment'` descriptors under the person's map? (Owned jointly with the
  Phase-2 PLAN; the substrate must not assume scalar-only fields.)
- **OQ7 — overlay pin vs CONTRIBUTE-TO.** A human correction is the highest-trust signal, but an un-contributed
  workspace edit must pin the **overlay** cell only and never touch the golden cell; an opt-in CONTRIBUTE-TO edit
  enters Layer 0 as `source_name='coop'`. Specify the exact merge so the two paths never cross
  ([ADR-0021:60–62](../decisions/ADR-0021-global-master-graph-and-overlay.md)).

**Implementation status (gap → work-to-do, never license to skip a rule).** Field-level provenance is **undesigned
anywhere** today — provenance is batch/job-level only (`source_imports` `contacts.ts:212-245`; `provider_calls`
`intel.ts:88-114`; `enrichment_job_rows.enriched_fields` `enrichmentJobs.ts:131`), and
[ADR-0006:51](../decisions/ADR-0006-per-workspace-multitenant-model.md) consciously accepted its absence (RESEARCH_00
§5). The backbone this decision builds on (`source_records`, `match_links`, `master_emails.source_count`/
`last_verified_at`) is **designed in [03 §5.1](../03-database-design.md) but not built**; the `field_provenance` JSONB
map on both layers, the two-layer pin, and the per-entity-re-projection survivorship function are the **net-new
Phase-3 invention**. None of these gaps relaxes a constraint: master provenance stays system-owned (no RLS column, no
foreign-workspace attribution — C1/C2), survivorship stays a deterministic per-field cascade (never blind LWW), human
pins outrank provider guesses, and the deterministic resolution keys stay backed by DB uniques
([03:442,464,716](../03-database-design.md)) so concurrent ingests cannot mint duplicates. The PLAN gate turns this
into concrete DDL (the descriptor key set, the map column on both layers, the channel-reference rule) and a
survivorship-function + projection-trigger spec.
