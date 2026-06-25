# Phase 0 — Scope & Sequencing of the Prospect↔Company Data Initiative

> **Gate: BRAINSTORM.** Phase 0 of the prospect↔company data initiative. This gate decides the
> **scope boundary** and the **phase dependency order** the whole body of work follows — *not* the
> schema (that is each phase's PLAN gate). **Depends on:** `RESEARCH_00_current_state.md` (the frozen
> BUILT/PLANNED/UNDESIGNED baseline — the degenerate `account_id` link, the four edge limits, the
> U1–U4 invention surface). **Cross-reads** the sibling research corpus it must sequence:
> `RESEARCH_01_entity_modeling.md` (canonical golden shape), `RESEARCH_02_linking_patterns.md` (the
> person↔company edge), `RESEARCH_03_mdm_merge.md` (merge/survivorship/field provenance),
> `RESEARCH_04_tenancy_projection.md` (the system-owned↔RLS boundary), `RESEARCH_05_read_path.md`
> (search/cache), `RESEARCH_06_freshness.md` (re-enrichment lifecycle). **Ground truth:** ADR-0021
> (the two-layer model), ADR-0037 (the `MatchPort` match-first seam), `03-database-design.md` §5.
> This gate generates ≥3 distinct scope framings, stress-tests them, challenges the default, and ends
> with a single DECISION. **No code, schema, SQL, or settings are modified — only this file is written.**

---

## 0. What this gate decides (and what it deliberately does not)

`RESEARCH_00` answered *"what exists today."* It closed with a recommended sequence (§9) — but a
recommendation buried in a research doc is not a ratified scope decision, and it has a tension with
the phase **numbering** the sibling docs assume (the research corpus is numbered `01 entities → 02
link → 03 merge → 04 tenancy → 05 read → 06 freshness`, i.e. *entities before link*, while
`RESEARCH_00 §9` argued *edge before entities*). This gate exists to resolve that tension on the
record before any PLAN gate freezes a migration.

**In scope for this gate:** (1) what the initiative *delivers* vs *defers* — the line between the MVP
build and the billions-scale track; (2) the order the six downstream phases execute and what each
unblocks; (3) the cross-cutting invariants that must be *designed* before the first table is frozen
even if they are *built* later; (4) the open questions the chosen direction carries into the PLAN.

**Out of scope (a PLAN gate owns each):** the Layer-0 DDL (that is `RESEARCH_01`→Phase-1 PLAN); the
edge columns (`RESEARCH_02`→Phase-2 PLAN); the field-provenance structure (`RESEARCH_03`→Phase-3
PLAN); any SQL, migration, or `@leadwolf/*` code. This document chooses the *shape of the road*, not
the *paving*.

---

## 1. The framing axis — what "first" can even mean here

Three structural facts constrain every framing, and naming them up front kills two false debates:

1. **The edge cannot literally be built before the entities it connects.** `master_employment` is a
   person↔company edge whose two endpoints are FKs to `master_persons` and `master_companies`
   (`03-database-design.md:428-436`; ADR-0021 Decision). You cannot land the edge table before the
   two entity tables exist. So *"edge-first"* can only mean **"the thin structural skeleton —
   entity *tables* + the edge + the overlay back-refs — populated by the cheap deterministic path,
   with the expensive resolution deferred."** It can never mean the edge in isolation.

2. **"Entities-first" is ambiguous, and the ambiguity is the whole argument.** It conflates two very
   different scopes: (a) the entity **tables** (empty shells with constraints), which *must* come
   before the edge by fact #1; and (b) **golden** entities — survivorship-merged records produced by
   the full Splink ER pipeline (ADR-0015 amended by ADR-0021; `RESEARCH_00 §4.2`). (a) is forced and
   cheap; (b) is the longest-lead, most expensive, infra-gated (M12/M13) work in the initiative
   (`ADR-0021` Consequences/Mitigation; `ADR-0037` Context). A framing debate that does not
   disambiguate these is arguing about nothing.

3. **Provenance is a cross-cutting *invariant*, not a phase.** Per-field `{source, confidence,
   updated_at}` (U1) and per-edge lineage (U2) touch *every column on every table* the initiative
   adds. `RESEARCH_01` already "reserved the field-provenance seam," `RESEARCH_03` materializes a
   JSONB `field_provenance` map "on write," and `RESEARCH_05` requires it "materialized on write,
   never derived at read on the hot path." That means provenance's **design** must lead the schema
   freeze (or every table is a retrofit migration) even though its **merge engine** is built later.
   "Provenance-first" therefore overloads two claims — *design-first* (true) and *build-first*
   (contestable) — and must be split.

With those pinned, the genuine axis is: **structure-before-resolution vs resolution-before-structure
vs cross-cut-before-both vs integration-before-depth.** Four distinct framings, below.

---

## 2. The candidate framings

### Framing A — Link-layer / structural-skeleton first (resolution deferred)

> **Thesis.** Land the Layer-0 entity *tables* + `master_employment` edge + overlay `master_*_id`
> back-refs as one schema, populate them from the import path using **only the deterministic match
> keys already shipped** (`matchKeys.ts`: email blind index → LinkedIn id → E.164 → registrable
> domain → name+company fuzzy fallback; `RESEARCH_00 §4.1`), keep `masterGraphMatcher` stubbed
> (`masterGraphMatcher.ts:26-34`), and **defer the Splink probabilistic tail + the billions-scale
> Citus/OpenSearch/ClickHouse/Iceberg topology** to a separate scale track.

- **Strongest argument.** It delivers the *"central design object"* — the person↔company edge with
  history + multi-affiliation + edge provenance, fixing all four limits in `RESEARCH_00 §3` — on the
  **existing single-Aurora stack**, with zero new infra and zero new normalizers (ADR-0037 forbids a
  second normalizer; reuse is mandatory). The expensive 90% of the work (probabilistic ER at scale)
  is exactly the part ADR-0021 itself stages as *"the scale path, not all required at MVP"*
  (`ADR-0021` Mitigation). Value lands first; cost lands last.
- **The failure mode that kills it.** **Deterministic-only resolution silently mints duplicate master
  entities.** Without the Splink fuzzy tail, two source rows for the same human that share *no* exact
  key (a maiden-name email + a nickname, no LinkedIn) each mint a fresh `master_persons` row. When the
  deferred ER pass finally runs, it must **merge** them — and every overlay row already pointing at
  the soon-to-be-loser `master_person_id` is now dangling/wrong. If the merge-and-repoint machinery
  is not designed alongside the skeleton, the skeleton accrues a silent corruption debt that the scale
  track inherits. *Mitigation a PLAN must carry:* treat `master_*_id` as a **mutable pointer with a
  re-point cascade**, never a stable identity, from day one (this is exactly `RESEARCH_06`'s
  propagation-without-breaking-owner-views problem, pulled forward).
- **Sequences before/after.** *Before:* nothing — it is the first build. *After:* match-first
  promotion (the `masterGraphMatcher` stub → real, ADR-0037 stage 2), then the scale track, then read
  path + freshness. Provenance is **designed with** the skeleton (reserved seam) and **built after**.

### Framing B — Canonical golden entities + full ER first (link on top of golden)

> **Thesis.** Stand up `master_persons`/`master_companies` *and* the full ER pipeline (deterministic
> keys → blocking + MinHash/LSH → Splink → survivorship → `match_links` clusters; ADR-0015/ADR-0021)
> to produce **golden** records first, then build the `master_employment` edge between records that
> are already deduped and survivorship-merged.

- **Strongest argument.** *Don't link garbage.* An edge between two un-deduped entities is itself
  duplicated — link Stripe-the-account to Jane-the-duplicate and you have a wrong edge that multiplies
  across every duplicate. Building ER first means every edge, every overlay back-ref, and every
  provenance record attaches to a **stable golden identity**, so nothing built later has to be
  re-pointed. It is the only framing where `master_person_id` is genuinely immutable from birth.
- **The failure mode that kills it.** **It front-loads the single most expensive, longest-lead,
  infra-gated component and blocks all value behind it.** The global ER pipeline needs
  Citus/OpenSearch/S3+Iceberg+Spark — staged at M12/M13 (`ADR-0021`; `ADR-0037` Context "Infra
  timing"). Worse, **ER cannot be calibrated in a vacuum**: the ≥0.95-precision / ≤0.5%-false-merge
  targets (`RESEARCH_00 §4.2`; ADR-0015) require a real linked corpus to *measure* false-merge rate
  against, and the review-threshold tuning is an explicit open question (ADR-0037 Consequences). You
  cannot tune the engine before you have the linked data the engine is supposed to produce — a
  chicken/egg that turns "entities-first" into "months of infra before the first edge."
- **Sequences before/after.** *Before:* the scale infra (Citus/OpenSearch/Spark) — which is its
  blocker. *After:* everything. This framing makes the scale track the *gate* rather than the *tail*.

### Framing C — Field-level provenance + merge first (the U1–U4 invention before structure)

> **Thesis.** Design and build the field-level provenance + survivorship machinery (U1 per-field
> `{source, confidence, updated_at}`, U2 edge lineage, U3 overlay↔master reconciliation, U4 overlay
> survivorship; `RESEARCH_00 §7.2`) *first*, because it is the genuinely **undesigned** surface and it
> touches every field, so retrofitting it after the tables exist is the worst migration.

- **Strongest argument.** Provenance is the one part with **no spec anywhere** (ADR-0006:51 names its
  absence; ADR-0021 adds only master-layer lineage). It is also the highest-leverage correctness
  rule: "user-entered outranks provider guess" (ADR-0015 survivorship) is unenforceable without it,
  and **retrofitting a per-field provenance map onto live `contacts`/`accounts` rows is a destructive
  backfill** — far cheaper to design before the columns are frozen. `RESEARCH_01`/`03`/`05` all
  already assume the seam is reserved at schema-freeze, which only happens if provenance leads.
- **The failure mode that kills it.** **Provenance with nothing to be the provenance *of* is
  abstract, and you over-build it.** A `{source, confidence, updated_at}` structure only earns its
  complexity when there are (a) real fields on real entities to attach it to and (b) **merge events**
  — two sources disagreeing about a value — to arbitrate. Build it first and you are designing a
  conflict-resolution engine against hypothetical conflicts, with no entity, no edge, and no ER pass
  to generate the disagreements it resolves. The likely outcome is a beautifully general provenance
  model that the actual entity/edge shapes (decided later in `RESEARCH_01`/`02`) then force you to
  rework anyway — provenance *design* is coupled to the field set it describes.
- **Sequences before/after.** *Before:* nothing — it claims primacy. *After:* entities, edge, ER.
  This is the framing the DECISION must **split**: its *design-first* claim is correct, its
  *build-first* claim inverts the dependency (you cannot build a merge engine before the records it
  merges).

### Framing D — Vertical "walking-skeleton" slice first (integration before depth)

> **Thesis.** Build none of the layers fully. Instead cut one **thin end-to-end slice** —
> a minimal Layer-0 (deterministic-only, one seed dataset), one `master_employment` edge, a masked
> search hit, the paid-reveal copy into the overlay, for a *single* import path — to validate the
> whole stack and the import-path matching invariant (ADR-0021) **end to end** before thickening any
> one layer.

- **Strongest argument.** The biggest *unknown* in this initiative is not any single table — the
  research has all six layers studied — it is whether the **import-path matching invariant** (*every
  overlay row resolves to a master entity*, ADR-0021 Decision) and the **system-owned↔RLS projection
  boundary** (`RESEARCH_04`) actually compose end-to-end without leaking. A vertical slice forces that
  integration to be real in week one and surfaces the boundary bugs while the blast radius is one
  dataset.
- **The failure mode that kills it.** **A walking skeleton drags the riskiest, longest-lead infra
  (the system-owned Layer-0 store + masked search) into week one and hardcodes the parts it stubs.**
  To get an end-to-end reveal you must stand up *some* of the non-RLS Layer-0 store and *some* search
  — the exact M12/M13 infra the project is trying to defer — just to prove an invariant that can be
  proven cheaper with a deterministic-only overlay-resolution slice (no new infra). The stubs it bakes
  in (a fake ER, a fixed provenance) risk hardening into the canonical shapes, which `RESEARCH_01/03`
  are supposed to decide deliberately, not inherit from a demo.
- **Sequences before/after.** *Before:* a sliver of every layer at once. *After:* widen each layer.
  Valuable as a **validation tactic inside** the chosen framing — not as the framing itself.

### 2.5 Summary

| Framing | One-line | Strongest argument | The failure that kills it |
|---|---|---|---|
| **A — structural skeleton first** | Tables+edge+overlay FKs, deterministic populate, ER/scale deferred | Delivers the central edge object on existing infra; expensive ER is correctly the tail | Deterministic-only mints duplicate masters → later ER merge re-points already-materialized overlay refs (corruption debt) |
| **B — golden entities + full ER first** | Splink survivorship before any link | `master_person_id` immutable from birth; never link garbage | Front-loads M12/M13 infra; ER can't be calibrated without a linked corpus → months before first edge |
| **C — provenance + merge first** | U1–U4 invention before structure | Provenance is the only truly undesigned surface; retrofit is a destructive backfill | A merge engine with no entities/edges/ER to produce conflicts → abstract, over-built, reworked when fields land |
| **D — vertical walking-skeleton** | Thin end-to-end slice before depth | Proves the import-path invariant + projection boundary integrate early | Drags the deferred M12/M13 infra into week one; bakes stubs into canonical shapes |

---

## 3. Stress-test matrix — each framing against the four hardest cases

The four cases the gate must survive: **(I) Layer 0 does not exist in code at all** (it is 100%
docs — `RESEARCH_00 §0`); **(II) the import-path matching invariant** (every overlay row resolves to
a master, ADR-0021); **(III) billions-scale ER cost** (the M12/M13 infra-gated tail); **(IV) the risk
of designing linking before the entities it links are golden.**

| Case | A (skeleton) | B (full ER) | C (provenance) | D (slice) |
|---|---|---|---|---|
| **(I) No Layer 0 in code** | **Best fit** — building the empty tables *is* the first act; cheap, additive, online `ALTER`/new tables on Aurora | Must also build the tables, *plus* the engine that fills them — far more to stand up before anything works | Cannot start: provenance has no table to hang on; blocked on (I) being done by A or B first | Builds a sliver of the tables — but also a sliver of the *non-RLS* store + search, the hardest part of (I) |
| **(II) Import-path invariant** | Holds **weakly**: deterministic match resolves the easy majority; the residual **mints a fresh master** per row (invariant satisfied, but Layer 0 carries duplicates until ER runs — see Q2) | Holds **strongly**: every row resolves to a deduped golden id — but only *after* the engine exists, so the invariant is unmet for the whole pre-M12 window | Orthogonal — provenance does not resolve identity; cannot satisfy the invariant by itself | Holds only for the **one** slice; says nothing about the general import path |
| **(III) Billions-scale ER cost** | **Deferred by design** — stub stays stubbed (ADR-0037), cost lands on the scale track, not MVP | **Front-loaded** — the worst possible time to pay it; blocks value | Independent of ER cost, but provenance volume (a map per field per row) is itself a billions-scale write — `RESEARCH_05` flags "materialize on write, lean docs" | Pulls a *taste* of the cost into week one via the search/Layer-0 sliver |
| **(IV) Link before golden** | **Accepts the risk, contains it** — links deterministic (not yet golden) entities, but treats `master_*_id` as a re-pointable pointer + designs the re-point cascade up front | **Eliminates the risk** — by definition only links golden entities | Sidesteps — builds no link | Links within one curated slice where "golden" is hand-controlled, so the risk is hidden, not answered |

**What the matrix shows.** Only **A** is well-formed against *all four* cases simultaneously: it is
the natural first move given (I), it satisfies (II) in the only way available pre-infra (mint-then-
merge), it defers (III) exactly where ADR-0021/0037 already put it, and it *contains* (IV) rather than
either ignoring it (D) or paying the full price to eliminate it (B). **B** is the only framing that
*eliminates* (IV) — but it does so by losing on (I), (II)-timing, and (III). **C**'s real contribution
is a *design* obligation, not a *build* order. **D** is a tactic, not a framing.

---

## 4. Challenging the obvious default (entities-first)

The obvious default — reinforced by the corpus numbering (`01 entities` precedes `02 link`) — is
**"build the golden entities first, then link them"** (Framing B). It is obvious for a good reason
(`don't link garbage`, case IV) and it must be challenged head-on, not waved past.

**The challenge has three prongs:**

1. **The default equivocates on "entity."** As §1 established, *entity tables* and *golden entities*
   are different scopes. The corpus numbering only requires the **tables** precede the **edge** — and
   they do, in Framing A, which lands them in the *same* migration as the edge (the FK forces
   co-landing; you cannot split `master_persons` from the edge that references it without a broken
   intermediate state). Reading the numbering as "*full ER* before linking" is a category error: it
   reads a table-ordering constraint as an engine-ordering mandate.

2. **"Golden" is not a precondition for a *correct* link — only for a *non-duplicated* one.** A
   deterministic edge between a not-yet-deduped person and a not-yet-deduped company is *correct* (the
   person really does work there); it is merely **not yet collapsed** with the duplicate edges that ER
   will later merge. The cost of that is *churn* (re-pointing on merge), not *wrongness*. Churn is
   schedulable and containable (treat `master_*_id` as mutable; design the cascade — `RESEARCH_06`).
   Wrongness is not. So the default trades a *containable* cost (churn) for an *uncontainable* one
   (months of blocked value + an un-calibratable engine). That is a bad trade.

3. **The default's own engine cannot be built first.** ER calibration (≥0.95 precision, ≤0.5%
   false-merge; ADR-0015) needs a labelled, linked corpus to measure against, and review-threshold
   tuning is explicitly open (ADR-0037 Consequences). The deterministic skeleton (A) is precisely what
   *produces* the corpus the probabilistic engine (B) needs to be tuned. So even on B's own terms,
   **A is a prerequisite for B**, not a competitor to it. "Entities-first" inverts a real dependency.

**Conclusion of the challenge:** entities-*tables*-first is not in dispute (it is forced and A does
it); entities-*golden*-first is wrong as a *starting* scope. The default survives only as the *target
state* of a later phase, not the first build.

---

## 5. DECISION

**Direction chosen: Framing A — structural-skeleton first — refined by absorbing C's correct half
(provenance designed, not built, up front) and using D as a validation tactic, not a framing.** In
one sentence: **land the Layer-0 entity tables + the `master_employment` edge + the overlay
`master_*_id` back-refs as one deterministic-only skeleton on the existing Aurora stack with the
field/edge-provenance seam *reserved* at freeze; defer the probabilistic ER tail and the
billions-scale topology to an explicitly-gated scale track; and treat `master_*_id` as a re-pointable
pointer with a merge cascade from day one.**

### 5.1 The scope boundary (the line this initiative draws)

| **IN scope (the MVP build, existing single-Aurora + Typesense stack)** | **OUT of scope → deferred SCALE TRACK (infra-gated, M12/M13)** |
|---|---|
| Layer-0 entity **tables**: `master_persons`, `master_companies`, `master_employment`, `master_emails`, `master_phones`, `source_records` (`03-database-design.md:390-486`) | Splink **probabilistic fuzzy-tail** ER + blocking/MinHash-LSH at billions (ADR-0015/0021; `RESEARCH_00 §4.2`) |
| Overlay back-refs `contacts.master_person_id` / `accounts.master_company_id`, **nullable** per ADR-0021's in-flight-staging clause, populated by the import path | `masterGraphMatcher` promotion stub→real (stays stubbed — ADR-0037 stage 2; `masterGraphMatcher.ts:26-34`) |
| **Deterministic-only** resolution reusing the shipped `matchKeys.ts` normalizers (no second normalizer — ADR-0037 forbids drift) | Citus shard of the golden store; OpenSearch global masked index; ClickHouse facet counts; S3+Iceberg lake + Splink-on-Spark (`03-database-design.md:722-753`) |
| The **field/edge-provenance seam reserved** at schema freeze (U1/U2): a column/structure exists so later build is additive, not a destructive backfill | The provenance **merge engine** (U4 survivorship application; conflict arbitration across sources) — designed in Phase 3, built after entities exist |
| `master_*_id` modelled as a **mutable pointer** + a re-point cascade contract (so a later merge cannot orphan overlay refs) | The **co-op CONTRIBUTE-TO** path — stays OFF by default; out of this initiative entirely (ADR-0021; D1 in `list-plan/02`) |

> **Implementation status.** Today none of the IN-scope items exist in code — Layer 0 is 100% docs
> (`RESEARCH_00 §0`), the only `master_person_id` reference is the FK-less soft column on
> `enrichment_job_rows` (`enrichmentJobs.ts:129`), and the overlay carries no `master_*_id`
> (`RESEARCH_00 §2.1/§2.2`). The scope boundary above is therefore *all* work-to-do; the OUT-of-scope
> column is **deferral, not omission** — it is the scale track ADR-0021 already stages, and the
> mint-then-merge debt (Q2) is the bridge the MVP must build *toward* it, never an excuse to skip it.

### 5.2 The phase dependency order

```
              ┌───────────────────────────────────────────────────────────────┐
   DESIGN ───►│ provenance seam (U1/U2) + projection boundary (RESEARCH_04)    │  designed up front,
   GATE       │ designed BEFORE schema freeze — they constrain the columns      │  built on their own phase
              └───────────────────────────────────────────────────────────────┘
                                       │ constrains
                                       ▼
   PHASE 1+2 (CO-LAND, one migration)  ┌───────────────────────────────────────┐
   entity TABLES ⊕ employment EDGE ⊕   │ the structural skeleton (Framing A)   │ ← the central design object
   overlay master_*_id back-refs       │ deterministic-only populate           │   (RESEARCH_01 shape, RESEARCH_02 edge)
              ┌──────────────────────────────────┘
              │ unblocks
              ▼
   PHASE 3    field-level + edge provenance + overlay↔master reconciliation (U1–U4)   ← build into the reserved seam
              │ (RESEARCH_03; the merge engine now has entities + edges to merge)
              ▼
   PHASE 2'   match-first wiring: keep masterGraphMatcher STUB; import path mints/links deterministically
              │ (ADR-0037 seam already exists — promotion is the scale track, not now)
              ▼
   PHASE 4    projection boundary BUILT: system-owned Layer-0 ↔ FORCE-RLS overlay; masked search + paid-reveal copy
              │ (RESEARCH_04; this is where the RLS-vs-system-owned tension is resolved in code)
              ▼
   PHASE 5/6  read path + search/cache (RESEARCH_05) · freshness + re-enrichment + job-change (RESEARCH_06)
              ▼
   SCALE TRACK (gated)  Splink fuzzy tail + Citus/OpenSearch/ClickHouse/Iceberg + promote masterGraphMatcher
                        ⇒ the deferred ER MERGES the deterministic duplicates → re-point cascade fires (Q2)
```

**Why this order and not the corpus numbering.** Phase 1 (entities) and Phase 2 (edge) **co-land as a
single migration** because the edge FKs the entities (§1, fact #1) — they cannot be separately
released without a broken intermediate. The *research* is still done in numbered order (`RESEARCH_01`
fixes the golden shape, `RESEARCH_02` the edge), but the *build* is one unit. Provenance design
(`RESEARCH_03`) and the projection boundary (`RESEARCH_04`) are pulled **forward as design
constraints** on that freeze (so the seam and the access path are reserved) even though they are
**built** on their own later phases — this is C's correct half (design-first) without C's wrong half
(build-first). The scale track is the **tail**, gated, exactly per ADR-0021's mitigation.

### 5.3 What this DECISION explicitly rejects

- **Rejects Framing B as the *starting* scope** (golden-entities/full-ER first). It front-loads the
  M12/M13 infra, blocks all value behind it, and cannot be calibrated without the linked corpus that
  the skeleton (A) is what produces — A is a *prerequisite* for B, not its rival (§4). B's golden-
  identity goal is the **target state** of the scale track, not the first build.
- **Rejects Framing C as a *build* order** while adopting its *design* obligation. Provenance leads
  the **freeze** (reserved seam) but cannot lead the **build** — a merge engine needs entities, edges,
  and ER-produced conflicts to arbitrate, none of which exist first (§2 Framing C; §5.2).
- **Rejects Framing D as the framing**, retains it as a tactic. A walking-skeleton demo is a fine way
  to *validate* the import-path invariant inside Phase 1+2 on a seed dataset, but as the organizing
  scope it drags the deferred non-RLS store + masked search into week one and risks hardening stubs
  into canonical shapes.
- **Rejects "just port `03 §5.1` DDL and call it done"** (carried from `RESEARCH_00 §9`). The DDL is
  the Phase-1+2 *target*, but it specifies neither U1–U4 (per-field/edge provenance, reconciliation)
  nor the re-point cascade — porting it alone ships Layer 0 with the provenance blindness ADR-0006:51
  consciously accepted.
- **Rejects NOT-NULL overlay master FKs on day one.** ADR-0021 reserves nullability for in-flight ER
  staging (`ADR-0021:63-65`); the control on the import-path invariant is an **import-path assertion +
  backfill + the re-point cascade**, never a column constraint that would break the staging window.
- **Rejects any erosion of the FORCE-RLS overlay posture or the two-tenant isolation itest gate** to
  ease Layer-0 integration. Security has final say (CLAUDE.md precedence); the system-owned↔RLS
  boundary is *resolved* in Phase 4 (`RESEARCH_04`), never by relaxing the overlay's isolation.

---

## 6. Open questions carried into the PLAN

The chosen direction is well-formed but carries six questions a PLAN gate must answer. They are the
*known* costs of deferring ER, not objections to the decision.

1. **Mint-then-merge cluster stability (the A-killer, contained).** When the deferred Splink pass
   merges two deterministically-minted `master_persons`, every overlay `master_person_id` pointing at
   the loser must be re-pointed. **Q:** is `master_*_id` a mutable pointer with a `match_links`-driven
   re-point cascade (chosen lean), or a stable surrogate with an indirection table? What is the
   acceptable churn rate, and does the re-point fire synchronously or as an async sweep
   (`RESEARCH_06` propagation)? *This is the question that makes or breaks Framing A.*
2. **Import-path invariant under a stubbed matcher.** With `masterGraphMatcher` stubbed and ER
   deterministic-only, "every overlay row resolves to a master entity" is satisfied by **minting a
   fresh master per unmatched row** — correct, but it inflates Layer-0 duplication until ER runs.
   **Q:** is mint-then-merge the ratified semantics, and what is the tolerated pre-ER duplicate rate in
   `master_persons`/`master_companies`?
3. **Provenance seam — minimal reservation.** The seam must be reserved at freeze without pre-deciding
   Phase 3's model. **Q:** reserve a single JSONB `field_provenance` column (the `RESEARCH_03`/`05`
   "materialize on write" shape) vs a side table — what is the *minimum* reservation that keeps Phase 3
   additive and does not pre-commit the merge design?
4. **Where Layer 0 physically lives pre-scale.** **Q:** same Aurora instance as the overlay (a
   separate non-RLS schema + a non-`leadwolf_app` role) or a separate database from day one? This
   directly shapes the Phase-4 system-owned↔RLS boundary (`RESEARCH_04`) and the migration path to
   Citus — and it is the first place the "shared canonical infra under a default-RLS model" tension
   becomes concrete (`RESEARCH_00 §6`).
5. **Backfill of the existing overlay.** Millions of live `contacts`/`accounts` rows have an
   `account_id` link and **no** `master_*_id`. **Q:** one-time batch backfill, lazy-on-read, or
   on-next-touch resolution — and how does the existing per-workspace `accounts` (dedup by
   `(workspace_id, domain)`, `RESEARCH_00 §2.1`) reconcile into shared `master_companies` without
   collapsing distinct workspace records prematurely?
6. **The scale-track trigger.** The deferred ER + topology is gated, not cancelled. **Q:** what
   concrete signal promotes it from deferred to active — a `master_*` row-count threshold, a measured
   duplicate/false-merge complaint rate, or the fixed M12/M13 roadmap milestone — and who owns that
   call (the FinOps/scale gate per `truepoint-operations`)?
