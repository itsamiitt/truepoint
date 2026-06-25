# Phase 6 — Lifecycle Options: What Organizing Mechanism Keeps a Billions-Row Graph Fresh Under a Budget

> **Gate: BRAINSTORM.** Phase 6 of the prospect↔company data initiative. The RESEARCH gate
> ([`RESEARCH_06_freshness.md`](./RESEARCH_06_freshness.md)) fixed the *framing*: two freshness clocks governed
> differently (Clock A = system-owned master channel `last_verified_at`, re-verified once on TruePoint's own
> cost; Clock B = the frozen per-workspace overlay snapshot, refreshed only by a billable re-reveal —
> `RESEARCH_06 §1`), a free set-based decay-*score* sweep distinct from a paid *re-verify* (`§4.1`), job-change
> as an SCD2 transition not a mutation (`§4.3`), and propagation with three distinct rules — eager reproject,
> in-tx cache recompute, signal-never-overwrite for the overlay (`§4.4`). This gate takes that as settled and
> brainstorms the **one thing the research left open as a genuine design space: what *single organizing
> mechanism* drives the lifecycle?** It stands up four distinct mechanisms — a TTL fixed-clock sweep, an
> event-driven CDC propagation model, a decay-scored priority queue under budget, and a lazy read-triggered
> verify — names each one's strongest argument and the failure that kills it, stress-tests them against the
> hardest cases (the job-change SCD2 cascade; preserving per-owner overlay state; cost ceilings + per-tenant
> quotas; a billions-row sweep; freshness-vs-over-spend; **false** job-change), explicitly challenges the
> obvious TTL-sweep default, and ends with a single DECISION + open questions. **It does not write the plan.**
> **Depends on:** [`RESEARCH_06_freshness.md`](./RESEARCH_06_freshness.md) (the gate this builds inside — every
> external figure carries its `[VERIFIED]`/`[INFERRED]` provenance by reference; this gate adds no new external
> research), [`RESEARCH_02`](./RESEARCH_02_linking_patterns.md) (SCD2 edge), [`RESEARCH_03`](./RESEARCH_03_mdm_merge.md)
> (per-field provenance + survivorship), [`RESEARCH_04`](./RESEARCH_04_tenancy_projection.md) (the access-path
> wall; Cognism re-charge), and the sibling decisions [`BRAINSTORM_03`](./BRAINSTORM_03_merge_options.md) /
> [`BRAINSTORM_04`](./BRAINSTORM_04_projection_options.md) (the copy-on-reveal overlay this propagates into).
> **Ground truth:** [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md),
> [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md),
> [ADR-0007](../decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md),
> [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md),
> [ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md);
> [22](../22-data-quality-freshness-lifecycle.md) §2.4/§3/§4/§5; [03 §5.1/§5.2/§14](../03-database-design.md);
> `packages/db/src/schema/intel.ts`, `enrichmentJobs.ts`, `core/src/enrichment/waterfall.ts`.

---

## 0. What this gate decides — and what it must not reopen

RESEARCH_06 decided the **physics** of freshness (two clocks; score-decay ≠ verify; SCD2; signal-not-overwrite).
It deliberately handed the BRAINSTORM gate the **mechanism** question (`RESEARCH_06 §8` OQ list): *given that
every value is decaying and re-verify is metered, what is the single organizing principle that decides which
records get re-verified, when, and in what order — and how does a change reach the projection and the overlay?*
That is a real open design space because the naive answer (a TTL clock) is the one the accepted ADR already
rejects (`ADR-0025:52`), so the gate has to do the work of justifying the alternative rather than defaulting.

**Fixed by RESEARCH_06 — not reopened here.** The two-clock split (master re-verify is amortized *system* cost;
overlay refresh is a *workspace* re-reveal — `RESEARCH_06 §1`, `§5`); per-field SLAs stay as
`ADR-0025:25-27` sets them (email 90d, phone/firmographics 180d, employment/title 60d, intent 30d-rolling);
the freshness **sub-score** decays continuously and is recomputed by a *free* set-based sweep, never row-by-row
(`22 §2.4:106-116`, `§3:128-130`); job change is SCD2 close-old/open-new + in-tx `current_company_id` recompute,
idempotent on `source_records.content_hash` + `UNIQUE(master_person_id, master_company_id, started_on)`
(`03 §5.1`; `RESEARCH_06 §4.3`); a master change is a **signal** to the overlay, never a silent overwrite, and
an overlay pin outranks even an opt-in re-reveal (`RESEARCH_06 §4.4`; `ADR-0015` survivorship). None of the four
options below may weaken those; an option that does is disqualified, not "simpler."

The cross-cutting constraints carried from the shared ground-truth and `RESEARCH_06`: **C1** Layer 0 is
system-owned (re-verify runs under the ER/system role, never `leadwolf_app`; the signal lands RLS-scoped per
workspace); **C2** owner/visibility is an app-layer filter on the overlay, never on the shared ownerless master;
**C3** master re-verify = system cost, overlay re-reveal = `charge-only-for-valid` workspace cost — never
conflated (`ADR-0013:21-36`); **C4** suppression/DSAR fan-out reaches every copy and excludes suppressed records
from re-verify (`master_persons.is_suppressed`, `03 §5.1`); **C5** billions of rows × continuous decay — N+1 and
unbounded fan-out are failures.

---

## 1. The axis being brainstormed

The lifecycle is a pipeline; the question is **what drives its first stage** (the decision to spend a verify
credit) and **how its last stage propagates** (the change reaching downstream). Pure forms of four mechanisms:

```
   ┌─ what DRIVES the re-verify spend? ─────────────────────────────────────────────────┐
   │   (A) TIME          (B) CHANGE-SIGNAL      (C) VALUE × DECAY ÷ BUDGET   (D) DEMAND   │
   │   a clock sweeps    an external event       a priority queue picks       a read pulls │
   │   everything > SLA  (bounce/job-change/CDC) most-stale×most-valuable     it at reveal │
   └────────────────────────────────────────────────────────────────────────────────────┘
                    │                                                          │
   verification_jobs (BullMQ on Redis) ── waterfall (trust÷cost, breaker, waterfall.ts:50-60) ── verifier
                    │                                                          │
        ┌───────────┴─── CLOCK A: master re-verify (system cost) ─────────────┘
        ▼
   master_* updated ──► PROPAGATE (the (B) axis, needed regardless of the trigger):
        ├─ (1) OpenSearch / ClickHouse projection ─ REPROJECT eagerly (ADR-0035 outbox/CDC)
        ├─ (2) master_persons.current_company_id + has_email/has_phone ─ recompute IN-TX
        └─ (3) per-workspace overlay (CLOCK B) ─ SIGNAL only (intent_signals.job_change, intel.ts:80-81);
                                                 owner opts into a billable RE-REVEAL (ADR-0013); pin wins
```

The crucial structural observation this gate makes up front — and returns to in §5 — is that **(B) is not the
same kind of thing as (A)/(C)/(D)**. (A), (C), and (D) answer *"what decides to spend a verify credit?"*; (B)
answers *"how does a value that changed reach search, cache, and overlays?"* Those are **orthogonal axes**. A
real lifecycle needs an answer to *both*. Treating (B) as a rival to (C) is a category error that the naive
reading of the task invites; the honest contest among *spend triggers* is **A vs C vs D**, with **B adopted as
the propagation substrate no matter which wins**. Each option below is nonetheless stood up in its strongest
*pure* form (as if it were the whole lifecycle) so its killer is exposed, then the synthesis in §5–§6 composes
the survivors.

Each option answers four sub-questions; the options differ exactly in these answers:

| | **Q1** what fires a paid re-verify? | **Q2** what bounds the spend? | **Q3** how is order decided? | **Q4** how does a change propagate? |
|---|---|---|---|---|
| **A** TTL sweep | a cron: every record `age/SLA > 1` | nothing intrinsic (cron covers all) | none (whole-universe pass) | (must bolt on B) |
| **B** event-CDC | an inbound event (bounce/job-change/feed) | the event arrival rate | event order | **native** — the whole option |
| **C** decay-priority queue | the queue head, while budget remains | `provider_configs.monthly_budget_cents` | `f(decay, use, seniority, urgency)` | (adopts B for the downstream) |
| **D** lazy read-trigger | a workspace read (reveal / export / pre-send) | demand (= reveal volume) | read order | (adopts B for the downstream) |

---

## 2. The four mechanisms

### Option A — TTL fixed-clock sweep (TIME-driven)

**Schema / flow.** A nightly cron scans the master channels and enqueues **every** record whose
`now − last_verified_at` exceeds its per-field SLA (`ADR-0025:25-27`; `22 §3:120-126`) into `verification_jobs`
(`03 §14`), with no priority and no in-use gate — coverage by brute force. The free freshness-*score* sweep
(`22 §2.4:115-116`, set-based `UPDATE … FROM`) runs alongside it; pure A then *also* pays to re-verify every
expired row.

**Strongest argument: provable, uniform coverage and the simplest possible mental model.** No record's verified
state is ever older than its SLA, so the §5 coverage targets (`22 §5:147-153`: email-coverage ≥ 80%, fill-rate
≥ 85%) hold *by construction* across the entire universe, and Ops can reason about freshness with a single
number ("nothing is past SLA"). It is, almost verbatim, the cadence language `ADR-0025:25-27` uses — which is
exactly why it is the seductive default (§4).

**Killer failure mode: it is financially impossible at billions of rows, and the ADR already rejects it.**
Re-verifying the whole universe on a 60–180-day clock spends provider credits on billions of **cold,
never-revealed** records nobody will query — `ADR-0025:52` rejects "re-verify everything on a fixed clock" in
as many words: *"Wasteful; ignores decay/priority; cost-unbounded."* The spend is decoupled from revenue, which
detonates the cost-per-reveal unit economics (`06 §10`; `RESEARCH_06 §5`). Worse, at billions × (365/90 ≈ 4)
email re-verifies/year the sweep **cannot physically complete** within the SLA window at any sane provider QPS —
so A doesn't even deliver the coverage it promises; it delivers an ever-growing backlog. And the obvious patch
(bolt a budget gate onto the sweep so it stops at the ceiling) doesn't rescue A — it silently *converts A into
an arbitrarily-ordered Option C*, paying for C's machinery while discarding C's priority. A's simplicity is the
illusion that survives only until it meets the budget.

### Option B — Event-driven CDC propagation (CHANGE-driven)

**Schema / flow.** Layer-0 master changes are captured as outbox/CDC events (`ADR-0035` outbox/CDC; the
search-sync worker, `03 §12`) and each event re-projects to OpenSearch/ClickHouse, recomputes the in-tx
firmographic cache, and fans a signal to overlay copies. As a *trigger*, pure B re-verifies only what an inbound
event names: a bounce webhook (SES SNS→SQS), a third-party job-change feed row, a reveal. The move **is** the
trigger (the Clay live-trigger model, `RESEARCH_06 §3.3` `[VERIFIED]`); a record with no inbound event is never
re-verified. Job-change is B's home turf: detect → emit one event → SCD2 transition (`RESEARCH_06 §4.3`) →
bounded async fan-out.

**Strongest argument: it is the only option that actually solves propagation, and it spends with perfect ROI
on the records that demonstrably changed.** (A)/(C)/(D) all leave the downstream question unanswered — a
re-verify result still has to reach search, cache, and overlays, and that *is* B. As a trigger it never wastes a
credit on an unchanged record (the highest possible ROI per credit; the Cognism/Clay "spend on the signal, not
the clock" pattern, `RESEARCH_06 §3.3`), and for the headline job-change feature it is the natural shape:
detect-once-at-Layer-0 → fan a signal to the N workspaces holding the person (the UserGems inversion,
`RESEARCH_06 §3.2`).

**Killer failure mode (as a *trigger*): it is blind to silent decay, and its "invalidate" instinct is poison
for the overlay.** A B2B email quietly dies 30–90 days after a departure with no bounce and no feed entry
(`RESEARCH_06 §2` `[VERIFIED]`) — pure B never refreshes it because no event ever fired; freshness becomes only
as good as an external feed's coverage, and you are paying a third party to tell you what to refresh. Two
further failures make pure-B unshippable as the *spine*: (1) **the event firehose at billions** — every master
re-verify is itself a change event, so an aggressive trigger floods the CDC pipeline and the projection lag
blows past the read-your-write window, leaving `current_company_id` stale and search serving people at the wrong
company ("the single most expensive correctness bug here," `RESEARCH_06 §4.3`); (2) **B has no budget concept**
— a bulk job-change-feed import or a bounce storm spikes spend with nothing to cap it (fails the cost ceiling,
H3). And the word "invalidate" in "CDC re-project + invalidate" is *exactly wrong* for the overlay: the overlay
is **not** a cache of the master, it is an owned snapshot + curation (notes/scores/owner). Invalidating it would
wipe the owner's curated state — a direct survivorship/owner-view violation (`RESEARCH_06 §4.4`; `ADR-0015`).
B's reflex must be hard-scoped to the projection and the derived cache; the overlay gets a *signal*, never an
invalidation. So B is indispensable as the **propagation axis** and disqualified as the **spend-trigger spine.**

### Option C — Decay-scored priority queue under budget (VALUE × DECAY ÷ BUDGET)

**Schema / flow.** `verification_jobs` (`03 §14`; `22 §4:132-140`; `ADR-0025:28-30`) ordered by a priority
function `priority = f(decay = age/SLA, recency-of-use, seniority, data_quality_score-drop, event-urgency)`. The
nightly **free** set-based decay scan (`22 §2.4:115`) refreshes the decay component and *emits enqueue intents*
for records that are **both** stale **and** in-use; the queue is drained head-first until the budget
(`provider_configs.monthly_budget_cents`, `intel.ts:125`) is exhausted, behind the per-provider circuit breaker
(`waterfall.ts:50-60`). A re-verify campaign reuses the shipped bulk job ledger (`enrichment_jobs`/`chunks`/`rows`,
`enrichmentJobs.ts`; `ADR-0039`). Events (bounce/job-change/reveal/on-demand) are not a separate mechanism —
they enqueue at **maximal priority** (§5).

**Strongest argument: it is the only option where "freshness vs over-spend" is a tunable dial rather than a
binary, and it is budget-bounded by construction.** C spends the finite budget on exactly the records that are
both most-decayed and most-valuable/in-use — `ADR-0025:28-30`'s "recently-revealed and high-decay first," and
the Cognism seniority tier (director+ every 30d, `RESEARCH_06 §3.1` `[VERIFIED]`). The freshness/spend trade-off
is a continuous function of the budget and the priority weights, not a cliff. At 10× volume C does **not** break:
it covers a smaller fraction of the cold universe at the *same* spend, gracefully and predictably — the scale
behavior A and B both lack. It directly extends shipped infrastructure (`verification_jobs` priority is the
ADR's own design; the budget breaker and the bulk ledger already exist).

**Killer failure mode (the honest one): it is the most complex to tune, and a mis-weighted priority silently
starves a segment.** C requires three under-specified knobs — the priority function (`22` OQ6), the **in-use
predicate** (the §5 keystone, OQ2), and the per-tier budget (`22` OQ2:252) — and if the priority is
mis-calibrated a whole class of records (e.g. mid-seniority, rarely-revealed) can sink permanently below the cut
line, rotting its coverage below the §5 SLA with **no alarm** unless coverage is monitored *per segment*, not
just in aggregate. And C, alone, is incomplete: it does not propagate (it needs B for the downstream) and it has
no principled answer for the **cold never-revealed tail** — proactively re-verifying records no workspace holds
is the very waste A is killed for, so C must *exclude* them, which means importing D's lazy-at-reveal as the
floor. C is the spine, not the whole skeleton.

### Option D — Lazy / read-triggered verify (DEMAND-driven)

**Schema / flow.** No proactive re-verify at all. The free score-sweep keeps `freshness_status` honest
(`22 §2.4:115`), but a record is **only** re-verified when a workspace pulls it — at reveal/re-reveal, at export,
at the pre-send freshness check (`RESEARCH_06 §4.2` event sources). Cold records decay on paper and are touched
lazily at first use. This is "verify-on-access," and it is the cost keystone RESEARCH_06 named (`§5`: re-verify
only in-use; let cold decay).

**Strongest argument: minimal possible spend, perfectly aligned to revenue, and trivially billions-feasible.**
Every verify credit maps 1:1 to a paying-customer use event (ideal cost-per-reveal alignment, `06 §10`), and
because D does **zero** proactive work it is the only option that is *trivially* feasible over a billions-row
universe — there is no sweep to size, no queue to drain, no firehose to absorb. It is also, surprisingly, the
**safest on false job-change** (H6): D never acts on an unpaid, uncorroborated signal — it only "discovers" a
move at a *paid* reveal where the provider waterfall corroborates it, so it never auto-flips an edge or
auto-charges on a single bad source.

**Killer failure mode: held data rots after reveal — the exact failure `ADR-0025:51` rejects.** D refreshes the
moment of reveal but never the months after: a list a workspace revealed six months ago and is now emailing is
full of dead addresses → bounces → credit-back cost → sender-reputation damage — `ADR-0025:51` rejects
verify-only-on-reveal precisely because *"Data ages after reveal; bounce/credit-back cost rises; stale
exports."* D also cannot detect job-changes proactively (no scan), so the UserGems-style "your contact moved"
alert — a headline feature (`RESEARCH_06 §3.2`) — is impossible. D is the right **floor** (the cold-tail policy
and the lower-bound spend model) and the wrong **whole**.

---

## 3. Stress test against the hard cases

| Hard case | **A** TTL sweep | **B** event-CDC | **C** decay-priority queue | **D** lazy read-trigger |
|---|---|---|---|---|
| **H1** job-change SCD2 cascade (close edge / open / flip `current_company_id` / propagate) | ◐ catches it, but only as a side effect of the 60-day employment sweep — late + at full sweep cost | ✅ native: detect → event → SCD2 → fan-out | ✅ employment-SLA decay priority + event-boost = as fast as B, budget-aware | ❌ never proactively detects; only surfaces at the next paid reveal |
| **H2** preserve per-owner overlay state (notes/scores survive) | ✅ trigger-agnostic; overlay untouched | ❌ **trap**: B's "invalidate the cached copy" reflex wipes owner curation if mis-scoped to the overlay | ✅ writes a signal, never an overlay `UPDATE` | ✅ overlay untouched |
| **H3** cost ceiling + per-tenant quota | ❌ unbounded; ceiling = "stop = become C" | ❌ no ceiling concept; event/bounce storms spike spend | ✅ budget gate is first-class; quota on Clock-B re-reveal | ✅ demand-bounded (= reveal volume), naturally capped by credits |
| **H4** billions-row sweep feasibility | ❌ cannot complete within SLA at sane QPS | ◐ no scan (good) but event firehose can swamp CDC | ✅ free set-based decay scan; paid part budget-capped to a sliver | ✅ zero proactive work |
| **H5** freshness vs over-spend | ❌ binary (full coverage or blown budget) | ❌ no control over total spend | ✅ the *only* tunable dial (budget × priority weights) | ◐ implicit dial (= demand); minimal proactive freshness |
| **H6** false job-change | ◐ re-verify corroborates, but a single bad source can still flip on a 60d cycle | ❌ **most exposed**: one bad event → instant flip + fan-out + N billable re-reveals on bad data | ◐ same exposure unless a corroboration gate is inserted (it can be) | ✅ safest: never acts on an unpaid, uncorroborated signal |

The three sharpest, in prose:

**H1 — the job-change SCD2 cascade, and why the trigger matters less than the transaction.** The cascade itself
is trigger-independent and already specified (`RESEARCH_06 §4.3`): in **one** transaction, close the prior edge
(`is_current=false`, `ended_on`), open the new edge (`INSERT`, idempotent on
`UNIQUE(master_person_id, master_company_id, started_on)`, `03 §5.1`), recompute `current_company_id` as a
*derived* cache **never** hand-set, and emit one `job_change` signal (`intent_signals` already ships the enum,
`intel.ts:80-81`). What the *trigger* changes is **latency and cost**: A catches a move only when the 60-day
employment SLA expires (late, full-sweep cost); B and C catch it the moment the detector fires (the event feeds
the queue at top priority); D never proactively catches it at all. So H1 favors a model where a **change event
can jump the queue** — which is C-with-event-inputs (= B's strength imported as a priority signal), not pure A
and not pure D. Critically, the same transaction must also enqueue a re-verify of the *new* channel (the new
email is `unverified`; the old goes `risky`/`invalid`, matching the 30–90-day post-departure reality,
`RESEARCH_06 §2`/`§4.3`) — i.e. job-change detection *creates* C-queue work, it does not bypass it.

**H2 — preserving owner state, and B's "invalidate" trap (the subtle one).** Per-owner overlay state — notes,
`scores` (`intel.ts:40`, keyed on `contact_id`, independent of any master value), `owner_user_id`/`visibility`
(`03 §5.2`), a human-pinned field (`RESEARCH_03 §B.2`) — must survive **every** propagation. This is satisfied
*by construction* only if propagation writes a **signal + a Clock-B badge flip**, never an `UPDATE` on the
overlay PII/curation columns (`RESEARCH_06 §4.4`). The danger is entirely in Option B's vocabulary: "CDC →
re-project + **invalidate**" is correct for the search index and the derived firmographic cache (they *are*
caches of the master and *should* be invalidated/recomputed) and catastrophic for the overlay (it is *not* a
cache — invalidating it destroys owned curation). The decision (§6) therefore hard-partitions B's propagation:
**invalidate/reproject the projection + cache; signal-only the overlay.** The scores/notes survive because they
live in overlay-owned tables keyed on `contact_id`, never overwritten by a master-keyed propagation — a
structural guarantee, not a runtime check.

**H6 — false job-change, the asymmetric catastrophe.** A *false positive* is far costlier than a false negative
here: flipping `current_company_id` on bad evidence invalidates the (actually-still-valid) email, fans a wrong
"moved jobs" signal to every workspace holding the person, and — if naively wired — triggers N billable
re-reveals on data that was already correct. Pure B is **most exposed** (it acts on every inbound event,
including one scraped signature or one bad feed row); D is **safest** (it never acts on an unpaid, uncorroborated
signal — the move is only ever realized at a paid reveal where the waterfall corroborates). The decision must
therefore import D's caution into the C/B path with explicit guardrails:

```
  job-change SIGNAL (single source)                  the guardrail the obvious design skips
        │
        ▼
  CANDIDATE edge (held, is_current unchanged)  ──►  routes to the match_links review band
        │   require corroboration:                  (review_status='pending', 03 §5.1) on ambiguity
        │   source_count ≥ threshold  OR  multi-signal agreement (signature + feed + scrape)
        │   OR a successful verify of the NEW channel
        ▼
  COMMIT transition (close old / open new / flip current_company_id / fan-out)
        │
        └─ NEVER auto-charge a re-reveal: the workspace OPTS IN (ADR-0013 charge-only-for-valid; RESEARCH_06 §4.4)
```

A single uncorroborated source must produce a **candidate** edge (held), not a committed flip; corroboration
(multiple independent sources / `source_count` over a threshold / a verify of the new channel) gates the commit;
and a re-reveal is *always* opt-in and `charge-only-for-valid`, so even a false flip never auto-bills a customer.
This costs a little detection latency to buy back the ≤ 0.5% false-merge bound under churn (`22 §6:166`) — the
right trade, and one the obvious "react to every signal" design (pure B) silently skips.

---

## 4. Challenging the obvious default (the TTL sweep, A)

The TTL sweep is the obvious default because it is the simplest mental model and because `ADR-0025:25-27`'s
per-field-cadence language *reads* like a clock. It must be challenged hard, on four grounds:

1. **It contradicts an Accepted ADR.** `ADR-0025:52` already rejects "re-verify everything on a fixed clock" as
   *"Wasteful; ignores decay/priority; cost-unbounded."* Adopting A as the spine would re-open a settled
   decision in the wrong direction — a precedence violation, not a simplification.
2. **Its coverage promise is met more cheaply *without* it.** The §5 coverage SLAs (`22 §5:147-153`) are
   defensible on the **in-use population** — the records workspaces actually reveal, list, and send to — not on
   the cold universe. C meets those SLAs on the records that matter while spending nothing on records no one
   queries; A spends the budget *uniformly*, which means it spends most of it where it produces no measurable
   coverage on any dashboard a customer or Ops looks at.
3. **At billions the sweep cannot deliver its own promise.** A's whole appeal is "nothing is ever past SLA," but
   at billions × 4 email-verifies/year no realistic provider QPS lets the sweep finish inside the 90-day window
   — so A delivers a perpetually-growing backlog, i.e. the staleness it was supposed to abolish, plus the bill.
4. **Budget-gating A *is* C, worse-ordered.** The instant you cap A at `provider_configs.monthly_budget_cents`,
   it stops mid-universe in arbitrary order — you have paid for C's queue-and-budget machinery while throwing
   away C's priority. There is no coherent "A with a budget" that isn't a strictly-worse C.

**The precise refinement — there *is* a legitimate clock, and it is free.** The trap is conflating two
different sweeps. A clock-driven, set-based recompute of the freshness **score** (`22 §2.4:115`, pure arithmetic
over `now − last_verified_at`) is correct, billions-feasible, and **adopted** — it spends nothing and keeps
Data Health honest. A clock-driven **paid re-verify** of every expired record is rejected. The obvious default
is wrong only because it fuses the two; split them and the clock survives exactly where it costs nothing. This
challenge does **not** rehabilitate pure B (silent-decay-blind, no ceiling, firehose) or pure D (post-reveal
rot, no job-change detection) as the spine either — it points at C.

---

## 5. Synthesis groundwork — three findings that shape the decision

Before deciding, three findings from §1–§4 that the PLAN must carry:

**(i) Trigger and propagation are orthogonal — B is the propagation, not a rival trigger.** The contest among
*spend triggers* is A vs C vs D. B is adopted regardless as the **downstream** mechanism, and hard-partitioned:
invalidate/reproject the OpenSearch/ClickHouse projection and recompute the derived firmographic cache (they are
caches and *should* be invalidated, `ADR-0035` outbox/CDC); **signal-only** the overlay (it is owned, not a
cache — `RESEARCH_06 §4.4`; H2). Conflating these two halves of B is the single most common way to "lose" owner
state.

**(ii) Events collapse *into* C's priority — one queue, one budget, not two mechanisms.** RESEARCH_06 framed
events as "jumping" a separate queue (`§4.2`); this gate sharpens that: there is **one** `verification_jobs`
queue and **one** budget, and an event (job-change, bounce, reveal, on-demand premium) is simply a *maximal-priority
enqueue* into it, idempotent on `(entity, field, sla_period)` (`RESEARCH_06 §4.2`). One queue + one budget means
the system can never double-spend or blow the ceiling by having events and the sweep race in separate lanes —
the §3 H3 ceiling is enforced in exactly one place.

**(iii) "Per-tenant quota on the master sweep" is a category error.** The task names "cost ceilings + per-tenant
quotas" as a hard case; the naive answer (a per-tenant quota on re-verify) is *wrong for Clock A.* Master
re-verify is **system** cost, amortized across every workspace that benefits (verify-once-serve-N, the Layer-0
economy, `RESEARCH_06 §5`); it is governed by a **global** budget (`provider_configs.monthly_budget_cents`,
`intel.ts:125`), not a per-tenant one. Per-tenant quotas live on the **Clock-B** path — the workspace's
opt-in re-reveal and its on-demand-premium requests, both gated by the per-workspace credit pool `FOR UPDATE`
(`ADR-0007:15-17,40`; `ADR-0013`). Putting a per-tenant quota on the master sweep would both break the
amortization economics and be unenforceable (the sweep has no tenant). This distinction must be explicit in the
PLAN so the two budgets are not confused.

**The in-use predicate (the §5 keystone, sketched not settled).** C's cost story depends entirely on the
"in-use" gate that excludes the cold tail (the D-floor). Candidate predicates, cheapest-signal-first:
revealed-by-≥1-workspace (a `contact_reveals` row exists for the master person); on an active list or in a live
sequence; recently active (`last_activity_at`, `03 §5.2`); recently masked-searched. The recommendation is to
*start* with "revealed-by-≥1-workspace **OR** in an active list/sequence" (the strongest signal that a workspace
will be hurt by staleness) and tune from measured bounce/credit-back, but the exact predicate is an open
question for the PLAN.

---

## 6. DECISION

**Proceed with a single organizing mechanism: the decay-scored priority queue under a global budget (Option C)
as the spend-trigger spine — rejecting the TTL sweep (A) and lazy-only (D) as the spine, and adopting
event-driven CDC (B) as the orthogonal propagation substrate, not as a rival trigger.** Stated as one direction
for the PLAN:

> **"A budgeted decay-priority queue, fed by events, propagated by CDC, floored by lazy."** One
> `verification_jobs` priority queue ordered by `f(decay, recency-of-use, seniority, dq-drop, event-urgency)`,
> drained head-first under one global `provider_configs` budget behind the waterfall circuit breaker; an
> **in-use gate** makes cold never-revealed master records ineligible for proactive re-verify (they decay on
> paper and are verified **lazily at first reveal** — D's floor); **events** (job-change, bounce, reveal,
> on-demand) are *maximal-priority enqueues into the same queue*, never a parallel mechanism; a completed
> re-verify or job-change propagates via **CDC** with a hard partition — reproject/invalidate the projection +
> derived cache, **signal-only** the overlay (the workspace opts into a billable, `charge-only-for-valid`
> re-reveal; a pin outranks even that); a job change commits an **SCD2** transition only after corroboration,
> never auto-charging on a single uncorroborated source.

Why this and not the alternatives:

- **Reject A (TTL sweep) as the spine.** It contradicts `ADR-0025:52`, cannot complete at billions, meets its
  coverage promise more cheaply via C on the in-use population, and degenerates into a worse C the moment a
  budget is applied (§4). Its *one* salvageable part — the **free** clock-driven freshness-*score* recompute —
  is adopted; the **paid** clock-driven re-verify is not.
- **Reject D (lazy) as the spine.** Held data rots after reveal (`ADR-0025:51`: stale exports, rising
  bounce/credit-back), and proactive job-change detection becomes impossible (§2). D survives only as the
  **cold-tail floor** (the in-use gate) and the **lower-bound spend model** — exactly where C needs it.
- **Reject B (event-CDC) as the spine — adopt it as the propagation axis.** As a trigger it is blind to silent
  decay, has no budget ceiling, can swamp CDC with its own event firehose, and is the most exposed to false
  job-change (§2, §3 H6). But it is the *only* answer to propagation, so it is adopted there — hard-partitioned
  so it invalidates the projection/cache but only **signals** the overlay (H2), and so events feed C's priority
  rather than acting unbounded.
- **Adopt C as the spine.** It is the only option where freshness-vs-over-spend is a tunable dial, it is
  budget-bounded by construction, it degrades gracefully at 10× (less coverage at the same spend, never a blown
  ceiling), and it extends shipped infrastructure (`verification_jobs` is the ADR's own design; the budget
  breaker, the `provider_calls` cache, the bulk `enrichment_jobs` ledger, and the `intent_signals.job_change`
  enum all already exist — `intel.ts`, `enrichmentJobs.ts`, `waterfall.ts`).

This satisfies every carried constraint: **C1** master re-verify runs under the system/ER role and the overlay
signal lands RLS-scoped; **C2** owner/visibility stay overlay-side app-layer filters, untouched by master
propagation; **C3** master re-verify = global system budget, overlay re-reveal = per-workspace
`charge-only-for-valid` credit (the §5(iii) category-error avoided); **C4** suppressed records
(`master_persons.is_suppressed`, `03 §5.1`) are excluded from the queue and from re-reveal, and DSAR fan-out
(keyed on `email_blind_index`) reaches every overlay copy; **C5** the proactive paid work is a budget-capped
sliver of a free set-based scan, the propagation is async + bounded + idempotent, and the cold tail is never
swept — no N+1, no unbounded fan-out.

**Implementation status (gap → work-to-do, never license to skip a rule).** Shipped today and reused: the
Clock-B overlay fields (`contacts.last_verified_at`/`data_quality_score`/`freshness_status`, `03 §5.2`), the
`intent_signals.job_change`/`new_hire` enum (`intel.ts:80-81`), the waterfall trust÷cost + circuit breaker
(`waterfall.ts:50-60`), the `provider_calls` cache + `provider_configs.monthly_budget_cents` budget (`intel.ts`),
and the bulk `enrichment_jobs`/`chunks`/`rows` ledger a re-verify campaign rides (`enrichmentJobs.ts`).
Designed-but-unbuilt: the entire Layer-0 master graph incl. Clock-A channel freshness and the SCD2
`master_employment` edge (`03 §5.1`), `verification_jobs`, `data_quality_rules`, the decay model, and the
priority queue (`ADR-0025:28`; `22 §4`). Net-new Phase-6 invention the PLAN owns: the priority function +
in-use predicate, the SCD2 job-change transition + corroboration guardrails, and the hard-partitioned CDC
propagation (invalidate cache/projection, signal-only overlay). None of these gaps relaxes a constraint — when
built, master re-verify stays system-owned and un-attributed, overlay refresh stays an opt-in
`charge-only-for-valid` re-reveal that respects the pin, the edge stays SCD2 so history survives, the queue
stays budget-gated and suppression-aware, and the deterministic keys stay backed by DB uniques so concurrent
re-verifies cannot mint duplicates.

### Open questions handed to the PLAN (not decided here)

1. **The in-use predicate (the cost keystone).** Exact definition that gates proactive re-verify and excludes
   the cold tail: revealed-by-≥1-workspace, on an active list/sequence, `last_activity_at` recency, or a union?
   Recommended start: "revealed **OR** in active list/sequence," tuned from measured bounce/credit-back. (§5;
   `RESEARCH_06` OQ2.)
2. **The priority function weights.** The exact `f(decay, recency-of-use, seniority, dq-drop, event-urgency)`
   and the per-plan-tier re-verify budget split — and the per-segment coverage monitor that prevents a starved
   class (C's killer, §2). (`22` OQ2:252, OQ6.)
3. **Decay-curve shape.** Linear vs exponential vs logistic for the freshness sub-score between the fixed bands
   (`<0.5/<1.0/<1.5`, `22 §3:128`); tunable as data in `data_quality_rules`. (`RESEARCH_06` OQ1.)
4. **Corroboration threshold + candidate-edge state machine for job-change** (H6): how many independent sources
   / what `source_count` / which signals commit the SCD2 flip vs hold a candidate edge vs route to the
   `match_links` review band — and the explicit "never auto-charge on a single source" rule.
5. **Re-reveal pricing on a confirmed job change.** Full new reveal, discounted refresh, or free within a
   window? (Cognism re-charges, `RESEARCH_06 §4.4`; overlaps `ADR-0013` + the credit-back window.) Per-tenant
   quota lives here, not on the master sweep (§5(iii)).
6. **Signal-vs-auto-refresh policy per field.** Low-risk firmographic refreshes (a recount of employee band) may
   be safe to auto-apply to overlays; PII channels (email/phone) are signal-only — where is the line, and is it
   workspace-configurable? (`RESEARCH_06` OQ5.)
7. **Job-change detection sourcing + cadence** feeding the Layer-0 detector (provider feeds / LinkedIn-derived /
   email-signature / re-import diff; weekly like ZoomInfo Tracker?), and its DPA lineage. (`21`;
   `RESEARCH_06` OQ4.)
8. **CDC firehose backpressure.** The bound on master-change event volume so reprojection lag stays inside the
   read-your-write window and `current_company_id` never serves wrong-company (B's killer, §2; `RESEARCH_06 §4.3`).
