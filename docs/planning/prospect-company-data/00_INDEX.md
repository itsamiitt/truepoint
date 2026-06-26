# Prospect ↔ Company Data Architecture — Index

> **Entry point** for the prospect↔company data-architecture initiative: the design for managing **prospect
> (person) data** and **company (account) data**, and the **linking layer** that resolves a prospect to its
> company. The work is grounded in the already-accepted two-layer model
> ([ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md)): a **system-owned Layer-0 master graph**
> (`master_persons`/`master_companies`/`master_employment`/`master_emails`/`master_phones`/`source_records`/
> `match_links`) + a **per-workspace, RLS-FORCED Layer-1 overlay** (`contacts`/`accounts`). The **central design
> object is `master_employment`** — the person↔company affiliation edge (current + past), which replaces the
> degenerate single `contacts.account_id` FK. The corpus follows a strict **RESEARCH → BRAINSTORM → PLAN** gate
> per phase; every PLAN freezes a target schema, the RLS implications, a scale-gate analysis, failure modes, and
> open questions, and traces back to its brainstorm decision + research recommendation.
>
> **Status:** design corpus complete (26 docs). **Everything here is 100% docs** — Layer 0, the overlay
> `master_*_id` FKs, field-level provenance, and the read/freshness/migration machinery are *designed, not built*
> (`PLAN_00` C1). The gap is the build; it is never a license to skip a rule (security has final say — CLAUDE.md
> precedence). House style: [list-plan/02-data-model.md](../list-plan/02-data-model.md).

---

## 1. File manifest (26 docs)

| Phase | RESEARCH (gate 1) | BRAINSTORM (gate 2) | PLAN (gate 3) |
|---|---|---|---|
| **0 — Current-state audit & constraints** | [RESEARCH_00_current_state.md](./RESEARCH_00_current_state.md) — what's BUILT/PLANNED/UNDESIGNED today | [BRAINSTORM_00_scope.md](./BRAINSTORM_00_scope.md) — scope framings → Framing A (structural-skeleton-first) | [PLAN_00_constraints_and_scope.md](./PLAN_00_constraints_and_scope.md) — **the spine**: C1–C10, scope, vocabulary, gap-to-target, dependency order |
| **1 — Canonical entity model** | [RESEARCH_01_entity_modeling.md](./RESEARCH_01_entity_modeling.md) — owned-graph market + MDM/temporal patterns | [BRAINSTORM_01_entity_options.md](./BRAINSTORM_01_entity_options.md) — 4 entity shapes → B-backbone + D-ledger + C-selective | [PLAN_01_canonical_entities.md](./PLAN_01_canonical_entities.md) — `master_*` tables, bi-temporal-vs-SCD decision, ER integration |
| **2 — The linking layer** | [RESEARCH_02_linking_patterns.md](./RESEARCH_02_linking_patterns.md) — edge vs FK, job-change, multi-affiliation | [BRAINSTORM_02_link_options.md](./BRAINSTORM_02_link_options.md) — 3 link models → SCD2 edge as a derived projection | [PLAN_02_affiliation_edge.md](./PLAN_02_affiliation_edge.md) — `master_employment` schema, job-change tx, `current_company_id`, overlay reconciliation |
| **3 — Merge & field provenance** | [RESEARCH_03_mdm_merge.md](./RESEARCH_03_mdm_merge.md) — survivorship + per-field provenance storage | [BRAINSTORM_03_merge_options.md](./BRAINSTORM_03_merge_options.md) — 3 substrates → Substrate C (JSONB winner-map) | [PLAN_03_merge_and_provenance.md](./PLAN_03_merge_and_provenance.md) — `field_provenance` map, the per-field cascade, the pin, reversibility |
| **4 — Tenant & owner projection** | [RESEARCH_04_tenancy_projection.md](./RESEARCH_04_tenancy_projection.md) — shared infra under RLS; grant-off is the wall | [BRAINSTORM_04_projection_options.md](./BRAINSTORM_04_projection_options.md) — 3 projections → copy-on-reveal channel store | [PLAN_04_tenant_owner_views.md](./PLAN_04_tenant_owner_views.md) — `revealed_channels`, `leadwolf_reveal`, masked-search/paid-reveal as the only Layer-0 paths |
| **5 — Read path, search & caching** | [RESEARCH_05_read_path.md](./RESEARCH_05_read_path.md) — flatten the low-churn traits; CQRS index-as-read-model | [BRAINSTORM_05_read_options.md](./BRAINSTORM_05_read_options.md) — 3 substrates → surface×query-class composite | [PLAN_05_search_and_cache.md](./PLAN_05_search_and_cache.md) — routing table, OpenSearch doc, ClickHouse facets, `search_outbox`, RYOW |
| **6 — Freshness & lifecycle** | [RESEARCH_06_freshness.md](./RESEARCH_06_freshness.md) — two clocks, decay, job-change detection | [BRAINSTORM_06_lifecycle_options.md](./BRAINSTORM_06_lifecycle_options.md) — 4 triggers → budgeted decay-priority queue | [PLAN_06_lifecycle.md](./PLAN_06_lifecycle.md) — `verification_jobs`, in-use gate, the job-change pipeline, `reveal_epoch` |
| **7 — Migration & rollout** | [RESEARCH_07_migration.md](./RESEARCH_07_migration.md) — expand/contract, dual-write, shadow-read, grant-off | [BRAINSTORM_07_rollout_options.md](./BRAINSTORM_07_rollout_options.md) — 4 rollouts → Option D (per-workspace, on proof) | [PLAN_07_rollout.md](./PLAN_07_rollout.md) — the D1–D8 sequence, grant-off first, `migration_cutover_state`, shadow parity |
| **—** | — | — | [FUTURE_OPPORTUNITIES.md](./FUTURE_OPPORTUNITIES.md) — what the graph unlocks (org charts, intent layering, ABM, ML match, warm-intro), ranked value vs effort |

---

## 2. Phase dependency order

> **Two orderings, deliberately distinct.** The **corpus numbering** (00→07) is the *research/reading* order. The
> **build order** (`PLAN_00 §7`) differs in one structural way: **Phase 1 and Phase 2 co-land as one migration**
> because the edge FKs the entities (you cannot release `master_persons` and an edge that references it in
> separate steps without a broken intermediate). Two design inputs (the provenance seam, the projection boundary)
> are *designed* before the freeze even though they are *built* later.

```
  [design inputs]  provenance seam (C6) ─┐    projection boundary (C7) ─┐
                                          └──────────────┬──────────────┘ constrain the freeze
                                                         ▼
   PHASE 1 + PHASE 2  ── CO-LAND (one migration) ──  master_* entity TABLES ⊕ master_employment EDGE ⊕ overlay master_*_id
                                                         │ unblocks
                                                         ▼
   PHASE 3  field_provenance + survivorship cascade + overlay↔master reconciliation (needs real entities+edges to merge)
                                                         │
                                                         ▼
   PHASE 4  projection boundary BUILT (revealed_channels; grant-off wall; masked search + paid reveal)
                                                         │
                                                         ▼
   PHASE 5  +  PHASE 6   read path / search / cache   ·   freshness / re-enrichment / job-change   (parallel, interdependent)
                                                         │ then, gated
                                                         ▼
   PHASE 7  rollout — lands all of the above online (grant-off FIRST; build offline, flip per-workspace on proof)
                                                         │ then (separately gated, M12/M13)
                                                         ▼
   SCALE TRACK  Splink tail + Citus/OpenSearch/ClickHouse/Iceberg  ⇒  ER merges duplicates  ⇒  the C4 re-point cascade fires
```

| Dependency edge | One-line rationale |
|---|---|
| provenance-seam **design** → schema freeze | the seam touches *every* column the initiative adds; designing it after the freeze is a destructive backfill (`PLAN_00` C6, F5). |
| projection-boundary **design** → schema freeze | the access path decides which `master_*` columns are revealable and where Layer 0 physically lives — a freeze input (`PLAN_00` C7). |
| Phase 1 ⊕ Phase 2 **co-land** | `master_employment` FKs `master_persons`/`master_companies`; they cannot ship in separate releases without a broken intermediate (`PLAN_00 §7`). |
| Phase 1+2 → Phase 3 | a survivorship/merge engine needs real entities + edges to merge and conflicts to arbitrate (`PLAN_03 §1`). |
| Phase 3 → Phase 4 | a reveal copies a master value into the overlay — per-field reconciliation + the descriptor must exist before that copy is correct (`PLAN_04 §0.3`). |
| Phase 4 → Phase 5/6 | you optimize the read path + re-enrichment loop only after masked-search/paid-reveal projection is real (`PLAN_05`/`PLAN_06`). |
| Phase 5 ⇄ Phase 6 | the read path consumes `search_outbox` that the freshness re-projection emits; freshness consumes the edge + provenance the read path serves — mutually referencing, co-built. |
| Phase 5/6 → Phase 7 | the migration lands the whole stack online — and cannot cut reads over until the master-backed read surface (Phase 5) exists. |
| Phase 7 → scale track | the deferred ER merges the deterministic duplicates → the `PLAN_00` C4 re-point cascade fires (gated, `PLAN_00 §11.6`). |

---

## 3. Recommended reading order

1. **[PLAN_00](./PLAN_00_constraints_and_scope.md) first, always** — the C1–C10 constraints, the shared vocabulary,
   and the gap-to-target every other doc cites verbatim. Read its §1 (constraints) and §3 (vocabulary) before anything else.
2. **Then the central problem:** [RESEARCH_02](./RESEARCH_02_linking_patterns.md) → [BRAINSTORM_02](./BRAINSTORM_02_link_options.md)
   → [PLAN_02](./PLAN_02_affiliation_edge.md) — the `master_employment` edge is the thing the whole initiative exists to build.
3. **Then the foundation it sits on:** Phase 1 (entities) and Phase 3 (provenance) — they co-define the golden record the edge links.
4. **Then the access + serving layers:** Phase 4 (projection) → Phase 5 (read) → Phase 6 (freshness).
5. **Then how it ships:** Phase 7 (rollout).
6. **Last:** [FUTURE_OPPORTUNITIES.md](./FUTURE_OPPORTUNITIES.md) for where it goes next.

For a fast executive pass: read **PLAN_00 §1–§4**, then the **DECISION** section of each BRAINSTORM (00–07), then
the **Target schema** + **Scale-gate** sections of PLAN_02/03/04/07.

---

## 4. Cross-phase coherence notes

> An adversarial read across the eight PLANs for schema agreement, gate compliance, required-section presence,
> cross-phase gaps, and constraint violations. **Verdict: coherent.** The plans share one schema spine, every gate
> is present, every PLAN carries the five required sections + a pre-build pass + an honest Implementation-status
> note, and no plan violates C1–C10. The items below are recorded honestly as follow-ups, not blockers.

**What agrees across the corpus (verified):**
- **The two-layer model + RLS posture** is identical everywhere: Layer 0 system-owned, *no* `workspace_id`, *no*
  RLS predicate, grant-off (`leadwolf_app` has no `master_*` grant); Layer 1 `ENABLE`+`FORCE` RLS with the
  fail-closed `NULLIF` GUC; within-workspace visibility is app-layer, not RLS (C7/C8/C10). Stated consistently in
  PLAN_01 §5, PLAN_02 §RLS, PLAN_03 §RLS, PLAN_04 §RLS, PLAN_05 §RLS, PLAN_06 §RLS, PLAN_07 §RLS.
- **The `master_employment` edge shape** (SCD2; `is_current`/`is_primary`; `started_on '-infinity'` sentinel;
  `uniq_employment_stint`; `uniq_employment_primary`; the derived cache columns) is frozen once in PLAN_02 and
  reused unchanged by PLAN_06 (the job-change tx) and PLAN_05 (the read).
- **`current_company_id`** is consistently "a derived cache of the `is_primary` edge, never hand-set" (PLAN_01 §2.3,
  PLAN_02 §2.2, PLAN_05 §2.2, PLAN_06 §3.2 step 6).
- **The forward-reference seams all resolve:** `employment_change_outbox` (reserved PLAN_02 §1.1 → finalized
  PLAN_06 §0.4); `reveal_epoch` (debt opened PLAN_04 F8/OQ3 → closed PLAN_06 §0.5 without relaxing the reveal
  unique); `search_outbox` (emitted PLAN_03 §1.3 → consumed/frozen PLAN_05 §2.1); the least-privilege roles
  (`leadwolf_reveal` PLAN_04, `leadwolf_verify`/`leadwolf_sweep` PLAN_06, `leadwolf_er`/`leadwolf_search_sync`/
  `leadwolf_shadow` PLAN_07 §0.1, collected by the migration).
- **Reuse-first discipline holds:** every plan builds on the shipped `matchKeys.ts` (one normalizer, C5),
  `dataHealth.ts` (the score/decay math), `waterfall.ts` (trust÷cost), `match_links.review_status` (one review
  queue), and `enrichment_jobs` (the bulk ledger) — no parallel machinery (ADR-0037 anti-drift).

**Follow-ups (resolved tensions / residuals, not contradictions):**
- **[medium] The provenance shape evolved between Phase 1 and Phase 3 — reconcile the naming.** PLAN_01 §2.7
  tentatively reserved a *normalized* `field_assertion` ledger as the provenance seam; PLAN_03 — which **owns** the
  provenance build per C6 — decided a *JSONB* `field_provenance` winner-map instead, retaining the normalized shape
  **only** for the `master_emails`/`master_phones` channels. This is a **deliberate, documented supersession**
  (PLAN_03 §0 explicitly resolves the RESEARCH_03↔BRAINSTORM_01 tension and answers BRAINSTORM_01's OQ1), not a
  contradiction: PLAN_01 reserved only the *contract* (golden cell = rollup of provenance) and the golden DDL is
  unaffected either way. **Action:** before build, update PLAN_01 §2.7's `field_assertion` references to point at
  PLAN_03's realized `field_provenance` as the canonical shape, so an implementer reads one name. (A future
  ADR-0041 — §5 — is the right place to ratify it.)
- **[low] Several residual numbers are explicitly deferred to calibration, with owners named** — the shadow-read
  parity threshold + sample rate (PLAN_07 OQ2), the field-confidence constants (PLAN_03 NQ1), the priority weights +
  in-use recency window (PLAN_06 OQ1/OQ2), the re-reveal pricing (PLAN_06 OQ5), the masked-search privacy thresholds
  (PLAN_05 NQ1), and the search/freshness SLOs (PLAN_05/06). Each is *deferral with an owner* (`truepoint-operations`
  / `truepoint-security` / ADR-0024/0013), not omission.
- **[low] The billions-scale topology + probabilistic ER tail are a single gated SCALE TRACK** (`PLAN_00` C9),
  consistently deferred across PLAN_01/02/05/06/07 (Citus, OpenSearch, ClickHouse, Iceberg, Splink, the
  `masterGraphMatcher` stub→real). The MVP delivers the edge + provenance design on the existing single-Aurora +
  Typesense stack; the C4 mint-then-merge re-point cascade is the designed bridge to the track.

**Process note (transparency).** PLAN_05, PLAN_06, and PLAN_07 plus this index and FUTURE_OPPORTUNITIES were
finalized after the generation run hit a usage limit mid-synthesis; PLAN_05/06 had already been written and were
verified complete, and PLAN_07/FUTURE/this index were authored against the completed sibling corpus. All 26 docs
are present and the gate ordering (research→brainstorm→plan) is intact.

---

## 5. Relation to existing ADRs / docs

This corpus **elaborates** existing accepted decisions; it does not contradict them:
- [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md) — the two-layer model + the
  `master_employment` link this entire initiative details.
- [ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md) — the Splink ER engine (the deferred
  probabilistic tail, `PLAN_00` C9; the deterministic-only MVP, C5).
- [ADR-0037](../decisions/ADR-0037-bulk-match-first-resolution-and-candidate-index.md) — the `MatchPort` seam the
  backfill + dual-write reuse (PLAN_07 §2.1); the single-normalizer anti-drift rule (C5).
- [ADR-0039](../decisions/ADR-0039-bulk-enrichment-pipeline.md) / [ADR-0036](../decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)
  — the bulk job + ledger the re-verify campaign + backfill ride (PLAN_06 §2.3, PLAN_07 §0).
- [ADR-0007](../decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md) / [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md)
  — the reveal/credit/charge-for-verified machinery the projection + re-reveal preserve (PLAN_04/06).
- [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md) / [ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md)
  / [ADR-0022](../decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md) — freshness, search topology,
  and team/visibility, built on by PLAN_06/05/04.
- [03-database-design.md §5.1/§5.2](../03-database-design.md) — the planned Layer-0 + overlay DDL these PLANs freeze.

**A future ADR-0041** is the natural place to ratify the parts this corpus *invents* beyond the existing ADRs:
the **field-level provenance design** (`field_provenance` JSONB + the per-field survivorship cascade — undesigned
anywhere before Phase 3), the **`revealed_channels` projection** + `leadwolf_reveal` role (Phase 4), the
**per-workspace shadow-gated rollout** + grant-off-first migration (Phase 7), and the `field_assertion`→
`field_provenance` reconciliation (§4). Until then, these PLANs are the design of record for the build.
