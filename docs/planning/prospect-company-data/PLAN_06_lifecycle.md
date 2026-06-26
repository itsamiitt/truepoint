# Phase 6 — Freshness, Re-enrichment & Lifecycle: PLAN

> **Gate: PLAN.** Phase 6 of the prospect↔company data initiative — **the graph in motion**: how a
> prospect↔company record stays *correct and current* after it lands, and the metered machine that keeps it
> so under a budget at billions of rows. This gate freezes the concrete `verification_jobs` priority-queue
> schema, the per-field freshness/decay maintenance (two clocks, `freshness_status`/`data_quality_score`/
> `last_verified_at`), the decay-priority + in-use + budget trigger model, the end-to-end **job-change**
> pipeline (detect → candidate → corroborate → SCD2 commit → recompute → propagate → fan-out → opt-in
> re-reveal), the rule that owner/overlay state survives every re-enrichment, the cold-start treatment for
> imports, the Layer-0-vs-overlay RLS posture, the scale-gate fixes, failure modes, and the open questions.
> **Converts:** `BRAINSTORM_06_lifecycle_options.md §6` — the DECISION *"A budgeted decay-priority queue
> (Option C) as the spend-trigger spine, fed by events, propagated by CDC, floored by lazy; reject the TTL
> sweep (A) and lazy-only (D) as the spine; adopt event-CDC (B) as the orthogonal propagation substrate, not
> a rival trigger; an in-use gate excludes the cold tail; events are maximal-priority enqueues into the one
> queue under one global budget; a job change commits SCD2 only after corroboration, never auto-charging on a
> single source"* — and `RESEARCH_06_freshness.md §9` — the RECOMMENDATION *"a two-clock, hybrid-triggered,
> budget-rationed freshness lifecycle: continuous free decay scoring vs rationed paid re-verify; detect job
> changes once at Layer 0; propagate change as a signal into stable owner views, never a silent overwrite."*
> It answers the eight `BRAINSTORM_06 §6` open questions inline and re-lists them in **Open questions**.
> **Depends on / cites:** `PLAN_00_constraints_and_scope.md` (C1–C10 + the §8 required-section checklist),
> `PLAN_02_affiliation_edge.md` (the SCD2 edge + the reserved `employment_change_outbox` seam, §1.1),
> `PLAN_03_merge_and_provenance.md` (`field_provenance`, `projection_outbox`/`prov_hwm`, the two-clock
> handshake §2.2, `source_field_trust.decay_sla_days`), `PLAN_04_tenant_owner_views.md` (`revealed_channels`
> `as_of`/`superseded_by_id`/`last_verified_at`, the `leadwolf_reveal` role, the F8/OQ3 re-reveal-epoch
> debt), the planned DDL (`03-database-design.md:428-557,777-820`), ADR-0025/0013/0007/0021/0035/0022,
> `dataHealth.ts:19-47,73-77,130-186`, `intel.ts:78-81,88-127`, `enrichmentJobs.ts:41-160`. **No code,
> schema, SQL, or settings are modified by this gate — only this file is written; the DDL below is the
> Phase-6 freeze, an additive migration onto the `PLAN_01`+`PLAN_02` co-land and the `PLAN_03`/`PLAN_04`
> structures, not an applied change.**

---

## 0. Lineage — what this PLAN converts and freezes

`RESEARCH_06` fixed the **physics** (two clocks governed differently — Clock A = system-owned master channel
`last_verified_at`, re-verified once on TruePoint's own spend; Clock B = the frozen per-workspace overlay
snapshot, refreshed only by a billable re-reveal, `RESEARCH_06 §1`; a *free* set-based decay-**score** sweep
distinct from a *paid* re-**verify**, `§4.1`; job change as an SCD2 transition not a mutation, `§4.3`;
propagation with three distinct rules, `§4.4`). `BRAINSTORM_06` took that as settled and decided the
**organizing mechanism**: **Option C — a budgeted decay-priority queue — is the spend-trigger spine**, with
three structural sharpenings the PLAN must carry (`BRAINSTORM_06 §5`): **(i)** trigger and propagation are
orthogonal — B (event-CDC) is the propagation substrate, adopted regardless, never a rival trigger; **(ii)**
events collapse *into* C's one queue under one budget as *maximal-priority enqueues*, idempotent on
`(entity, field, sla_period)`; **(iii)** "per-tenant quota on the master sweep" is a **category error** —
master re-verify is amortized *system* cost under a *global* budget; per-tenant quotas live only on the
Clock-B re-reveal / on-demand path.

This PLAN **paves that road**. It does five things:

1. **Freezes the trigger machinery** (Target schema) — `verification_jobs` (the one Layer-0 priority queue),
   the `data_quality_rules` override seam (decay-curve params + SLA overrides + priority weights + in-use
   predicate + per-plan budget, as data), and `master_usage` (the system-owned **in-use** counter the cost
   keystone reads), all reusing the shipped `provider_configs` budget breaker (`intel.ts:120-127`) and the
   `enrichment_jobs` bulk ledger (`enrichmentJobs.ts`).
2. **Freezes the freshness maintenance** (§1) — the two-clock measurement, the free decay-score sweep, the
   per-field SLA, the `last_verified_at`/`freshness_status`/`data_quality_score` update path, the
   compute-the-badge-at-read scale fix, and the inherited cold-start rule.
3. **Freezes the priority + cost model** (§2) — `priority = f(decay, recency-of-use, seniority, dq-drop,
   event-urgency)`, the in-use gate (the §5 keystone), the global budget gate, and the system-cost-vs-
   workspace-cost split with the per-tenant quota placed correctly.
4. **Freezes the job-change pipeline** (§3) — finalizing `PLAN_02`'s reserved `employment_change_outbox` seam
   into the candidate→corroborate→commit state machine, the three-rule propagation, the bounded async signal
   fan-out, and the `reveal_epoch` that resolves `PLAN_04`'s F8/OQ3 re-reveal-billing debt.
5. **Freezes the owner-state guarantee** (§4) — re-enrichment never touches overlay PII/curation; the pin
   outranks; the master change is a signal, never an invalidation (the H2 trap).

> **Trace, explicit.** Every schema/flow choice below names the `BRAINSTORM_06 §6` DECISION clause or §5
> finding, or the `RESEARCH_06 §9` recommendation point, it crystallizes; each `BRAINSTORM_06 §6` open
> question (OQ1–OQ8) is resolved inline and re-listed in **Open questions**. Reuse is mandatory (the
> `PLAN_00`/`PLAN_03`/`PLAN_04` reuse rule): the decay/score math is `dataHealth.ts` (never re-derived,
> C5); the budget breaker + cache are `provider_configs`/`provider_calls` (`intel.ts`); the bulk fan-out is
> `enrichment_jobs`/`chunks`/`rows` (`enrichmentJobs.ts`); the signal enum is the shipped
> `intent_signals.job_change`/`new_hire` (`intel.ts:80-81`); the SCD2 tx is `PLAN_02 §1.1`; the propagation
> outbox is `PLAN_03 §1.3` + ADR-0035 CDC.

---

## Target schema

Phase 6 adds **one queue, one config seam, one in-use counter, and one outbox-shape freeze** — all Layer-0
**system-owned** (no `workspace_id`, no RLS, no `leadwolf_app` grant — C7), plus **one additive overlay
column** (`reveal_epoch`) that resolves the re-reveal-billing debt. The freshness *score* maintenance reuses
the **shipped** overlay columns (`contacts.last_verified_at`/`data_quality_score`/`freshness_status`,
`03:544-546`) and the **`PLAN_03`** master `field_provenance` `obs`/`ver` keys — no new freshness columns are
minted (the gap was the *machine*, not the *fields*).

### 0.1 `verification_jobs` — the one priority queue (Layer-0, system-owned) — DDL freeze

The named-but-undefined planned table (`03:779,820`; time-partitioned `03:791`; `ADR-0025:28-30`; `22 §4`).
This is the **single** spend-trigger queue (DECISION; §5(ii)): the free decay sweep *fills* it, events
*jump* it at maximal priority, the budget gate *drains* it. No `workspace_id` — a master re-verify is system
cost amortized across every workspace (C1/C7; §5(iii)).

```sql
CREATE TABLE verification_jobs (                          -- Layer 0; system-owned; NO workspace_id, NO RLS (C7)
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  entity_type       varchar(12) NOT NULL CHECK (entity_type IN ('person','company','employment')),
  entity_id         uuid NOT NULL,                         -- master_persons / master_companies / master_employment id
  field             varchar(20) NOT NULL CHECK (field IN ('email','phone','employment','firmographics')),  -- the SLA bucket (dataHealth FRESHNESS_SLA_DAYS:19-25)
  sla_period        date NOT NULL,                         -- the SLA window this re-verify belongs to → idempotent enqueue key (§5(ii))
  trigger_source    varchar(12) NOT NULL CHECK (trigger_source IN ('sweep','event','on_demand')),
  event_kind        varchar(20) CHECK (event_kind IS NULL OR event_kind IN
                      ('job_change','bounce','reveal','campaign_send')),  -- set iff trigger_source='event'
  priority          numeric(6,4) NOT NULL,                 -- f(decay,use,seniority,dq_drop,urgency) ∈ [0,1] (§2.1) — drain head-first
  in_use            boolean NOT NULL DEFAULT false,        -- the cost keystone: only in_use rows are proactively drained (§2.2)
  status            varchar(12) NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','done','failed','skipped','suppressed')),
  attempts          int NOT NULL DEFAULT 0,
  cost_micros       bigint NOT NULL DEFAULT 0,             -- spend booked against the global budget (provider_configs)
  bulk_job_id       uuid,                                  -- a drained batch reuses enrichment_jobs/chunks/rows (enrichmentJobs.ts; §2.3)
  enqueued_at       timestamptz NOT NULL DEFAULT now(),    -- range-partition by month (03:791, like provider_calls/activities §12)
  claimed_at        timestamptz, completed_at timestamptz,
  fail_reason       text
);

-- IDEMPOTENT ENQUEUE (§5(ii); BRAINSTORM_06 §5(ii)): one live job per (entity, field, sla_period). A second
-- enqueue (sweep re-sees a stale row, OR an event fires for an already-queued record) collapses onto it; an
-- event UPSERTs the priority UP (max) and sets trigger_source/event_kind — never a parallel lane (F-dup).
CREATE UNIQUE INDEX uniq_verification_jobs_live
  ON verification_jobs (entity_type, entity_id, field, sla_period) WHERE status IN ('queued','running');

-- The drain read path: highest-priority IN-USE queued work first (the §2 budget loop, SELECT … FOR UPDATE
-- SKIP LOCKED). Partial = the live, in-use frontier only → tiny vs the billions-row partitioned table.
CREATE INDEX idx_verification_jobs_drain
  ON verification_jobs (priority DESC, enqueued_at) WHERE status = 'queued' AND in_use;
```

### 0.2 `data_quality_rules` — the tunable policy seam (config-in-code canonical + override) — DDL freeze

The other named-but-undefined planned table (`03:779,820`; `22 §4:139-140`, "validation + freshness
thresholds + confidence cutoffs as data, so policy tunes without code"). Following the **`source_field_trust`
pattern** (`PLAN_03 §3.5`): the canonical defaults are **versioned config in code** — the shipped
`dataHealth.ts` constants (`FRESHNESS_SLA_DAYS:19-25`, `COLD_START_FRESHNESS:31`, the linear decay
`freshnessSubScore:44-47`) and the `COMPLETENESS_WEIGHTS:95-113` — and this **tiny system-owned** table lets
Ops re-tune per `ADR-0025:62-65` ("re-tune cadences from measured decay") without a deploy.

```sql
CREATE TABLE data_quality_rules (                         -- system-owned config (NO workspace_id, NO RLS); tiny
  rule_key      varchar(40) PRIMARY KEY,                  -- e.g. 'sla.email' | 'decay.curve' | 'priority.weights' | 'in_use.predicate' | 'budget.plan'
  params        jsonb NOT NULL,                           -- the override payload (a number, a weight vector, a predicate config)
  version       int NOT NULL DEFAULT 1,                   -- bumped on each change; the active version is read at sweep start
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- effective(rule) = COALESCE(data_quality_rules.params, dataHealth.ts code-default). The shape of `params` is
-- app-edge-validated by a Zod schema in @leadwolf/types (the typed-JSONB house pattern, PLAN_03 §3.1), never a
-- DB CHECK. user_edit / human pins are NOT in this table — a pin outranks every rule (PLAN_03 §1.4; §4).
```

### 0.3 `master_usage` — the in-use counter (the cost keystone; system-owned, no attribution) — DDL freeze

The §5 keystone needs a Layer-0-readable answer to *"is any workspace hurt if this record goes stale?"*
**without** Layer 0 holding a workspace pointer (C7) or any per-workspace attribution (C2). The answer is an
**aggregate counter** bumped in the reveal tx (`PLAN_04 §0.4`, which already crosses both layers under
`leadwolf_reveal`): a *count* and a *recency*, never a workspace id.

```sql
CREATE TABLE master_usage (                               -- Layer 0; system-owned; NO workspace_id (aggregate only, C2/C7)
  master_person_id    uuid PRIMARY KEY REFERENCES master_persons(id) ON DELETE CASCADE,
  reveal_count        int NOT NULL DEFAULT 0,             -- total reveals across ALL workspaces (no identity, just a count)
  distinct_ws_count   int NOT NULL DEFAULT 0,             -- # distinct workspaces holding a live copy (aggregate; HLL-approx OK at scale)
  last_revealed_at    timestamptz,                        -- recency-of-use input to priority (§2.1)
  active_ref_count    int NOT NULL DEFAULT 0,             -- on an active list / live sequence (privileged periodic rollup, §2.2; deferred-tunable)
  last_activity_at    timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_master_usage_inuse ON master_usage (last_revealed_at) WHERE reveal_count > 0;  -- the in-use frontier
```

> **Why a counter, not a join.** The in-use gate cannot be "does a `contacts`/`revealed_channels` row point
> here?" — that is a billions-row cross-RLS scan the sweep is forbidden to run, and the per-workspace identity
> would leak into Layer 0 (C2). The reveal tx bumps `master_usage` once (O(1), in the same tx that mints the
> `revealed_channels` row, `PLAN_04 §0.4 step 5`); DSAR/decrement on tombstone. The counter is a *system*
> aggregate, so it is safe in the ownerless master graph and cheap for the sweep to read.

### 0.4 `employment_change_outbox` — freezing `PLAN_02`'s reserved seam (the candidate→commit machine) — DDL freeze

`PLAN_02 §1.1 step 7` reserved this Layer-0 system table ("its exact columns are Phase-6 territory") and
emitted one row in the SCD2 tx. Phase 6 freezes it as the **candidate-edge state machine** that imports D's
caution into the C/B path (the false-job-change guardrail, `BRAINSTORM_06 §3 H6`): a single uncorroborated
source produces a **held candidate**, not a committed flip.

```sql
CREATE TABLE employment_change_outbox (                   -- Layer 0; system-owned; range-partition by observed_at (like source_records 03:470)
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  master_person_id  uuid NOT NULL REFERENCES master_persons(id) ON DELETE CASCADE,
  from_company_id   uuid REFERENCES master_companies(id),  -- the closing edge's company (NULL for new_hire from company-less)
  to_company_id     uuid REFERENCES master_companies(id),  -- the opening edge's company
  kind              varchar(20) NOT NULL CHECK (kind IN
                      ('employer_change','title_change','department_change','new_hire')),  -- PLAN_02 §1.1 signal kinds
  state             varchar(12) NOT NULL DEFAULT 'candidate'
                      CHECK (state IN ('candidate','committed','rejected')),  -- the corroboration gate (§3.2)
  corroboration     int NOT NULL DEFAULT 1,                -- # DISTINCT independent sources/signals agreeing (the gate input, §3.2)
  source_record_id  uuid REFERENCES source_records(id),    -- the asserting evidence (lineage)
  content_hash      bytea NOT NULL UNIQUE,                 -- idempotent emit: a retried detector re-emits exactly once (03:464 discipline)
  observed_at       timestamptz NOT NULL DEFAULT now(),
  committed_at      timestamptz                            -- set when the SCD2 transition (PLAN_02 §1.1 steps 3-6) commits
);
CREATE INDEX idx_emp_change_candidates ON employment_change_outbox (master_person_id) WHERE state = 'candidate';
```

### 0.5 `reveal_epoch` — resolving `PLAN_04`'s re-reveal-billing debt (F8/OQ3) — overlay DDL freeze

`PLAN_04 F8/OQ3` flagged that `contact_reveals`'s unique `(workspace_id, contact_id, reveal_type)`
(`03:560`) admits **one** row, so a job-change re-charge "cannot reuse the unique as-is … decide with Phase 6
+ ADR-0013/0029; do not silently relax the idempotency unique." Phase 6 resolves it **without relaxing** the
unique — it *widens* it with an epoch the master controls:

```sql
-- Additive on the overlay (RLS-FORCED) contact_reveals event log. epoch 0 = the first reveal (every existing
-- row); a CONFIRMED job-change (§3) bumps the epoch a workspace MAY re-reveal into, so a re-reveal is a NEW
-- charged event under the SAME idempotency discipline (no double-charge within an epoch; a re-charge across one).
ALTER TABLE contact_reveals ADD COLUMN reveal_epoch int NOT NULL DEFAULT 0;
-- REPLACE the unique to include the epoch (the F8-safe widening — a per-epoch idempotency, never a removal):
--   DROP uniq (workspace_id, contact_id, reveal_type);
CREATE UNIQUE INDEX uniq_contact_reveals_epoch
  ON contact_reveals (workspace_id, contact_id, reveal_type, reveal_epoch);
```

### 0.6 The lifecycle ER sketch (two clocks; one queue; signal-not-overwrite)

```
  LAYER 0 — system-owned (no workspace_id · no RLS · no leadwolf_app grant — C7)
  ┌─ FREE decay sweep (clock; no spend) ─┐        ┌─ EVENTS (jump the queue, maximal priority) ─┐
  │  set-based recompute of freshness    │        │  job_change · bounce(SES SNS→SQS) · reveal  │
  │  sub-score from now−ver (dataHealth)  │        │  campaign_send · Diamonds-on-Demand          │
  └──────────────┬───────────────────────┘        └───────────────┬──────────────────────────────┘
                 │  enqueue intents (in_use only, §2.2)             │  UPSERT priority↑ same queue (§5(ii))
                 ▼                                                  ▼
        ╔══════════════════════ verification_jobs (ONE priority queue) ══════════════════════╗
        ║  drain head-first WHILE provider_configs.monthly_budget_cents remains (intel.ts:125) ║
        ║  behind the waterfall trust÷cost breaker (waterfall.ts) → independent verifier        ║
        ╚════════════════════════════════════════════╤═════════════════════════════════════════╝
                                                     ▼  master_emails/phones/employment updated (Clock A)
                                 ┌───────────────────┴───────────────────────────────────────┐
   (1) PROJECTION reproject ◄───┤  PROPAGATE — three HARD-PARTITIONED rules (B substrate, §3.3) │
       OpenSearch/ClickHouse    │  (2) DERIVED CACHE recompute in-tx (current_company_id …)     │
       (ADR-0035 CDC; eventual) │  (3) OVERLAY = SIGNAL ONLY, never invalidate (H2 trap, §4)    │
                                 └───────────────────┬───────────────────────────────────────┘
  ═══════════════════════════════════════════════════▼═══════════════════════════════════════════
  LAYER 1 — per-workspace overlay (FORCE-RLS, workspace_id — C8)
   intent_signals(job_change, intel.ts:80-81)  +  freshness_status badge flip "newer data available"
        └─ owner OPTS IN → billable re-reveal (charge-only-for-valid, ADR-0013): contact_reveals(reveal_epoch+1)
           + revealed_channels append (superseded_by_id chain, as_of, PLAN_04 §0.2);  a PIN outranks even this (§4)
```

---

## 1. Freshness measurement & maintenance (`freshness_status` · `data_quality_score` · `last_verified_at`)

### 1.1 Two clocks, measured separately — the inherited physics (`RESEARCH_06 §1`; `PLAN_03 §2.2`)

- **Clock A (master channel).** `master_emails.last_verified_at`/`master_phones.last_verified_at` (`03:447,
  457`) + the `PLAN_03` `field_provenance` `obs`/`ver` keys drive the *golden* record's freshness and the
  re-verify priority queue (§2). Re-verifying it is **system cost** amortized across every workspace
  (verify-once-serve-N).
- **Clock B (overlay snapshot).** `contacts.last_verified_at`/`data_quality_score`/`freshness_status`
  (`03:544-546`) + `revealed_channels.as_of`/`last_verified_at` (`PLAN_04 §0.2`) drive the *workspace's
  frozen copy*. Refreshing it is a per-workspace **billable re-reveal** (§3.4), never a side effect of a
  master re-verify (owner-view stability — the H2 trap, §4). The user-facing badge reads **Clock B** (the age
  of *what they hold*), with a "newer data available" affordance when Clock A is fresher.

A contact can be `stale` on Clock B (snapshot 200 d old) while `fresh` on Clock A (re-verified last week) —
exactly the gap a re-reveal closes (§3.4). Conflating the clocks is the headline error this design
structurally prevents (the map exists on *both* layers, `PLAN_03 §2.2`).

### 1.2 Per-field SLA + the decay curve (reuse `dataHealth.ts`, never re-derive — C5)

The SLAs are the shipped `FRESHNESS_SLA_DAYS` (`dataHealth.ts:19-25`; `ADR-0025:25-27`; `22 §3:120-126`),
overridable via `data_quality_rules` (§0.2):

| Field | SLA (`dataHealth.ts:19-25`) | Why (external, `RESEARCH_06 §2`) |
|---|---|---|
| Employment / title | **60 d** | a move invalidates the cascade; ~30%/yr churn |
| Email | **90 d** | ~3.6%/mo decay; ZoomInfo/Apollo "90-day common threshold" |
| Mobile / direct phone | **180 d** | costlier to verify; decays slower |
| Company firmographics | **180 d** | 5–15%/yr company-level change |
| Intent signals | **rolling 30 d** | meaningful only while recent |

The **decay is continuous** so quality degrades gracefully, not at a cliff (`22 §3:129-130`): the shipped
`freshnessSubScore(age, sla) = clamp01(1 − (age/sla)/1.5)` (`dataHealth.ts:44-47`) — linear from 1 at age 0
to 0 at 1.5×SLA (the `expired` boundary). `freshnessStatusFor` (`:34-40`) gives the bands
(`<0.5 fresh · <1.0 aging · <1.5 stale · else expired`, `22 §3:128`). **Per-field freshness** (`PLAN_03
§2.2`): each field decays on its own `obs`/`ver` clock; the worst-decaying *present* field (email, SLA 90 d)
sets the record-level `freshness_status`. The exact curve shape (linear today; exp/logistic per field) is
tunable in `data_quality_rules.decay.curve` (OQ3).

### 1.3 The free decay-score sweep vs the paid re-verify — the load-bearing split (`RESEARCH_06 §4.1`)

This is the first cost lever and the salvaged-clock the brainstorm adopted (`BRAINSTORM_06 §4`, "there is a
legitimate clock, and it is free"):

- **Free decay-**score** maintenance.** Lowering `freshness`/`data_quality_score` from **age alone** is pure
  arithmetic over `now − last_verified_at` (`dataHealth.ts`, no PII, runs on the masked DTO, `:11-12`) — it
  spends **no** provider credit. It is **clock-driven and adopted**.
- **Paid re-**verify**.** Re-checking a field (SMTP probe / phone validation, `06 §9`) spends — it is
  **rationed** by the §2 queue. A clock-driven *paid* re-verify of every expired record is **rejected**
  (`ADR-0025:52`; `BRAINSTORM_06 §6 reject A`).

**The scale fix — compute the badge at read; sweep only band-crossers (§1.4 below).** A nightly set-based
*write* of `data_quality_score`/`freshness_status` across **billions** of rows is itself a fan-out failure
even at zero provider cost. So: the **live badge is computed at read** from the stored `last_verified_at` via
the pure `dataHealth.ts` (no write, no spend); the **stored** `freshness_status`/`data_quality_score` cache
is refreshed only **(a)** at write events (verify, reveal, import) and **(b)** by a bounded set-based sweep
over the **narrow slice** of rows whose age crossed a band boundary since the last run (a partition-pruned
`UPDATE … FROM`, `22 §2.4:104-117`), not the whole universe. Search/sort that *filters* on freshness reads
the cached column; the detail badge reads truth-at-read.

### 1.4 `last_verified_at` maintenance + cold-start for imports (inherited, unchanged — `22 §2.2`)

- `last_verified_at` is set **only by a real verification run** (a §2 drain or a reveal), never by the free
  sweep and never back-filled from an import "as-of" date (`22 §2.2:73-74`). The free sweep reads it; the
  paid re-verify writes it (+ `verification_source`, + a new `source_record` for lineage, `PLAN_03 §1.3`).
- **Cold start (imports).** An unverified user-supplied value is **excluded** from the verification sub-score
  (re-weighted out, not penalized as `invalid=0` — `dataQualityScore` cold-start branch, `dataHealth.ts:133-
  135`; `22 §2.2`); without an as-of date freshness starts at the **aging** mid-band (`COLD_START_FRESHNESS
  = 0.5`, `dataHealth.ts:31,180-181`), never `fresh`; `last_verified_at` stays **null** until a verification
  run sets it. Phase 6 inherits this verbatim — a cold import enters the §2 queue like any other in-use
  record, and its score "fills in" as verification lands (`22 §2.4:108-114`).

---

## 2. Re-enrichment trigger + priority model (the decay-priority spine — Option C)

### 2.1 The priority function (`BRAINSTORM_06 §6 OQ2`; `ADR-0025:28-30`; `22 §4:132-140`)

Every enqueued row carries a stored `priority ∈ [0,1]`; the queue drains head-first under the budget. The
function (weights in `data_quality_rules.priority.weights`, re-tuned from measured bounce/credit-back):

```
  priority = w_d·decay + w_u·recency_of_use + w_s·seniority + w_q·dq_drop + w_e·event_urgency
    decay          = 1 − freshnessSubScore(age, sla)            -- how far past fresh (dataHealth.ts:44)
    recency_of_use = recency(master_usage.last_revealed_at)     -- recently-revealed first (ADR-0025:28; §0.3)
    seniority      = tier(master_persons.seniority_level)       -- director+ first (Cognism 30-day tier, RESEARCH_06 §3.1)
    dq_drop        = max(0, last_score − current_score)         -- biggest quality cliff first (22 §4)
    event_urgency  = 1 for an event enqueue (job_change/bounce/reveal/send), else 0   -- events JUMP (§5(ii))
```

The **per-segment coverage monitor** (C's killer, `BRAINSTORM_06 §2`): coverage SLAs (`22 §5:147-153`,
email-coverage ≥ 80%, fill-rate ≥ 85%) are tracked **per segment** (seniority × in-use band × region), not
just in aggregate, so a mis-weighted priority that silently starves a class (e.g. mid-seniority,
rarely-revealed) **alarms** instead of rotting unseen.

### 2.2 The in-use gate — the cost keystone (`BRAINSTORM_06 §5`; `RESEARCH_06 §5`; OQ1)

The single largest cost cut: the sweep enqueues **only** records that are *both* stale *and* **in-use**;
cold never-revealed master records **decay on paper but are not proactively re-verified** — they are verified
**lazily at first reveal** (D's floor). The in-use predicate (resolving OQ1):

- **Day-1 (cheap, written in the reveal tx):** `master_usage.reveal_count > 0` **OR**
  `master_usage.last_revealed_at` within a recency window — the strongest signal a workspace is hurt by
  staleness, and O(1) to maintain (§0.3). The recommended start (`BRAINSTORM_06 §5`): "revealed-by-≥1-
  workspace."
- **Phase-6.1 (deferred, privacy-preserving):** add `master_usage.active_ref_count > 0` (on an active list /
  live sequence), maintained by a **privileged periodic rollup** that writes only an *aggregate count* into
  Layer 0 (never a workspace id, C2) — the brainstorm's "OR in active list/sequence." Deferred because it
  needs a cross-layer aggregation job; the day-1 reveal signal ships first.

`verification_jobs.in_use` is set at enqueue from `master_usage`; the drain index
(`idx_verification_jobs_drain … WHERE … in_use`, §0.1) keeps cold rows off the hot frontier.

### 2.3 The budget gate + cost split (the system-vs-workspace category boundary — §5(iii))

- **Global budget, not per-tenant, on the master sweep.** Clock-A re-verify drains while
  `provider_configs.monthly_budget_cents` remains (`intel.ts:125`), behind the per-provider circuit breaker
  and the waterfall trust÷cost ordering (`waterfall.ts`), cache-first against `provider_calls`
  (`intel.ts:88-114`). A breach pages Ops (`22 §5:155`). Putting a **per-tenant** quota here is the
  **category error** (`BRAINSTORM_06 §5(iii)`): master re-verify has *no tenant*; it is amortized system cost.
- **Per-tenant quota lives only on Clock B.** The workspace's **opt-in re-reveal** and **on-demand premium**
  (Diamonds-on-Demand) draw the **per-workspace credit pool** (`tenants.reveal_credit_balance` `FOR UPDATE`,
  ADR-0007; team budgets ADR-0022), `charge-only-for-valid` (ADR-0013:21-36). This is where "cost ceilings +
  per-tenant quotas" correctly bind.
- **A drained re-verify campaign reuses the bulk ledger.** A batch of `verification_jobs` rows fans out
  through the shipped `enrichment_jobs`/`chunks`/`rows` (`enrichmentJobs.ts:41-160`) — chunked worker claim,
  per-row `cost_micros`, idempotency key, monthly partition — never a parallel job system (C5; `bulk_job_id`,
  §0.1).

### 2.4 Why C, not A/B/D (the DECISION, restated against the queue)

A blind TTL sweep (A) is rejected (cost-unbounded `ADR-0025:52`; cannot complete at billions; degenerates
into a worse C under a budget — `BRAINSTORM_06 §4`); lazy-only (D) is rejected as the spine (held data rots
after reveal, `ADR-0025:51`; no proactive job-change detection) but **adopted as the cold-tail floor** (§2.2);
event-CDC (B) is **not a rival trigger** — it is the propagation substrate (§3.3) and feeds C's priority as
`event_urgency` (§5(ii)). C is the only model where freshness-vs-over-spend is a **tunable dial** and the
budget bounds spend **by construction** (`BRAINSTORM_06 §6`).

---

## 3. The job-change pipeline, end-to-end

### 3.1 Detect → candidate (never an immediate flip; the false-job-change guardrail — `BRAINSTORM_06 §3 H6`)

A job change enters as **new evidence**, idempotent on `source_records.content_hash` (`03:464`). A **single
uncorroborated source produces a held candidate**, not a committed flip — the asymmetric-catastrophe guard
(a false positive invalidates a still-valid email, fans a wrong signal to N workspaces, and could trigger N
billable re-reveals on correct data):

```
  detect (new source_record: person P now @ company B)         ── sources/cadence: OQ7 (doc 21; weekly like ZoomInfo Tracker)
        │  idempotent on source_records.content_hash (03:464)
        ▼  ER incremental match resolves to the SAME master_persons identity (linkedin_public_id / email-BI)
  INSERT employment_change_outbox(P, from=A, to=B, kind, state='candidate', corroboration=1, content_hash)  -- §0.4
        │  the edge is UNCHANGED; current_company_id is UNCHANGED; NO signal fans out yet
        ▼
  corroboration gate (§3.2)
```

### 3.2 Corroborate → commit (the gate; reuse `match_links` review, no new queue)

The candidate commits the SCD2 transition **only** when one of (config in `data_quality_rules.job_change.
corroboration`):

1. `corroboration ≥ N` distinct independent sources agree (`source_count` over a threshold — the survivorship
   corroboration input, `PLAN_03 §1.1` tier 4), **or**
2. **multi-signal agreement** (e.g. email-signature domain change + a feed row + a scrape), **or**
3. a successful **verify of the new channel** (the new `@B` email returns `valid`).

An **ambiguous** re-affiliation (fuzzy `name_normalized` / shared domain) routes to the **existing**
`match_links.review_status='pending'` band (`03:481-482`; `PLAN_02 §1.4`) — no new edge state, no new review
queue (`PLAN_02` reuse rule); the `≤0.5%` false-merge bound holds under churn (`22 §5/§6:152-171`). On commit
the **`PLAN_02 §1.1` atomic tx runs unchanged** (this PLAN does not redefine it — it gates it):

```
  COMMIT TX (the PLAN_02 §1.1 SCD2 transition, now gated by §3.2):
   3. CLOSE old:  UPDATE master_employment SET is_current=false, is_primary=false, ended_on=<inferred> WHERE current @ A
   4. OPEN new:   INSERT master_employment(P, B, …, is_current=true) ON CONFLICT (person,company,started_on) DO UPDATE  -- idempotent (03:434)
   5. PRIMARY:    recompute is_primary across P's current edges (uniq_employment_primary; the PLAN_02 §1.2 tiebreak)
   6. CACHE:      UPDATE master_persons SET current_company_id = (primary edge's company)   -- derived, NEVER hand-set
   6b. CHANNELS:  old @A email → email_status='risky' (the 30–90d post-departure reality, RESEARCH_06 §2); ENQUEUE a
                  verification_job for the NEW @B channel (event-driven, §2; job-change CREATES queue work, never bypasses it)
   7. SET employment_change_outbox.state='committed', committed_at=now()
   8. PROPAGATE (§3.3) — three hard-partitioned rules
```

### 3.3 Propagate — three hard-partitioned rules (B is the substrate, not a rival trigger — §5(i); `RESEARCH_06 §4.4`)

1. **Projection (search/facets) — reproject eagerly.** Write golden first, then `PLAN_03`'s `projection_outbox`
   / the ADR-0035 search outbox (`03:801`) → OpenSearch masked index + ClickHouse facet recount (employee
   band, has_email). **Eventual consistency is fine** — permissions and the openable value are re-checked at
   read against Postgres (`PLAN_04 §RLS`; `RESEARCH_04 §5`). A stale index serving a just-moved person at the
   old company is a **freshness** bug, not an isolation one; it closes within the CDC lag. **A value-unchanged
   re-verify** (a confirmed-still-valid email that only bumps `last_verified_at`) emits **no** reproject — the
   indexed scalar didn't change — which is the CDC-firehose backpressure that keeps reproject lag inside the
   read-your-write window (OQ8).
2. **Derived cache — recompute in-transaction.** `current_company_id`, `has_email`/`has_phone`, the flattened
   person+company search doc — all recomputed atomically with the edge change (step 6; `PLAN_02 §2.2`),
   **never** independently writable. (This is where "invalidate" is *correct* — the cache *is* a cache of the
   master, H2.)
3. **Overlay snapshots — SIGNAL, never overwrite (and never invalidate — the H2 trap).** A master change
   writes a **`job_change` `intent_signal`** (the shipped enum, `intel.ts:80-81`) into each affected overlay
   (RLS-scoped, owner/team/visibility-respecting at read — ADR-0022) and **flips the Clock-B badge** to "newer
   data available." It does **not** `UPDATE` the overlay's PII/curation columns — those are owned, not a cache
   (§4). The workspace **decides** to re-reveal (§3.4).

### 3.4 Re-reveal — opt-in, billable, epoch-controlled (resolving `PLAN_04` F8/OQ3)

A confirmed job-change **bumps the master-controlled epoch** the workspace may re-reveal into; a re-reveal is
then a **new charged event** under the unchanged idempotency discipline (§0.5): `contact_reveals(reveal_type,
reveal_epoch+1)` + a new `revealed_channels` row whose `superseded_by_id` chains the old (point-in-time
history, `PLAN_04 §0.2`), `charge-only-for-valid` (ADR-0013), drawing the per-workspace credit pool
(ADR-0007 `FOR UPDATE`). **Even a false flip never auto-bills** — the re-reveal is always opt-in
(`BRAINSTORM_06 §3 H6`). The **pricing** (full-price vs discounted refresh vs free-window) is the residual
OQ5, owned with ADR-0013/0029. **Fan-out is async + bounded:** a celebrity move (revealed by 100k workspaces)
is a queued, idempotent `signal.contact.job_change` fan-out (BullMQ, content-hash-keyed) keyed off
`revealed_channels.master_person_id` (`idx_revealed_channels_master`, `PLAN_04 §0.2`) — the same discipline
as the DSAR fan-out — never a synchronous 100k-row write on the detection thread (the scale gate).

---

## 4. How owner / overlay state is preserved across re-enrichment

Per-owner overlay state — notes, `scores` (`intel.ts:40`, keyed on `contact_id`, independent of any master
value), `owner_user_id`/`assigned_team_id`/`visibility` (`03:540-543`), a human-pinned field
(`PLAN_03 §1.4`) — must survive **every** re-enrichment, **by construction**:

- **Propagation never `UPDATE`s overlay PII/curation.** Rule (3) above writes a *signal + a badge flip*, full
  stop. The overlay tables are keyed on `contact_id`; a master-keyed propagation never addresses them, so
  notes/scores cannot be clobbered — a structural guarantee, not a runtime check (the H2 trap,
  `BRAINSTORM_06 §3 H2`).
- **The pin outranks even an opt-in re-reveal.** If the overlay value is human-pinned
  (`field_provenance[field].pin=true`, `PLAN_03 §1.4`), the re-reveal merge **refuses to overwrite** it; the
  signal still surfaces ("the master now disagrees with your pinned value"), but the value stands.
- **The free sweep touches only quality columns.** §1.3's score recompute writes `freshness_status`/
  `data_quality_score` and nothing else — never PII, never owner/visibility, never a pin.
- **A re-reveal appends, never mutates.** It mints a *new* `revealed_channels` row (`superseded_by_id` chain)
  — the old snapshot is retained, the owner's prior view is auditable (`PLAN_04 §0.2`).

---

## RLS policy implications

Two isolation regimes that must not bleed (C7/C8; the inverse postures of `PLAN_02`/`PLAN_03`/`PLAN_04`):

1. **Layer 0 (the lifecycle machinery) — NOT a workspace RLS predicate; isolation by access path.**
   `verification_jobs`, `data_quality_rules`, `master_usage`, and `employment_change_outbox` carry **no
   `workspace_id`/`tenant_id`/`owner`** (C1/C7) and get **no RLS policy and no `GRANT … TO leadwolf_app`** — a
   tenant tx (`SET LOCAL ROLE leadwolf_app` + GUCs, `client.ts:48-68`) has **no privilege** on them and cannot
   address them (privilege-denied, not row-filtered). They are touched only by least-privilege system roles:
   the **ER/detection** role (writes `employment_change_outbox`), the **verification worker** role
   (`leadwolf_verify` — drains the queue, `SELECT`/`UPDATE` on `master_emails`/`master_phones`/
   `master_employment`/`master_usage`, the `leadwolf_reveal`-style master grant `leadwolf_app` is forbidden),
   and the audited privileged paths (`withPrivilegedTx`/`withPlatformTx`, `client.ts:30-35,95-111`).
   `master_usage` records an **aggregate count only**, never a workspace id (C2) — the security review of
   "does `distinct_ws_count` leak membership" is a named open question (OQ-NQ).
2. **The free decay-score sweep on the OVERLAY runs privileged, writes only non-PII quality columns.** It
   recomputes `contacts.freshness_status`/`data_quality_score` across workspaces, so it runs under a dedicated
   **`leadwolf_sweep`** role (a set-based `UPDATE … FROM` that can cross workspaces) — but it is **constrained
   to the two quality columns** (never PII, owner, visibility, or a pin; §4) and **skips tombstoned rows**
   (`deleted_at IS NOT NULL`). It is **not** `leadwolf_app`, and it is **not** BYPASSRLS on PII columns.
3. **The job-change signal is an RLS-scoped overlay write.** The fan-out writes one `intent_signals` row per
   affected workspace, **RLS-scoped** to that workspace (it sets each workspace's GUC, or runs the per-
   workspace write under the privileged fan-out role with the `WITH CHECK` predicate binding), carries **no
   cross-workspace attribution** (co-op privacy, C2), and is **app-layer-filtered** by owner/team/visibility
   at read like any overlay row (ADR-0022; C10).
4. **The re-reveal is the workspace's own `leadwolf_reveal` tx.** Per-tenant credit, both-layer suppression
   gate, idempotency on `(workspace_id, contact_id, reveal_type, reveal_epoch)` — exactly `PLAN_04 §0.4` plus
   the epoch (§0.5). Suppressed subjects (`master_persons.is_suppressed`, `03:421`) are **excluded from the
   queue** (`status='suppressed'`), **from the signal fan-out**, and **from re-reveal** (`PLAN_04 §0.4 step 3`).
5. **The mandatory two-tenant isolation itest is extended (blocks merge — C8).** Model on
   `lists.itest.ts`/`emailIsolation.itest.ts`. Phase-6 assertions: **(a)** the free sweep updating wsA's
   quality columns leaves wsB's identical-master contact untouched; **(b)** a `withTenantTx` under
   `leadwolf_app` selecting `verification_jobs`/`employment_change_outbox`/`master_usage` **errors (privilege
   denied)** — the access-path wall; **(c)** a job-change signal lands **only** in the workspaces that hold the
   person (via `revealed_channels.master_person_id`), owner-scoped, and **never** in a workspace that did not
   reveal them; **(d)** a re-reveal in wsA does **not** refresh wsB's snapshot (two clocks, separate copies).
6. **DSAR / deletion cascade (the golden identity is the unit of deletion).** Erasure (`withPrivilegedTx`,
   keyed on the one `master_emails.email_blind_index`, `03:442`): tombstone the golden identity; **delete its
   `verification_jobs` (queue) + `employment_change_outbox` (candidates) + `master_usage` rows** (FK
   `ON DELETE CASCADE` from `master_persons`); insert a GLOBAL suppression row (blocks re-import *and* future
   re-verify/re-reveal); cascade to every overlay copy (`contacts.deleted_at` + null-PII) and its
   `revealed_channels` (by `master_person_id`, `PLAN_04 §RLS-3.5`). A suppressed/erased person is never
   re-enqueued, never signaled, never re-revealed.

---

## Scale-gate analysis

Scale target: millions of users, **billions** of golden rows × continuous decay (CLAUDE.md; C9). N+1 and
unbounded fan-out are failures. *What breaks first at 10×, and the fix:*

| Rank | What breaks first at 10× | Why | Fix (this PLAN) |
|---|---|---|---|
| **1** | **The paid re-verify budget** | a blind TTL sweep re-verifies billions of cold, never-revealed records on a 60–180 d cadence — unbounded provider spend (`ADR-0025:52`) | The **in-use gate** (§2.2): re-verify only `master_usage.reveal_count > 0`; the cold tail decays on paper, verified **lazily at reveal** (D's floor). Drain bounded by the **global `provider_configs` budget** (§2.3). *The single largest cut.* |
| **2** | **A billions-row nightly freshness-score WRITE** | even free (no provider cost), a set-based `UPDATE` of `data_quality_score`/`freshness_status` over the whole universe is a fan-out failure | **Compute the badge at read** from `last_verified_at` (`dataHealth.ts`, pure, no write); the **stored** cache refreshes only at write events + a **band-cross-only** partition-pruned sweep (the narrow slice that changed band), never the whole universe (§1.3). |
| **3** | **`current_company_id` cache goes stale** under job-change write volume | step-6 cache lag → search serves people at the wrong company ("the single most expensive correctness bug," `RESEARCH_06 §4.3`) | **In-tx recompute** from the edge set (`PLAN_02 §1.1 step 6`), `uniq_employment_primary` DB-enforced; only the **search index** lags (eventual, re-checked at read). |
| **4** | **Synchronous overlay fan-out** on a high-reveal person | a celebrity move = 100k synchronous overlay writes on the detection thread | **Async, idempotent, queued** `signal.contact.job_change` fan-out (BullMQ, content-hash-keyed) keyed off `revealed_channels.master_person_id` — bounded by reveal count, partitioned (§3.4; the DSAR-fan-out discipline). |
| **5** | **The CDC firehose** | every master re-verify is a change event; an aggressive trigger floods CDC, blowing reproject lag past read-your-write | **Value-unchanged re-verify emits no reproject** (only a `last_verified_at` bump, §3.3 rule 1); the budget caps paid re-verify volume, which caps the change-event rate; the exact p99 reproject-lag SLO is Phase-5 territory (OQ8). |
| **6** | **The queue itself** at billions of enqueued jobs | an unbounded `verification_jobs` table + a full-scan drain | Range-partition by `enqueued_at`/month (`03:791`); the drain is a **partial-index** `WHERE status='queued' AND in_use` frontier (§0.1) + `FOR UPDATE SKIP LOCKED`; idempotent enqueue collapses duplicates (`uniq_verification_jobs_live`). |

**Verdict:** every first-breakage is an in-scope bound applied now (in-use gate, badge-at-read, in-tx cache,
async fan-out, value-unchanged-no-reproject, partitioned partial-index queue) or rides an already-deferred
component (the OpenSearch/ClickHouse projection is the C9 scale track). The proactive paid work is a
**budget-capped sliver of a free, lazily-gated, set-based scan** — the cost story the brainstorm chose
knowingly.

---

## Failure modes

| # | Failure | Cause | Mitigation |
|---|---|---|---|
| F1 | **False job-change flips the edge + auto-bills N workspaces** (the asymmetric catastrophe) | acting on one uncorroborated source | **Candidate** state held in `employment_change_outbox` (§0.4); corroboration gate (`≥N` sources / multi-signal / new-channel verify) before the SCD2 commit (§3.2); a re-reveal is **always opt-in + charge-only-for-valid** — even a false flip never auto-bills (§3.4; `BRAINSTORM_06 §3 H6`). |
| F2 | **Held overlay data rots after reveal** (bounces, credit-back, sender-rep) | verify-only-on-reveal (D as the spine) | Rejected as the spine (`ADR-0025:51`); ongoing in-use re-verify (§2) + the job-change signal + the Clock-B "newer data available" badge drive a re-reveal. |
| F3 | **Cost runaway** on metered re-verify | no ceiling / per-tenant quota on the wrong path | Global `provider_configs.monthly_budget_cents` breaker + waterfall trust÷cost + cache-first (§2.3); per-tenant quota only on Clock-B re-reveal (§5(iii) — not the master sweep). |
| F4 | **A starved segment rots below SLA unseen** (C's killer) | mis-weighted priority sinks a class below the cut line | **Per-segment** coverage monitor (seniority × in-use × region), alarmed, not just aggregate (§2.1; `BRAINSTORM_06 §2`). |
| F5 | **Re-enrichment clobbers owner curation** (the H2 trap) | B's "invalidate the cached copy" reflex aimed at the overlay | Propagation **signals**, never `UPDATE`s, overlay PII/curation; scores/notes key on `contact_id`, untouched by master-keyed propagation (§4); the pin outranks even a re-reveal. |
| F6 | **`current_company_id` stale → wrong-company search** | cache step lagged/raced | In-tx recompute + `uniq_employment_primary` (`PLAN_02 §1.1/§1.2`); search lag is freshness, re-checked at read (not isolation). |
| F7 | **Double-charge on re-reveal / retry** | the reveal unique admits one row, or a double-click | `(workspace_id, contact_id, reveal_type, reveal_epoch)` unique (§0.5) + client `Idempotency-Key`; credit `FOR UPDATE` + `CHECK (≥0)` (ADR-0007/0013); the epoch is master-controlled (a re-charge needs a confirmed change, never a client request). |
| F8 | **Concurrent re-verify mints a duplicate channel** | two workers verify the same email at once | `master_emails.email_blind_index` / `master_phones.phone_blind_index` GLOBAL **UNIQUE** (`03:442,455`) — concurrent inserts collapse; the verify is an UPDATE of the existing channel. |
| F9 | **Re-verifying / signaling a suppressed or erased subject** | a stale queue/candidate row survives DSAR | Suppression gate excludes from queue (`status='suppressed'`), fan-out, and re-reveal (`master_persons.is_suppressed`, `03:421`); DSAR cascade deletes `verification_jobs`/`employment_change_outbox`/`master_usage` (FK cascade, §RLS-6). |
| F10 | **The free sweep writes PII / a pinned value** | an over-broad set-based `UPDATE` | The sweep is constrained to two non-PII quality columns under `leadwolf_sweep`, skips tombstones, and never addresses a pin (§1.3/§4/§RLS-2). |
| F11 | **Duplicate / double enqueue** (sweep + event race) | a record stale-and-evented enters the queue twice | `uniq_verification_jobs_live (entity, field, sla_period)` partial unique (§0.1); an event UPSERTs the priority up, never a second row (§5(ii)). |
| F12 | **CDC firehose blows reproject lag** | aggressive re-verify floods change events | Value-unchanged re-verify emits no reproject; budget caps the rate; bounded enqueue (§3.3 rule 1; Scale-gate rank 5). |
| F13 | **Layer-0 lifecycle table readable by a tenant** | accidental `workspace_id`/grant on the queue | No `workspace_id`, no `leadwolf_app` grant; negative access itest (§RLS-1/-5b). |

---

## Pre-build thinking pass (the applicable items — `PLAN_00 §8`)

- **1 Source of truth.** Layer-0 golden (Clock A) is truth for *current* reality; `source_records` is truth
  for *lineage*; the overlay snapshot (Clock B) is a deliberately-frozen copy; the search index is a derived
  projection (C1; ADR-0035). The freshness *score* is a derived recompute over `last_verified_at`.
- **2 Failure modes / idempotency.** Enqueue idempotent on `(entity, field, sla_period)`; job-change emit on
  `employment_change_outbox.content_hash`; SCD2 on `source_records.content_hash` + `UNIQUE(person,company,
  started_on)`; re-reveal on `(ws, contact, reveal_type, reveal_epoch)`; fan-out content-hash-keyed → a re-run
  converges, never double-charges, never double-opens an edge.
- **3 Duplicate prevention.** Master channel blind-index uniques (`03:442,455`) stop concurrent re-verifies
  minting a duplicate; `uniq_verification_jobs_live` stops a double enqueue; the candidate gate stops a
  double flip.
- **4 Audit + change history (same-tx).** A re-verify/job-change appends a `source_record` + a survivorship
  delta (`PLAN_03 §1.5`); the SCD2 closed edge *is* the history; `employment_change_outbox` records the
  candidate→commit lineage; credit-back/charge audited via `credit.adjust` (ADR-0013); privileged sweeps
  write `platform_audit_log` in the same tx.
- **5 Security (IDOR / exposure / abuse).** Layer-0 machinery runs under system roles, never `leadwolf_app`;
  the signal is RLS-scoped + un-attributed (C2); `master_usage` is an aggregate count; a suppressed person is
  excluded everywhere; re-verify produces **no** customer-visible output without a reveal (no free
  membership-probe oracle, `RESEARCH_06 §7.5`).
- **6 Scalability / 10×.** In-use-gated paid re-verify; badge-at-read; in-tx cache; async bounded fan-out;
  value-unchanged-no-reproject; partitioned partial-index queue — Scale-gate.
- **7 Observability.** Emit `verification.completed`/`failed`, queue depth/lag, per-segment coverage,
  daily spend vs budget + cache-hit (the economics dashboard, `06 §10`), `employment.candidate.held`/
  `committed`/`rejected`, signal-fan-out depth, re-reveal rate, `current_company_id` recompute lag; a breached
  coverage/budget threshold pages Ops (`22 §5:155`).
- **8 Rollback.** Everything additive + reversible: the score sweep is recompute-from-`last_verified_at`; a
  wrong re-verify is corrected by the next `source_record` + survivorship replay (`PLAN_03 §1.5`); an
  erroneous edge transition is reversible by re-running ER over the cluster's evidence; the queue, the
  detector, and the re-reveal are each flag-gated (a bad resolver/detector turns off without orphaning).
- **9 Edge cases.** Never-verified record (cold start → aging, lazy verify at reveal); person with no current
  edge (between jobs → `current_company_id` null, no fake company, `PLAN_02 §1.3`); concurrent re-verify
  (idempotent on blind-index unique); a job change *back* to a prior company (re-opens via the `started_on`
  unique, history intact); a bounce racing a re-reveal (`FOR UPDATE` on the balance); a pinned overlay value
  the master contradicts (signal, pin wins); a value-unchanged re-verify (bump `last_verified_at`, no
  reproject); an unknown/invalid re-verify result (`credits_consumed=0`, ADR-0013).
- **10 Assumptions (load-bearing).** (a) The two-clock split holds — master re-verify is system cost, overlay
  re-reveal is workspace cost. (b) Cold never-revealed masters can be left to decay un-re-verified (lazy). (c)
  The `master_usage` reveal-count is a sufficient day-1 in-use signal (active-list rollup deferred). (d)
  Measured decay (`RESEARCH_06 §2`) is in the SLA ballpark; re-tune from observed data (`ADR-0025:62-65`).
- **11 Misuse.** A workspace cannot enqueue a master re-verify (no privilege) or read the queue; it can only
  request an on-demand premium / opt-in re-reveal on its **own** records, credit-gated; a re-reveal cannot be
  forced on another workspace; the epoch is master-controlled so a client cannot self-bump to re-charge.
- **12 Load behaviour (10×).** Bottleneck order = the Scale-gate table (paid budget → freshness write →
  cache staleness → fan-out → CDC firehose → queue), each with its fix.
- **13 Worst case.** A mass re-enrichment wave (a provider job-change feed import) hitting a celebrity
  super-node: bounded because re-verify is in-use-gated + budget-capped, the SCD2 commit is corroboration-
  gated, the cache recompute is in-tx, the signal fan-out is async + bounded + idempotent, and the cold tail
  is never swept.

---

## Open questions

The eight `BRAINSTORM_06 §6` questions, each **resolved** by this PLAN or handed forward with an owner, plus
the residuals this gate opens:

1. **OQ1 — the in-use predicate (the cost keystone).** *Resolved:* day-1 = `master_usage.reveal_count > 0`
   **OR** recent `last_revealed_at` (written O(1) in the reveal tx, §0.3/§2.2); Phase-6.1 adds an aggregate
   `active_ref_count` rollup (privacy-preserving, no workspace id). *Residual:* the exact recency window +
   the active-list rollup cadence — tune from measured bounce/credit-back (`truepoint-operations`).
2. **OQ2 — priority weights + per-plan budget + per-segment monitor.** *Resolved shape:* `f(decay, use,
   seniority, dq_drop, urgency)` with weights + per-plan budget split in `data_quality_rules`, and a
   per-segment coverage monitor (§2.1). *Residual:* the actual weights/budget split — *a priori*, re-tuned
   from measured precision/coverage (like `ADR-0025` SLAs).
3. **OQ3 — decay-curve shape.** *Resolved:* linear (the shipped `freshnessSubScore`, `1 − ratio/1.5`,
   `dataHealth.ts:44-47`) is the default; tunable in `data_quality_rules.decay.curve`. *Residual:* whether
   exp/logistic per field measurably improves the badge — defer until measured decay says so.
4. **OQ4 — corroboration threshold + candidate-edge state machine.** *Resolved:* `employment_change_outbox`
   `state ∈ candidate|committed|rejected` + `corroboration` (§0.4); commit gate = `≥N` sources / multi-signal
   / new-channel verify; ambiguity → `match_links` review band; **never auto-charge** (§3.2/§3.4). *Residual:*
   the threshold `N` + per-source weighting (config; calibrate against the `≤0.5%` false-merge target).
5. **OQ5 — re-reveal pricing on a confirmed job change.** *Resolved mechanism:* `reveal_epoch` bump +
   `charge-only-for-valid` + per-tenant credit quota (ADR-0007 `FOR UPDATE`); the F8 debt is closed without
   relaxing the unique (§0.5). *Residual:* full-price vs discounted refresh vs free-within-window — owned with
   ADR-0013/0029 + the credit-back window.
6. **OQ6 — signal-vs-auto-refresh policy per field.** *Resolved:* PII channels (email/phone) are **signal-only**
   (§3.3 rule 3); a low-risk **non-PII firmographic facet** (e.g. an `employee_band` recount) **may**
   auto-apply to the overlay facet column **iff not pinned**. *Residual:* the exact field line + whether it is
   workspace-configurable (`data_quality_rules`).
7. **OQ7 — job-change detection sourcing + cadence + DPA.** *Handed forward:* which inputs (provider feeds /
   LinkedIn-derived / email-signature / re-import diff) feed the Layer-0 detector and at what cadence (weekly,
   like ZoomInfo Tracker) + the DPA lineage — owned by `21-data-acquisition-sourcing.md`.
8. **OQ8 — CDC firehose backpressure.** *Resolved in part:* value-unchanged re-verify emits no reproject; the
   budget caps the change-event rate (§3.3 rule 1; Scale-gate rank 5). *Residual:* the exact p99 reproject-lag
   SLO so `current_company_id` never serves wrong-company — set in `RESEARCH_05`/Phase 5.

**Newly opened by this PLAN:**

- **NQ1 — `master_usage` privacy review.** Does an aggregate `distinct_ws_count` on a Layer-0 row leak any
  membership signal (e.g. "this person is revealed by exactly 1 workspace")? Security sign-off + a minimum-
  bucket floor if needed (`truepoint-security`; mirrors the masked-search small-cell suppression,
  `PLAN_04 §RLS-2`).
- **NQ2 — the `leadwolf_verify` / `leadwolf_sweep` grant DDL + key boundary.** The exact least-privilege
  grants (queue-drain master `SELECT`/`UPDATE`; sweep two-column overlay `UPDATE`) and the KMS boundary at
  re-verify — owned jointly with `truepoint-security` (the `PLAN_04 §OQ2` reveal-role analogue).
- **NQ3 — master purge vs retain for the cold, unused tail.** When a master record is beyond retention and
  *unused by any workspace* (`master_usage.reveal_count = 0`), purge or archive to the lake? (`22 §7`;
  `RESEARCH_06 §8 OQ7`) — intersects the deletion gate; default: archive-then-purge under the storage-
  limitation policy.

> **Implementation status (gap → work-to-do, never license to skip a rule).** Shipped today and reused: the
> Clock-B overlay fields (`contacts.last_verified_at`/`data_quality_score`/`freshness_status`, `03:544-546`),
> the entire decay/score math (`dataHealth.ts:19-203`, pure + tested), the `intent_signals.job_change`/
> `new_hire` enum (`intel.ts:80-81`), the waterfall trust÷cost + circuit breaker (`waterfall.ts`), the
> `provider_calls` cache + `provider_configs.monthly_budget_cents` budget (`intel.ts:88-127`), and the bulk
> `enrichment_jobs`/`chunks`/`rows` ledger a re-verify campaign rides (`enrichmentJobs.ts:41-160`).
> Designed-but-unbuilt and **finalized by this PLAN**: `verification_jobs` and `data_quality_rules` (named in
> `03:779,820`, undefined until now), `master_usage` (the net-new in-use counter), the
> `employment_change_outbox` candidate→commit machine (`PLAN_02 §1.1` reserved the seam), and `reveal_epoch`
> (closing `PLAN_04` F8/OQ3). These build **on** the still-unbuilt Layer-0 master graph + SCD2 edge
> (`PLAN_01`/`PLAN_02`), the `field_provenance` two-clock substrate (`PLAN_03`), and the `revealed_channels`
> projection (`PLAN_04`) — all designed, not yet built (Layer 0 is 100% docs, `PLAN_00` C1). Net-new Phase-6
> invention the build owns: the priority function + in-use predicate, the SCD2 corroboration gate, and the
> hard-partitioned CDC propagation (invalidate cache/projection, signal-only overlay). None of these gaps
> relaxes a constraint — when built, master re-verify stays system-owned and un-attributed under a **global**
> budget (the per-tenant quota lives only on Clock B), overlay refresh stays an opt-in `charge-only-for-valid`
> re-reveal that respects the pin and never invalidates owner curation, the edge stays SCD2 so history
> survives, the queue stays budget-gated and suppression-aware, and the resolution/idempotency keys stay
> backed by DB uniques (`03:442,455,464`; `uniq_verification_jobs_live`; the epoch-widened reveal unique) so
> concurrent re-verifies cannot mint duplicates and a job change never double-charges. The deferrals (the
> active-list rollup, the cold-tail purge, the exact pricing/weights/SLO) are **deferral, not omission** —
> each is reachable additively from the structures this gate freezes.
