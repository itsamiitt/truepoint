# FUTURE_OPPORTUNITIES — what more the prospect↔company graph unlocks

> **Synthesis doc** for the prospect↔company data initiative. Once the eight-phase target lands — the Layer-0
> master graph (`PLAN_01`), the `master_employment` edge (`PLAN_02`), field-level provenance (`PLAN_03`), the
> projection boundary (`PLAN_04`), the read path (`PLAN_05`), the freshness machine (`PLAN_06`), and the rollout
> (`PLAN_07`) — the *graph itself* becomes a platform other products build on. This doc catalogs those
> opportunities, says exactly **which master_* table / phase / edge each builds on**, and **ranks them by value
> vs effort**. It proposes no schema and writes no code; it is a roadmap input. Cross-cutting rule carried from
> the spine (`PLAN_00`): every opportunity below stays **system-owned at Layer 0 + masked/metered to the
> workspace** (C7), **owner-scoped at Layer 1** (C10), and **bounded at billions** (C9) — none is a license to
> open the universe or break a wall. Several are explicitly **deferred SCALE-TRACK** items (`PLAN_00` C9), surfaced
> here so the foundation is laid for them, not built prematurely.

---

## 0. Why the foundation makes these cheap

The degenerate `contacts.account_id` link (one company, no history, no shared identity) could support *none* of
the below — every one needs the three things the initiative adds: a **shared canonical identity** (`master_persons`/
`master_companies`), a **first-class affiliation edge with history** (`master_employment`, current + past), and
**provenance + confidence** on every value (`field_provenance`). That is the whole point of choosing the edge
model over the FK: the edge is a graph, and a graph composes. The opportunities are mostly *new read surfaces and
new edge types over the same golden core* — additive, not a re-architecture.

---

## 1. The ranked catalog (value vs effort)

> **Value** = revenue/differentiation impact. **Effort** = build cost incl. data-sourcing + infra. **On the
> SCALE-TRACK?** = whether it needs the deferred Citus/OpenSearch/ClickHouse/Splink/Iceberg tail (`PLAN_00` C9)
> before it is feasible at billions. Ranked by value-to-effort (do the top rows first).

| # | Opportunity | Value | Effort | Builds on (table · phase) | Scale-track? |
|---|---|---|---|---|---|
| **O1** | **Job-change & champion-move alerts** | High | **Low** | `employment_change_outbox` · Phase 6; `intent_signals` (shipped); the `alerts`/`notifications` domains | No |
| **O2** | **Account-based views / buying-committee rollups** | High | **Low–Med** | `master_employment` + `current_company_id` · Phase 2; ClickHouse `person_facets` · Phase 5 | Partly (CH facets) |
| **O3** | **Account hierarchy rollups (parent ⇄ subsidiary)** | High | **Med** | `master_companies.parent_company_id` · Phase 1; `alt_domains[]` | No |
| **O4** | **Intent + technographic layering on the edge/read doc** | High | **Med** | `master_companies.technographics` · Phase 1; `intent_signals` (shipped); the flattened doc · Phase 5 | Partly |
| **O5** | **Org-chart / reporting-line graph** | High | High | a NEW `master_reporting` edge over `master_employment` · Phase 1/2 | Yes (graph scale) |
| **O6** | **Relationship / warm-intro graph (colleague + alumni)** | High | High | derived person↔person edges over `master_employment` (shared company/tenure) | Yes |
| **O7** | **ML-assisted match confidence + active-learning the review queue** | High | High | `match_links` + `field_provenance.conf` · Phase 3; the Splink tail | **Yes** (the C9 ER tail) |
| **O8** | **Look-alike / ICP modeling** | Med–High | High | `master_*` firmographics · Phase 1; the shipped `ai/` layer | Yes |
| **O9** | **Data-coop flywheel (CONTRIBUTE-TO turned on)** | Med–High | High | `source_records(source_name='coop')` + the cascade · Phase 3 | No infra; **heavy compliance** |
| **O10** | **Provenance-as-a-product ("where did this come from", confidence UI)** | Med | **Low** | `field_provenance` descriptor · Phase 3/4 (already surfaced non-PII) | No |
| **O11** | **Time-travel / point-in-time account intelligence** | Med | Med | `source_records` replay-as-of + edge SCD2 history · Phase 1/2/3 | Partly (lake) |

---

## 2. The opportunities, in detail

### O1 — Job-change & champion-move alerts *(High value · Low effort — do first)*
**What.** Surface the job changes Phase 6 already detects as **workspace playbooks**: "your revealed champion at
Acme moved to Globex → a warm opener at a new account," "a buyer you lost re-surfaced at a target account,"
"N contacts at your ICP companies changed roles this week."
**Builds on.** `employment_change_outbox` (`PLAN_06 §0.4`, the candidate→commit machine) already emits a corroborated
`employer_change`/`title_change`/`new_hire` event; the fan-out already writes a `job_change` `intent_signal`
(shipped `intel.ts:80-81`) into each holding workspace (`PLAN_06 §3.3` rule 3), RLS-scoped + owner-filtered. This
opportunity is the **alert/playbook surface** over that signal — the detection is built; only the customer-facing
trigger UI + sequence-enrollment hook is new.
**Value.** Job changes are the single highest-intent B2B signal (a champion who already bought, now at a new
account with budget). It monetizes the freshness machine directly and drives re-reveals (`PLAN_06 §3.4`).
**Risk/cost.** Low — bounded by the async, idempotent fan-out already designed; the only new work is the
trigger/notification surface (the shipped `alerts`/`notifications` domains) + a re-reveal CTA.

### O2 — Account-based views / buying-committee rollups *(High value · Low–Med effort)*
**What.** "Show me *everyone* at Acme, grouped by department and seniority" — the buying committee — and let a rep
work the account, not just the contact. Roll the person graph up to the company.
**Builds on.** `master_employment` + `master_persons.current_company_id` (`PLAN_02`) *is* the company→people edge;
`idx_employment_company … WHERE is_current` (`PLAN_02 §0.1`) and the ClickHouse `person_facets` mirror
(`PLAN_05 §2.4`, keyed/facetable by `current_company_id` + `seniority_level` + `department`) make the rollup a
**facet query, never an OLTP join** (`PLAN_02 §5` rank 2; "everyone at @google.com is a ClickHouse facet").
**Value.** Account-based selling (ABM/ABS) is the dominant enterprise motion; this is the account-graph product
ZoomInfo/Apollo monetize. The data is already modeled — it is a new read surface.
**Risk/cost.** Low–Med — needs the masked-search/account-facet surface (`account-search` domain is shipped for the
overlay) extended to the global graph; per-person reveal economics unchanged (each committee member is a metered
reveal, `PLAN_04`).

### O3 — Account hierarchy rollups (parent ⇄ subsidiary) *(High value · Med effort)*
**What.** Global-account views: roll subsidiaries up to the ultimate parent ("Alphabet" → Google, DeepMind,
Waymo…), de-duplicate "the same logo three ways," and let an enterprise rep see the whole org tree.
**Builds on.** `master_companies.parent_company_id` (the self-FK, `PLAN_01 §2.2`) + `alt_domains[]` (redirects,
acquired brands, country TLDs). The hierarchy column exists at freeze; this populates and traverses it.
**Value.** Enterprise/strategic-account teams need the legal-entity tree; it also improves match precision
(a subsidiary domain resolves to the right node, not a false-merge into the parent).
**Risk/cost.** Med — needs a corporate-hierarchy data source (registry/feed) and a bounded recursive-CTE or a
materialized closure table for deep trees; the column + `alt_domains` are already first-class.

### O4 — Intent + technographic layering on the edge/read doc *(High value · Med effort)*
**What.** "People at companies that (a) use Snowflake, (b) are showing surging intent on 'data observability', and
(c) match my ICP firmographics" — compound person×company×signal filtering in one query.
**Builds on.** `master_companies.technographics` (jsonb, GIN-faceted, `PLAN_01 §2.2`) is already in the flattened
`master_persons_v1` doc as `company_technographics` (`PLAN_05 §2.2`); `intent_signals` (shipped `intel.ts`) and
`master_companies.employee_band`/`industry` are facets. This layers the **signal** dimension onto the read doc.
**Value.** Technographic + intent targeting is premium ("Diamond") data; layering it on the person-at-company doc
is the high-margin search the foundation makes a single lookup.
**Risk/cost.** Med — intent ingestion + freshness (intent is a rolling-30d signal, `PLAN_06 §1.2`) and the
facet-doc enrichment; bounded by the same CDC/restamp discipline (`PLAN_05 §2.6`) — technographics are low-churn.

### O5 — Org-chart / reporting-line graph *(High value · High effort — SCALE-TRACK)*
**What.** Not just "who works at Acme" but "**who reports to whom**" — the reporting tree that turns a contact list
into a navigable org chart and a buying committee with decision authority.
**Builds on.** A **new `master_reporting` edge** (person→manager) over the same person nodes, modeled exactly like
`master_employment` (SCD2, confidence-scored, provenance-carrying — reuse the `PLAN_02` pattern) and scoped to a
company via the current edge. It is a *second edge type on the existing graph*.
**Value.** Reporting lines are the hardest B2B graph to assemble and the most valuable for committee-based selling;
a differentiator few vendors do well.
**Risk/cost.** High — reporting data is sparse and noisy (inferred from titles/signals/scrapes), so it needs the
same corroboration gate as job changes (`PLAN_06 §3.2`) and a confidence-scored edge; graph traversal at billions
is a scale-track concern (Citus/graph store, C9). Privacy review required (org charts are sensitive PII graphs).

### O6 — Relationship / warm-intro graph *(High value · High effort — SCALE-TRACK)*
**What.** Derived person↔person edges — *former colleagues* (overlapping tenure at the same `master_company`),
*alumni* (same company, non-overlapping), *board/advisor co-membership* — to power warm-intro routing ("who in my
workspace's network can introduce me to this buyer").
**Builds on.** `master_employment` overlap is the colleague signal (two `is_current=false` edges at the same
`master_company_id` with overlapping `started_on`/`ended_on`). The edges are *derivable from the employment graph
already designed* — no new evidence source for the colleague case.
**Value.** Warm intros convert far above cold outreach; a relationship graph is a defensible moat.
**Risk/cost.** High — a billions-edge derived graph needs a graph engine + careful **privacy** (a workspace must
not learn cross-workspace relationships; the graph is masked/access-path like the rest of Layer 0, C7). The
warm-intro *routing* (whose network) intersects per-workspace data and needs its own isolation design.

### O7 — ML-assisted match confidence + active-learning the review queue *(High value · High effort — the C9 ER tail)*
**What.** Replace deterministic-only resolution's mint-then-merge debt with the **probabilistic Splink tail**, and
**learn** the thresholds: every clerical-review decision (`match_links.review_status` confirm/reject) becomes a
labeled example that re-calibrates the model (active learning), shrinking the review queue over time.
**Builds on.** `match_links` (`match_probability`, `review_status`, `is_duplicate_of`) and `field_provenance.conf`
(`PLAN_03`) are the labels + features; this is the **scale-track ER** the spine deferred (`PLAN_00` C9; the
`masterGraphMatcher` stub → real, `PLAN_07 §2.1`). The C4 re-point cascade (`PLAN_00` C4) is what makes turning it
on safe (it merges the deterministic duplicates).
**Value.** Lower false-merge (≤0.5% target, `PLAN_01 §4`) + higher recall = a cleaner, more complete universe — the
core data-quality differentiator; and a shrinking review queue is a direct cost reduction (`truepoint-operations`).
**Risk/cost.** High — this *is* the deferred billions-scale ER (Splink-on-Spark + blocking/MinHash-LSH + Citus);
gated behind the scale-track trigger (`PLAN_00 §11.6`). The active-learning loop needs an ML pipeline + calibration
discipline (the false-merge budget is a hard gate).

### O8 — Look-alike / ICP modeling *(Med–High value · High effort — SCALE-TRACK)*
**What.** "Find me 500 more companies/people like my best customers" — embeddings over `master_*` firmographics +
the employment graph to rank look-alikes of a workspace's closed-won set.
**Builds on.** `master_companies` firmographics + `master_persons` attributes + the graph structure as features;
the shipped `ai/` layer (`PLAN`-adjacent: `aiPort`, `compileSearchQuery`) is the inference seam. The *seeds* are a
workspace's own overlay (its customers); the *candidates* are the masked global universe — so it composes the two
layers under the projection boundary (C7).
**Value.** Net-new prospecting (vendor "similar companies" features); high-margin if accurate.
**Risk/cost.** High — needs a feature store + embedding pipeline + careful per-workspace isolation (the seed set is
workspace-private; the model output is masked candidates the workspace then reveals). Privacy: a look-alike must not
leak that a *specific* hidden record exists (the small-cell/membership-inference threat, `PLAN_05` NQ1).

### O9 — Data-coop flywheel (CONTRIBUTE-TO turned on) *(Med–High value · High effort — heavy compliance)*
**What.** The opt-in co-op the initiative deliberately kept **OFF** (`PLAN_00` C3): a workspace contributes its
imported field values into the golden record (as `source_name='coop'`), enriching the universe for everyone and
earning credits/discounts in return.
**Builds on.** `source_records` (a coop upload enters as a `source_name='coop'` row, `PLAN_01 §2.5`) + the
survivorship cascade (`PLAN_03 §1.1`) already weighs `coop` like any other source; the CONTRIBUTE-TO path is
*designed for* but switched off. The provenance scrub (`PLAN_03` C2 — the master map records `source_name`, never a
workspace) is the privacy primitive that makes it possible.
**Value.** A flywheel: more contribution → fresher/cheaper data → more value → more contribution. The canonical
data-vendor growth loop.
**Risk/cost.** High **compliance**, not infra: ADR-0021 flags that contribution makes TruePoint "squarely a data
broker" (CA Delete Act / DROP registration, broker registries) — a GA-gating obligation. This is a
**business/legal decision**, deferred out of this initiative entirely; the foundation merely makes it *possible
without re-architecting*.

### O10 — Provenance-as-a-product *(Med value · Low effort — quick win)*
**What.** Make "where did this come from, how confident, how fresh" a **first-class UI** on every revealed field —
a trust differentiator competitors can't easily match because they lack field-level provenance.
**Builds on.** `field_provenance` (`PLAN_03`) already carries the non-PII descriptor (`src` as a platform tier,
`conf`, `obs`/`ver`, `mth`), and `PLAN_03 §RLS-3`/`PLAN_04 §0.2` already copy it down to the overlay on reveal. The
data is *there*; this is the presentation layer.
**Value.** Trust/transparency is a stated brand pillar (the Trust program, ADR-0014); surfacing per-field source +
confidence + freshness directly answers "why should I believe this number."
**Risk/cost.** Low — a read-only UI over data already projected to the overlay; no new pipeline. The one rule: never
surface the master `wsr`/`source_record_id` or the raw candidate set (co-op contributor leak, `PLAN_03` C2).

### O11 — Time-travel / point-in-time account intelligence *(Med value · Med effort)*
**What.** "What did this account's headcount/tech-stack/org look like 12 months ago, and how fast is it changing" —
trend intelligence from the SCD2 history the foundation keeps.
**Builds on.** The immutable `source_records` log + the SCD2 `master_employment` history (`started_on`/`ended_on`)
+ `field_provenance` replay-as-of (`PLAN_03 §1.5`: "what was the winner on date D = run the cascade over
source_records WHERE ingested_at ≤ D"). The history is *retained by design*; this reads it.
**Value.** Growth signals (hiring surges, tech adoption, org expansion) are strong buying indicators; trend views
are a premium analytics surface.
**Risk/cost.** Med — replay-as-of over the lake (`source_records` → S3/Iceberg, scale-track) is the cheap path; a
materialized trend store is the faster-but-costlier alternative (deferred, `PLAN_03` NQ2).

---

## 3. Sequencing recommendation

```
  NOW-ish (foundation lands) ──► O1 job-change alerts · O2 account/committee views · O10 provenance UI
       (low effort, high value, no scale-track dep — monetize the graph immediately)
                                        │
  NEXT (medium) ──► O3 account hierarchy · O4 intent/technographic layering · O11 time-travel
       (medium effort; richer account intelligence over the same core)
                                        │
  SCALE-TRACK (gated, M12/M13 — needs Citus/OpenSearch/ClickHouse/Splink/Iceberg) ──►
       O7 ML match confidence (also pays down the C4 mint-then-merge debt) · O5 org-chart graph ·
       O6 warm-intro graph · O8 look-alike modeling
                                        │
  BUSINESS DECISION (legal/compliance, not infra) ──► O9 data-coop flywheel
       (off by default — a data-broker obligation, separately gated)
```

The throughline: **O1/O2/O3/O4/O10/O11 are new read/alert surfaces over the golden core and ship without the scale
track**; **O5/O6/O7/O8 are graph/ML products that ride the deferred billions-scale infra**; **O9 is a legal
decision, not an engineering one**. The single highest-leverage *engineering* follow-on is **O7** — it both unlocks
the ML products and pays down the mint-then-merge debt the deterministic-only MVP knowingly took on (`PLAN_00` C4).

> **Standing constraint on every item.** Each builds on the system-owned Layer-0 graph and must stay **masked +
> metered to the workspace** (reveal is the only PII path, `PLAN_04`), **grant-off** (no `leadwolf_app` read of
> `master_*`, `PLAN_07 §0.1`), **owner-scoped at the overlay** (C10), and **bounded at billions** (no OLTP fan-out;
> facets off ClickHouse/OpenSearch, `PLAN_05`). The graph composes — but the wall does not move. A future
> **ADR-0041** should ratify whichever of these graduates from roadmap to commitment.
