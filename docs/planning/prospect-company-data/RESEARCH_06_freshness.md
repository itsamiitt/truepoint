# RESEARCH 06 — Freshness, Re-enrichment & Lifecycle

> **Gate:** RESEARCH · **Phase:** 6 — Freshness, Re-enrichment & Lifecycle. How a prospect↔company
> record stays *correct and current* after it lands: staleness detection + decay scoring, the
> re-enrichment trigger model (TTL sweep vs event-driven vs decay-priority queue), **job-change**
> detection and how it updates the employment edge **without losing history**, propagation
> canonical → projection → cache → overlay **without breaking owner views**, and cost control on a
> *metered* re-enrichment subsystem at billions of rows. This doc **researches and documents only** —
> it writes no brainstorm, no plan, no code/schema. **Depends on:** the shared ground-truth brief,
> [RESEARCH_00](./RESEARCH_00_current_state.md) (the BUILT/PLANNED/UNDESIGNED baseline — the shipped
> `last_verified_at`/`data_quality_score`/`freshness_status` overlay fields, the `intent_signals`
> `job_change` enum, the unbuilt `verification_jobs`), [RESEARCH_02](./RESEARCH_02_linking_patterns.md)
> (the SCD2 employment edge + "a job change is a *signal*, never an overlay overwrite"),
> [RESEARCH_03](./RESEARCH_03_mdm_merge.md) (per-field provenance + `observed_at`/`last_verified` +
> survivorship cascade — the substrate a re-verify rewrites), [RESEARCH_04](./RESEARCH_04_tenancy_projection.md)
> (re-projection on change; the Cognism "re-charge only on job change" billing; two-stage
> authorize-at-read). **Ground truth:** [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md),
> [22](../22-data-quality-freshness-lifecycle.md), [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md),
> [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md),
> [ADR-0037](../decisions/ADR-0037-bulk-match-first-resolution-and-candidate-index.md)/[ADR-0039](../decisions/ADR-0039-bulk-enrichment-pipeline.md),
> [06 §9](../06-enrichment-engine.md), [03 §5.1/§5.2](../03-database-design.md), `packages/db/src/schema/intel.ts`,
> `enrichmentJobs.ts`, `core/src/enrichment/waterfall.ts`. External claims are tagged **[VERIFIED — url]**
> (a source states it) vs **[INFERRED]** (reasoned from public behaviour, not documented).

---

## 0. Scope & method

Phases 1–4 designed the *static* graph: the golden record (1), the employment edge (2), per-field
provenance (3), and the projection boundary (4). **Phase 6 designs the graph in motion** — the clock.
Every value the graph holds is decaying from the instant it is written, and the entire commercial
promise (`charge-only-for-valid` + credit-back, [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md):21-36;
a "freshness differentiator", [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):57)
erodes the moment freshness is treated as a one-time property instead of a managed lifecycle.

The five questions this gate answers by studying who already solved them:

1. **Staleness detection + decay scoring** — how do we *measure* age and degrade a value gracefully (not
   at a cliff), per field, against a per-field SLA, on **two clocks** (the system-owned master channel and
   the per-workspace overlay snapshot)?
2. **Re-enrichment trigger** — TTL sweep vs event-driven vs decay-priority queue: which fires the
   re-verify, and how do they compose at billions of rows under a budget?
3. **Job-change detection** — how is "this person moved company" detected, and how does it update the
   `master_employment` edge **without destroying the prior affiliation**?
4. **Propagation** — when a golden value refreshes, how does the change reach the OpenSearch/ClickHouse
   projection and the per-workspace overlay copies **without silently overwriting an owner's curated view**?
5. **Cost control** — re-enrichment is *metered* spend; what keeps it from being unbounded across a
   billions-row universe with continuous decay?

**Epistemic legend.** Vendor *internal* refresh mechanics are rarely fully published; observable surface
behaviour (a stated cadence, an alert type, a cap) is. Cadence numbers a vendor *states* are **[VERIFIED]**;
claims about *how* they store/diff state are **[INFERRED]** unless documented. Internal claims cite
`file:line` (code/schema) or ADR/doc section.

---

## 1. The freshness problem, stated precisely — two clocks, not one

```
   LAYER 0  (system-owned, the universe)            LAYER 1  (per-workspace overlay, a frozen copy)
   ─────────────────────────────────────            ──────────────────────────────────────────────
   master_emails.last_verified_at  ◀── CLOCK A       contacts.last_verified_at      ◀── CLOCK B
   master_phones.last_verified_at      (the system   contacts.freshness_status          (the workspace's
   master_employment.is_current        re-verifies   contacts.data_quality_score         SNAPSHOT age,
   master_persons.data_quality_score   the corpus)   account snapshot of firmographics    frozen at reveal)
        │                                                   ▲
        │   reveal copies a POINT-IN-TIME value ───────────┘   (RESEARCH_04 §4.2; ADR-0021:48-51)
        │   a later master change does NOT auto-rewrite the overlay (owner-view stability, §4.4)
        ▼
   re-verify cadence runs ONCE for the universe           re-verify of the snapshot is a per-workspace
   (TruePoint's own provider cost, billions of rows)      RE-REVEAL — a billable event (Cognism, RESEARCH_04 §2.3)
```

The single most important framing this gate contributes: **TruePoint has two freshness clocks, and they
are governed differently.** Clock A is the *master channel* `last_verified_at` ([03 §5.1](../03-database-design.md):447,457)
— the system re-verifies the golden universe once, on TruePoint's own provider spend, and the result is
shared by every workspace. Clock B is the *overlay snapshot* `last_verified_at`/`freshness_status`
([03 §5.2](../03-database-design.md):544-546) — a point-in-time copy a workspace took at reveal, which
**stays frozen** so an owner's curated view is stable (the Cognism "kept for the contract" model,
[RESEARCH_04 §2.3](./RESEARCH_04_tenancy_projection.md)). Conflating the two is the headline design error:
re-verifying the master is *cost optimization on a shared asset*; refreshing an overlay snapshot is a
*re-projection that may re-charge a credit*. Every later section keeps them distinct.

**Implementation status.** Clock-B fields are shipped on `contacts` (`last_verified_at`,
`data_quality_score`, `freshness_status`, [03 §5.2](../03-database-design.md):544-546; confirmed in code,
[RESEARCH_00 §2.2](./RESEARCH_00_current_state.md)). Clock-A fields are *designed* on `master_emails`/
`master_phones` ([03 §5.1](../03-database-design.md):444-458) but unbuilt (Layer 0 is 100% docs,
[RESEARCH_00 §0](./RESEARCH_00_current_state.md)). `verification_jobs`, the decay model, and the priority
queue are **planned, unbuilt** ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):28;
[22 §4](../22-data-quality-freshness-lifecycle.md):132-140). The gap is work-to-do, never license to skip a rule.

---

## 2. How fast B2B data actually decays (the numbers that calibrate the SLAs)

The freshness SLAs ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):25-27)
were set *a priori* and the ADR explicitly says to "re-tune cadences from measured decay" (`:62-65`). The
external evidence both **validates the order of magnitude** and shows the SLAs are, if anything, slightly
conservative on email.

| Decay signal | Verified figure | Source |
|---|---|---|
| Overall B2B record decay | **~2.1%/month → ~22.5%/year**, ranging to **70.3%/yr** depending on how many fields you track | [VERIFIED — apollo.io insights (citing Only-B2B/Landbase)](https://www.apollo.io/insights/whats-the-average-rate-of-data-decay-in-a-b2b-contact-database-and-how-do-i-address-it); [cleanlist.ai](https://www.cleanlist.ai/blog/2026-01-22-b2b-data-decay-statistics); [landbase.com](https://www.landbase.com/blog/data-decay-b2b-crm-loses-accuracy) |
| Job-change rate | **~30% of professionals change jobs annually** (some sources 15–25%); avg tenure ~2.8–4.1 yrs | [VERIFIED — apollo.io](https://www.apollo.io/insights/whats-the-average-rate-of-data-decay-in-a-b2b-contact-database-and-how-do-i-address-it); [cleanlist.ai](https://www.cleanlist.ai/blog/2026-01-22-b2b-data-decay-statistics) |
| Email decay | **~3.6%/month**; **20%+ invalid after 6 mo**; **30–40% invalid after 12 mo** | [VERIFIED — cleanlist.ai](https://www.cleanlist.ai/blog/2026-01-22-b2b-data-decay-statistics) |
| Email goes dead post-departure | business inbox typically deactivated **30–90 days** after a person leaves | [VERIFIED — landbase.com](https://www.landbase.com/blog/why-b2b-data-goes-stale) |
| Records stale within 12 mo | **30%** of B2B contact records go stale/year; ~546 hrs/yr lost to it | [VERIFIED — SignalHire via techrseries.com](https://techrseries.com/hiring/signalhire-data-reveals-30-of-b2b-contact-records-go-stale-every-year-database-decay-costs-about-546-hours-annually/) |
| Company-level change | **5–15% of companies/year** undergo M&A, rebrand, closure | [VERIFIED — landbase.com](https://www.landbase.com/blog/why-b2b-data-goes-stale) |

**What this means for the SLAs.** A single job change "invalidates most fields in a contact record"
[VERIFIED — cleanlist] — email, title, phone, and company all flip at once — which is exactly why
[ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md) puts **employment/title at
the shortest SLA (60 days)**: catching the move catches the cascade. Email at 90 days is well inside the
"30–40% invalid after 12 months" curve but slightly *behind* the 3.6%/month signal — at 90 days a
verified-on-day-0 email is ~10% likely already invalid; the decay model (§4.1) handles that gracefully by
degrading the freshness sub-score continuously rather than waiting for the SLA boundary. The seniority lever
([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):27, "senior/high-value
records re-verify on the shorter end first") is validated by Cognism shipping a **seniority-tiered** cadence
(§3.1) — director-and-above churn is the most valuable to catch early.

---

## 3. How leading platforms keep data fresh + detect job changes

### 3.1 Re-verification cadence — continuous monitoring + seniority-tiered re-verify

| Vendor | Stated cadence / mechanism | Source |
|---|---|---|
| **ZoomInfo** | ~**90-day** general refresh, but **continuous** monitoring of "new signals that indicate changes"; each contact checked **up to 75 times** (syntax, MX, live SMTP, ML on historical sends); **300+ researchers** updating **~4M individuals/day** | [VERIFIED — webscraping.ai](https://webscraping.ai/faq/zoominfo-scraping/how-often-does-zoominfo-update-their-data-and-how-does-that-affect-scraping); [prospeo.io](https://prospeo.io/s/zoominfo-email-verification); [pipeline.zoominfo.com](https://pipeline.zoominfo.com/sales/how-does-zoominfo-get-data) |
| **Cognism Diamond Data** | **Seniority-tiered**: "95% of director-level and above contacts refreshed **every 30 days**"; **phone-verified** = a human "calls the numbers and confirms it is the right person"; **Diamonds-on-Demand** runs a flagged record through verification with a **48-hour** turnaround | [VERIFIED — cognism.com/diamond-data](https://www.cognism.com/diamond-data); [help.cognism.com](https://help.cognism.com/hc/en-gb/articles/11964159607698-Diamond-Data-and-Diamonds-on-Demand) |
| **Apollo** | Tiered cadence: **pre-campaign** email validation, **real-time** on inbound, **monthly** re-verify active prospects, **quarterly** full audit (dedup/suppress/re-enrich), **annual** governance; **90 days** = "a common threshold" for max age before re-verify | [VERIFIED — apollo.io insights](https://www.apollo.io/insights/whats-the-average-rate-of-data-decay-in-a-b2b-contact-database-and-how-do-i-address-it) |
| **People Data Labs** | Per-person **`job_last_changed`** + **`job_last_verified`** timestamps; per-experience **`first_seen`/`last_seen`/`num_sources`** freshness window | [VERIFIED — docs.peopledatalabs.com/docs/fields](https://docs.peopledatalabs.com/docs/fields) (via [RESEARCH_02 §1.1](./RESEARCH_02_linking_patterns.md)) |

**The convergent pattern:** *continuous* monitoring for change-signals + a *baseline* re-verify cadence that
is **tiered by value/seniority**, plus an *on-demand* premium verification for flagged high-value records.
TruePoint's [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md) already
encodes all three: per-field SLAs (the baseline), priority by recency-of-use + decay (the tiering), and
`verification_jobs` (the executor). Cognism's **Diamonds-on-Demand** is the strongest external validation of a
specific TruePoint lever — *the customer flags the records worth premium freshness, and only those re-verify
eagerly* — which is the cost-control keystone in §5. [INFERRED] that ZoomInfo/Cognism re-verify **once
centrally** for all customers (their single deduped corpus implies it); TruePoint's Layer-0 makes that explicit
and is the structural reason re-verify is a system cost amortized across all workspaces, not a per-tenant one.

### 3.2 Job-change detection — diff structured state, fire a signal, link old→new

| Vendor / tool | Detection mechanism | Source |
|---|---|---|
| **ZoomInfo Tracker** | **Weekly** review of tracked contacts; emits **3 signal types** — *employer change*, *title change* (same company), *department move*; capped **5,000 contacts/user** | [VERIFIED — help.zoominfo.com; pipeline.zoominfo.com](https://pipeline.zoominfo.com/sales/job-change-alerts) (via [RESEARCH_02 §1.2](./RESEARCH_02_linking_patterns.md)) |
| **LinkedIn Sales Navigator** | **3 alert types** on *saved* entities — "Lead Changed Jobs", "Lead Changed Roles" (same company), "Talent Moving to Another Account" | [VERIFIED — linkedin.com/help/sales-navigator](https://www.linkedin.com/help/sales-navigator/answer/a105133) (via [RESEARCH_02 §1.7](./RESEARCH_02_linking_patterns.md)) |
| **UserGems / Champify / SifData** | Monitor the **customer's CRM** against LinkedIn profile changes + company DBs; detect **within days–weeks**; **create a new linked record at the new company** (carrying old usage/NPS), trigger a workflow | [VERIFIED — usergems.com/product/contact-tracking](https://www.usergems.com/product/contact-tracking); [leadiq.com](https://leadiq.com/blog/top-5-sales-solutions-for-tracking-contacts-and-job-changes) |
| **Apollo** | Job change = a **re-enrichment trigger**: "searches for new emails, job titles, company names to verify if a contact changed roles"; waterfall falls through on miss; can **update OR create** a record | [VERIFIED — knowledge.apollo.io](https://knowledge.apollo.io/hc/en-us/articles/5130064363661-Use-Job-Change-Alerts-to-Enrich-Contacts) (via [RESEARCH_02 §1.3](./RESEARCH_02_linking_patterns.md)) |
| **Detection inputs (industry)** | email-signature domain change, company website/team-page scraping, public records (SEC, press), social/LinkedIn monitoring | [VERIFIED — salesmotion.io](https://salesmotion.io/blog/job-change-signals-pipeline); [syncgtm.com](https://syncgtm.com/blog/job-change-signals-warm-outbound-2026) |

**Two structural lessons.** (1) That ZoomInfo/Sales-Nav can name *three* signal types means they **diff
structured (company, title, dept) state across time** — only possible if the prior tuple is retained, i.e. an
SCD2-style history, not a mutated row [INFERRED, RESEARCH_02 §1.2]. This validates the planned `master_employment`
SCD2 grain ([03 §5.1](../03-database-design.md):428-436). (2) UserGems/Champify monitor **each customer's CRM
separately** — N customers × their contacts. **TruePoint's Layer-0 inverts this:** the universe is monitored
**once**, and a detected move fans a *signal* out to every workspace that revealed that person. That is a
structural scale and cost advantage the per-CRM vendors cannot match, and it is the basis of §4.3–§4.4.

### 3.3 Cost control on metered re-enrichment

- **Waterfall sequencing.** "Maximize valid outputs per credit spent… sequence providers by expected match
  rate and cost, high-probability low-cost steps first, expensive providers only when earlier steps fail"
  [VERIFIED — [pipeline.zoominfo.com/operations/waterfall-enrichment](https://pipeline.zoominfo.com/operations/waterfall-enrichment); [lusha.com](https://www.lusha.com/blog/blog-waterfall-enrichment-workflow/)].
  TruePoint already ships this: `waterfall.ts` orders providers by **trust ÷ cost** and stops on first hit,
  with a per-provider circuit breaker ([RESEARCH_00 §4.1d](./RESEARCH_00_current_state.md): `waterfall.ts:50-60,8-43`).
- **Pay-for-results.** "You only pay when verified results are found. No valid data? No credits charged"
  [VERIFIED — leaddelta.com via search]. This is exactly [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md)'s
  charge-only-for-`valid` + credit-back-on-bounce — and it applies to a re-reveal after a job change the same
  way it applies to a first reveal.
- **Event-driven re-enrichment.** "Clay monitors live triggers — job changes, promotions, funding rounds — to
  time outreach" [VERIFIED — [clay.com data-waterfalls](https://www.clay.com/blog/data-waterfalls)]; the move
  *is* the trigger that justifies the spend, instead of a blind clock.
- **On-demand premium.** Cognism Diamonds-on-Demand (§3.1) — the customer flags the few records worth premium
  verification; the expensive path runs **only on those**.

**The cost pattern:** cheapest-first waterfall + pay-for-results + spend triggered by a *signal* (not a blind
clock) + an *on-demand* premium tier for flagged records. TruePoint has every one of these primitives already
in code or in an accepted ADR; Phase 6's job is to *compose* them into a budgeted lifecycle, not invent them.

---

## 4. The four lifecycle mechanisms, decomposed against TruePoint

### 4.1 Staleness detection + decay scoring (the measurement layer)

TruePoint's measurement is already specified and partly shipped — Phase 6 only resolves the *two-clock* nuance
and the decay-curve shape.

- **The score.** `data_quality_score = round(100 × (0.4·completeness + 0.3·verification + 0.3·freshness))`,
  each sub-score ∈ [0,1] ([22 §2](../22-data-quality-freshness-lifecycle.md):19;
  [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):21-24). The
  **freshness** sub-score is what decays; it is computed from `age / SLA` per field.
- **`freshness_status` bands.** `fresh` (`age/SLA < 0.5`) → `aging` (`<1.0`) → `stale` (`<1.5`) → `expired`
  (else) ([22 §3](../22-data-quality-freshness-lifecycle.md):128-130). The **decay model lowers the freshness
  sub-score *continuously*** so quality "degrades gracefully rather than at a cliff" (`:129-130`) — this is the
  graceful-degradation the §2 email curve (3.6%/month) demands; a step function would mark a 89-day email
  `fresh` and an 91-day one `stale`, which is dishonest.
- **Per-field SLA (the clock periods):**

  | Field | SLA | Why (external) |
  |---|---|---|
  | Employment / title | **60 d** | a move invalidates the cascade; ~30%/yr churn (§2) |
  | Email | **90 d** | ~3.6%/mo decay; ZoomInfo/Apollo "90-day common threshold" (§3.1) |
  | Mobile / direct phone | **180 d** | costlier to verify; decays slower than email |
  | Company firmographics | **180 d** | 5–15%/yr company-level change (§2) |
  | Intent signals | **rolling 30-d window** | a signal is only meaningful while recent |

  (source: [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):25-27;
  [22 §3](../22-data-quality-freshness-lifecycle.md):120-126).
- **The two clocks measured separately.** Clock A reads `master_emails.last_verified_at` etc. and scores the
  *golden* record; Clock B reads `contacts.last_verified_at` and scores the *overlay snapshot*. A workspace's
  contact can be `stale` (its snapshot is 200 days old) while the master is `fresh` (re-verified last week) —
  precisely the gap that a re-reveal closes (§4.4). The overlay badge a user sees ([22 §8](../22-data-quality-freshness-lifecycle.md):184)
  must read **Clock B** (the age of *what they hold*), with a "newer data available" affordance when Clock A is fresher.
- **Cold start (already resolved).** An unverified import starts `freshness_status = aging` (never `fresh`)
  without an as-of date; `last_verified_at` stays null until a real verification run sets it
  ([22 §2.2](../22-data-quality-freshness-lifecycle.md):69-74). Phase 6 inherits this unchanged.
- **Set-based recompute, never row-by-row.** The freshness sweep recomputes the freshness sub-score set-wide as
  records cross SLA bands, in a single `UPDATE … FROM` (or an AWS Batch job over the lake at billions), the same
  async path as scheduled re-verify ([22 §2.4](../22-data-quality-freshness-lifecycle.md):104-117). At billions
  of rows a per-row freshness recompute is an N+1/fan-out failure (the scale gate) — it must be set-based.

**The decay-vs-verification distinction (load-bearing).** A *freshness sweep* lowers the score from age alone
**without spending a provider credit** — it is pure arithmetic over `now − last_verified_at`. A *re-verification*
actually re-checks the field (SMTP probe, phone validation) and **does** spend. Keeping these separate is the
first cost lever: the universe's freshness scores stay current continuously (free); actual re-verify is rationed
(§5).

### 4.2 Re-enrichment triggers — TTL sweep vs event-driven vs decay-priority queue

Three trigger models, evaluated against TruePoint's constraints:

| Trigger model | What fires the re-verify | Pro | Con | Verdict |
|---|---|---|---|---|
| **TTL / fixed-clock sweep** | every record older than its SLA, on a cron | simple; complete coverage | re-verifies cold records nobody uses → unbounded spend at billions ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md) rejects "re-verify everything on a fixed clock" as "wasteful; cost-unbounded", `:52`) | **Reject as the sole driver** |
| **Event-driven** | an external signal (job-change detection, a reveal, a campaign send, a bounce webhook) | spends exactly when a change is likely / value is imminent (Clay model, §3.3); highest ROI per credit | incomplete — a quietly-stale record with no event never refreshes | **Adopt as the high-value fast path** |
| **Decay-priority queue** | `verification_jobs` ordered by `last_verified_at` + SLA + **priority** (recently-revealed, high-`data_quality_score`-decay, senior) | spends on what is both *stale* and *in use*; budget-bounded by construction | needs a priority function + a budget gate | **Adopt as the baseline** ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):28-30; [22 §4](../22-data-quality-freshness-lifecycle.md):132-140) |

**Recommended composition: a hybrid that all funnels into one `verification_jobs` queue.**

```
  EVENT SOURCES (push)                    DECAY SWEEP (pull)
  ─ job-change signal (§4.3)              ─ nightly set-based scan: records where
  ─ reveal / re-reveal                       age/SLA crosses a band AND in-use
  ─ campaign send (pre-send freshness)    ─ emits enqueue intents, priority-scored
  ─ bounce webhook (SES SNS→SQS)                     │
  ─ Diamonds-on-Demand "verify this"                 │
        └────────────────┬─────────────────────────┘
                         ▼
            verification_jobs  (ONE priority queue, BullMQ on Redis)
            priority = f(decay, recency-of-use, seniority, event-urgency)
            budget gate: provider_configs.monthly_budget + circuit breaker (waterfall.ts)
                         ▼
            AWS Batch / workers → waterfall (trust÷cost) → independent verifier
                         ▼
            charge-only-for-valid (ADR-0013) on the re-reveal; master re-verify is TruePoint's own cost
```

Events *jump the queue* (high urgency); the decay sweep *fills it* with the stale-and-in-use baseline; the
budget gate ([06 §5/§6](../06-enrichment-engine.md); `provider_configs.monthly_budget_cents`, `intel.ts:120-127`)
is the hard ceiling. This is exactly the ADR-0025 design — Phase 6's contribution is making explicit that
**events and the sweep share one queue and one budget**, so the system never double-spends and never blows the
ceiling. Idempotency: each enqueue is keyed so a record already queued for re-verify is not enqueued twice
(content-hash / `(entity, field, sla_period)`), the same idempotency discipline as `source_records.content_hash`
([03 §5.1](../03-database-design.md):464) and the enrichment-job idempotency key (`enrichmentJobs.ts:60,70`).

### 4.3 Job-change detection + updating the edge without losing history

A job change enters as **new evidence**, not a mutation. The detection is an ER input; the edge update is an
SCD2 transition; the history is preserved by construction.

```
  detect (new source_record: person now @ company B)        ── §3.2 inputs: signature/scrape/social/provider
        │  idempotent on source_records.content_hash (03:464)
        ▼
  ER incremental match (06 §9:317) resolves to the SAME master_persons identity (linkedin_public_id / email-BI)
        │
        ▼  in ONE transaction (the SCD2 close-old/open-new — RESEARCH_02 §2.2):
   (a) close prior edge:  UPDATE master_employment SET is_current=false, ended_on=<inferred> WHERE current @ A
   (b) open new edge:     INSERT (person, company B, title, started_on, is_current=true)
                          UNIQUE(person, company, started_on) makes re-detect idempotent (03:434)
   (c) recompute cache:   master_persons.current_company_id := company B   (derived, NEVER hand-set; PDL discipline)
   (d) emit signal:       one job_change event  →  propagation (§4.4)
        │
        ▼  the OLD edge is RETAINED (is_current=false) → full history; "title change SAME company" still expressible
```

Key points, each grounded:

- **History is never lost** because the edge is SCD2: a change *closes* the old row and *opens* a new one, it
  never overwrites ([RESEARCH_02 §2.2](./RESEARCH_02_linking_patterns.md); `master_employment` grain
  [03 §5.1](../03-database-design.md):428-436). The degenerate `contacts.account_id` overwrite TruePoint ships
  today (limit #1, [RESEARCH_00 §3](./RESEARCH_00_current_state.md)) is exactly what this replaces.
- **`current_company_id` is a derived cache, recomputed transactionally**, never independently writable — else
  the person and the edge disagree after a move (the PDL `is_primary`→`job_*` discipline,
  [RESEARCH_02 §2.5/§4](./RESEARCH_02_linking_patterns.md); `idx_master_persons_company`,
  [03 §5.1](../03-database-design.md):426). If step (c) lags (a)/(b), flattened search docs serve a person at the
  *wrong* company — "the single most expensive correctness bug here" ([RESEARCH_02 §4](./RESEARCH_02_linking_patterns.md)).
- **The old email goes `risky`/`invalid`, the new is `unverified`** until re-verify — matching the §2 "inbox
  deactivated 30–90 days after departure" reality. The job-change event therefore *also* enqueues a re-verify of
  the new channel (event-driven trigger, §4.2).
- **Detection runs once at Layer 0** and the move is one ER event for the universe — not N per-workspace scans
  (the UserGems inversion, §3.2). [INFERRED] this is materially cheaper than the per-CRM vendors at TruePoint's scale.
- **The signal surface partially exists in code.** `intent_signals` already ships `signal_type ∈ {…'job_change',
  'new_hire',…}` (`intel.ts:80-81`) — the workspace-facing job-change signal is a *known* enum value today, even
  though Layer-0 detection that would populate it is unbuilt. Phase 6 connects the (unbuilt) detector to the
  (shipped) signal enum.
- **Ambiguity routes to review, never auto-binds.** A fuzzy `name_normalized`/ambiguous-domain re-affiliation
  enters the `match_links` review band (`review_status = pending`, [03 §5.1](../03-database-design.md):481-482),
  preserving the ≤0.5% false-merge target under churn ([22 §5/§6](../22-data-quality-freshness-lifecycle.md):152-171).

### 4.4 Propagation: canonical → projection → cache → overlay (without breaking owner views)

A golden refresh (a re-verify or a job change) must reach three downstream surfaces, each with a *different*
propagation rule. This is where owner-view stability is won or lost.

```
  master_* updated (re-verify OR job change)
        │  write to Postgres golden FIRST (source of truth), then propagate (ADR-0035 outbox/CDC)
        ├──────────────► (1) OpenSearch masked index   — REPROJECT eagerly (search must be fresh)
        │                     ClickHouse facet counts   — recount (employee band, has_email…)
        │                     [eventual consistency OK for browse; re-checked at read — RESEARCH_04 §5]
        │
        ├──────────────► (2) master_persons.current_company_id, has_email/has_phone — derived cache, recompute in-tx
        │
        └──────────────► (3) per-workspace OVERLAY snapshots that revealed this person
                              ── DO NOT overwrite the owner's curated value (survivorship; ADR-0015)
                              ── instead write a job_change/refresh INTENT_SIGNAL into each affected
                                 overlay (RLS-scoped, owner-visible) + flip the Clock-B badge to
                                 "newer data available" → the workspace chooses to RE-REVEAL (billable)
```

The three rules:

1. **Projection (search/facets): eagerly reproject.** Postgres is truth; the index is a derived query surface
   ([ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md); shared-ground-truth SEARCH note).
   Write golden first, then outbox/CDC to OpenSearch + ClickHouse. Eventual consistency is fine for browse
   because permissions and the *openable* value are **re-checked at read against Postgres** (the two-stage
   authorize-at-read, [RESEARCH_04 §5](./RESEARCH_04_tenancy_projection.md)). A stale index serving a just-moved
   person as still-at-old-company is a UX bug, not a security one — and the reproject closes it within the CDC lag.
2. **Cache (denormalized firmographics): recompute in-transaction.** `current_company_id`, `has_email`,
   `has_phone`, the flattened person+company search doc — all derived, recomputed atomically with the edge change
   (§4.3 step c). Never independently writable.
3. **Overlay snapshots: signal, never silently overwrite.** This is the owner-view-stability rule. A workspace
   revealed a point-in-time value; survivorship forbids enrichment silently superseding a user-held/owned value
   ([ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md) — "user-entered values are not silently
   overwritten"; [RESEARCH_03 §B.2](./RESEARCH_03_mdm_merge.md) the pin). So a master change writes a
   **job-change intent_signal** into each affected overlay (RLS-scoped, owner-visible) and flips the Clock-B
   freshness badge — the workspace **decides** to re-reveal (a new `contact_reveals` row, billable per
   [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md)/Cognism §2.3) or to keep its snapshot.
   This is the Cognism "re-charge only on job change" model ([RESEARCH_04 §2.3](./RESEARCH_04_tenancy_projection.md)).

**The overlay-pin exception.** If the overlay value is *human-pinned* (a user hand-edited the title), even a
re-reveal must not clobber it without consent — the pin outranks the provider guess
([RESEARCH_03 §B.2](./RESEARCH_03_mdm_merge.md), `is_pinned` overlay descriptor). The signal still surfaces
("the master now disagrees with your pinned value"), but the merge respects the pin. This keeps the U3
reconciliation (Phase 3) honored under propagation.

**Fan-out is bounded.** A celebrity move (a person revealed by 100k workspaces) must not be a synchronous
100k-row overlay write on the detection thread — it is an async, idempotent, queued fan-out
(`signal.contact.job_change` jobs, BullMQ, content-hash-idempotent), the same discipline as the DSAR fan-out
([ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md):129-130). Unbounded synchronous fan-out is a
failure (the scale gate).

---

## 5. Cost control on metered re-enrichment (the scale lever)

Re-verifying a billions-row universe on every SLA boundary is financially impossible; cost control is therefore
a *first-class part of the feature*, not an afterthought (the shared-ground-truth scale gate: metered subsystems
need per-tenant quotas + caching as part of the design).

| Lever | Mechanism | Grounding |
|---|---|---|
| **Re-verify only what's in use** | the decay sweep enqueues only records that are *both* stale *and* referenced by ≥1 overlay (revealed) or recently active; never-revealed cold master records **decay on paper but are not re-verified** until a reveal pulls them (lazy verification) | [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):28-30 (priority = recently-revealed first); the largest single cost cut [INFERRED] |
| **Decay-priority ordering** | spend the budget on highest-decay × highest-value (senior, recently-revealed) first; the rest waits | [22 §4](../22-data-quality-freshness-lifecycle.md):132-140; Cognism seniority tiers (§3.1) |
| **On-demand premium** | a workspace flags its few must-be-fresh records → eager verify, the rest ride the baseline cadence | Cognism Diamonds-on-Demand (§3.1) |
| **Waterfall trust÷cost + circuit breaker** | cheapest-likely provider first, stop on hit, breaker on a failing provider | `waterfall.ts:50-60,8-43` ([RESEARCH_00 §4.1d](./RESEARCH_00_current_state.md)) |
| **Cache-first** | a re-verify checks `provider_calls` (request-hash cache) before paying | `intel.ts:88-114`; cache-hit on the economics dashboard ([06 §10](../06-enrichment-engine.md):336) |
| **Hard budget breaker** | `provider_configs.monthly_budget_cents` + per-month cap; breach pages Ops | `intel.ts:120-127`; [22 §5](../22-data-quality-freshness-lifecycle.md):155 |
| **Free freshness sweep ≠ paid re-verify** | the score decays from arithmetic (free); only an actual re-check spends (§4.1) | [22 §2.4](../22-data-quality-freshness-lifecycle.md):104-117 |
| **Charge-only-for-valid on re-reveal** | the customer pays for a re-reveal only if it returns `valid`; bounce → credit-back | [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md):21-36 |
| **Reuse the bulk job ledger** | a re-verify campaign is a bulk job — `enrichment_jobs`/`chunks`/`rows` already model chunked fan-out, cost-per-row, idempotency | `enrichmentJobs.ts`; [ADR-0039](../decisions/ADR-0039-bulk-enrichment-pipeline.md) |

**Who pays for which clock.** Re-verifying the **master** channel (Clock A) is *TruePoint's own provider cost*,
amortized across every workspace that benefits — this is the Layer-0 economy of scale (verify once, serve N).
Re-revealing an **overlay** snapshot (Clock B) after a job change is *the workspace's* credit, gated by
charge-only-for-valid. Conflating them (e.g. charging a workspace for a system re-verify it didn't ask for, or
eating provider cost for every workspace's snapshot refresh) breaks the unit economics
([06 §10](../06-enrichment-engine.md): "cost per reveal" is the core metric).

---

## 6. Tradeoffs against the TruePoint cross-cutting constraints

| Constraint | Lifecycle decision | Risk if done wrong | Mitigation |
|---|---|---|---|
| **Multi-tenant RLS; Layer 0 system-owned** | re-verify runs on Layer 0 (no workspace scope); the job-change *signal* lands in each overlay RLS-scoped | a re-verify that reads/writes overlays cross-tenant leaks isolation | master re-verify under the ER/system role only; fan-out signals are per-workspace RLS writes ([RESEARCH_04 §3.2](./RESEARCH_04_tenancy_projection.md)) |
| **Per-owner visibility** | the job-change signal respects owner/team/list visibility at read; the badge is owner-scoped | a global refresh surfacing a record outside its owner scope | signals are app-layer-filtered like any overlay read ([ADR-0022](../decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)) |
| **Owner-view stability (survivorship)** | master change → **signal, never silent overwrite**; pin outranks | enrichment clobbers a user's curated/pinned value | re-reveal is opt-in + billable; pin respected (§4.4; [RESEARCH_03 §B.2](./RESEARCH_03_mdm_merge.md)) |
| **Canonical identity / edge history** | job change = SCD2 close-old/open-new + recompute cache, idempotent on content_hash | losing prior affiliation; current-company cache stale | SCD2 grain + `UNIQUE(person,company,started_on)` + in-tx cache recompute (§4.3) |
| **Field-level provenance** | a re-verify writes a new `source_record` + bumps `last_verified_at`/`source_count`; survivorship recomputes the winning descriptor | a blind overwrite destroys provenance / can't re-evaluate | append to the immutable log, recompute the `field_provenance` map ([RESEARCH_03 §C](./RESEARCH_03_mdm_merge.md)) |
| **Scale: billions × continuous decay** | free set-based freshness sweep; paid re-verify rationed to in-use + budgeted; async bounded fan-out | unbounded re-verify spend; N+1 freshness recompute; sync celebrity-move fan-out | §5 levers; set-based `UPDATE…FROM` ([22 §2.4](../22-data-quality-freshness-lifecycle.md)); queued idempotent fan-out |

**What breaks first at 10×** (the scale-gate answer): the **paid re-verify budget**, if the decay sweep is a
blind TTL clock over the whole universe instead of in-use-and-prioritized — billions of cold records re-verified
on a 60–180-day cadence is unbounded provider spend. The fix is the §5 keystone: re-verify only what a workspace
holds or is likely to reveal; let cold master records decay on paper and verify lazily at next reveal. Second to
break: the **current-company cache** going stale under job-change write volume (§4.3 step c lag) → search serves
people at the wrong company. Third: **synchronous overlay fan-out** on a high-reveal-count person (§4.4).

---

## 7. Pre-build thinking pass — the load-bearing answers for Phase 6

1. **Source of truth.** The `master_*` golden record (Clock A) is truth for *current* reality; the immutable
   `source_records` log is truth for *lineage*; the overlay snapshot (Clock B) is a deliberately-frozen copy, not
   truth. The search index is a derived projection ([ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
2. **Failure modes / idempotency.** Every trigger is idempotent: job-change on `source_records.content_hash`
   ([03](../03-database-design.md):464) + `UNIQUE(person,company,started_on)` (`:434`); re-verify enqueue on
   `(entity, field, sla_period)`; re-reveal on `(workspace_id, contact_id, reveal_type)` (`:560`); fan-out jobs
   content-hash-keyed. A re-run converges, never double-charges, never double-opens an edge.
3. **Duplicate prevention.** Master channel uniques (`master_emails.email_blind_index`,
   `master_phones.phone_blind_index`, [03](../03-database-design.md):442,455) stop concurrent re-verifies minting
   a duplicate channel; the edge unique stops a re-detect duplicating the new affiliation.
4. **Audit + change history.** A re-verify/job-change is captured as a new `source_record` + a survivorship
   recompute (the winning-descriptor delta is what `audit_log` records, [RESEARCH_03 §C.3](./RESEARCH_03_mdm_merge.md));
   the SCD2 closed edge *is* the history; credit-back/charge audited via `credit.adjust`
   ([ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md):38).
5. **Security (IDOR/exposure/abuse).** Master re-verify runs under the system/ER role, never `leadwolf_app`; the
   job-change signal is RLS-scoped per workspace and carries **no cross-workspace attribution** (co-op privacy,
   [RESEARCH_03 §C.2](./RESEARCH_03_mdm_merge.md)); a suppressed person (`is_suppressed`,
   [03](../03-database-design.md):421) is excluded from re-verify and reveal. Re-verify must not be a free
   membership-probe oracle (§3.4 RESEARCH_04 facet-leak) — it produces no customer-visible output without a reveal.
6. **Scalability / 10×.** Free set-based freshness sweep; paid re-verify rationed to in-use + budget-gated; async
   bounded fan-out; no N+1 (§6).
7. **Observability.** Coverage/decay/throughput on Data Health + the economics dashboard (verification pass-rate,
   cost per reveal, cache-hit, daily spend vs budget, [06 §10](../06-enrichment-engine.md):330-339;
   [22 §8](../22-data-quality-freshness-lifecycle.md)); `verification.completed` events ([22 §4](../22-data-quality-freshness-lifecycle.md):137);
   a breached coverage/budget threshold pages Ops ([22 §5](../22-data-quality-freshness-lifecycle.md):155).
8. **Rollback.** Everything is additive + reversible: the freshness sweep is recompute-from-`last_verified_at`;
   a wrong re-verify is corrected by the next source_record + survivorship replay; an erroneous edge transition is
   reversible by re-running ER over the cluster's evidence ([RESEARCH_03 §B.5](./RESEARCH_03_mdm_merge.md));
   shipped behind a flag.
9. **Edge cases.** Never-verified record (cold start → `aging`, lazy verify at reveal); person with no current
   edge (between jobs → `current_company_id` null, no fake company); concurrent re-verify of the same channel
   (idempotent on blind-index unique); a job change *back* to a prior company (re-opens via the `started_on`
   unique, history intact); a bounced credit-back racing a re-reveal (`FOR UPDATE` on the balance,
   [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md):49); a pinned overlay value the
   master now contradicts (signal, pin wins).
10. **Assumptions (load-bearing).** (a) The two-clock split is correct — master re-verify is system cost, overlay
    re-reveal is workspace cost. (b) Cold never-revealed master records can be left to decay un-re-verified
    (lazy). (c) Detection-once-at-Layer-0 is cheaper than per-CRM monitoring at scale [INFERRED]. (d) Measured
    decay (§2) is in the SLA ballpark; re-tune from observed data ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):62-65).

---

## 8. Open questions handed to the BRAINSTORM gate (not answered here)

1. **Decay-curve shape.** Linear vs exponential vs logistic for the freshness sub-score from `age/SLA`? The
   bands (`<0.5/<1.0/<1.5`) are set ([22 §3](../22-data-quality-freshness-lifecycle.md):128); the *continuous*
   curve between them is unspecified. Owned by `data_quality_rules` (tunable as data).
2. **"In-use" definition for the re-verify gate.** Revealed-by-≥1-workspace? Recently-active (`last_activity_at`,
   [03](../03-database-design.md):548)? On a shared list? In a live sequence? The exact predicate that decides
   which cold master records get re-verified vs left to decay — the §5 keystone — must be pinned.
3. **Re-reveal pricing on job change.** Is a job-change re-reveal a full-price new reveal, a discounted refresh,
   or free within a window? (Cognism re-charges, §2.3; overlaps U3 + [ADR-0013](../decisions/ADR-0013-charge-for-verified-data-credit-back.md)
   + the credit-back window.) Flag, don't decide.
4. **Job-change detection sourcing.** Which inputs (provider job-change feeds, LinkedIn-derived, email-signature,
   re-import diff) feed the Layer-0 detector, and at what cadence (weekly like ZoomInfo Tracker)? Sourcing/DPA in
   [21](../21-data-acquisition-sourcing.md).
5. **Signal vs auto-refresh policy per field.** Some low-risk firmographic refreshes (a recount of employee band)
   may be safe to auto-apply to overlays; PII channels (email/phone) are signal-only. Where is the line, and is it
   workspace-configurable?
6. **`verification_jobs` priority function.** The exact weights of decay × recency-of-use × seniority ×
   event-urgency, and the per-plan-tier re-verify budget ([22 OQ2](../22-data-quality-freshness-lifecycle.md):252).
7. **Master purge vs retain.** When a master record is beyond retention and *unused by any workspace*, purge or
   archive to the lake? ([22 §7](../22-data-quality-freshness-lifecycle.md); [08 §7](../08-compliance.md)) —
   intersects deletion (a later gate).

---

## 9. Recommendation

**Adopt a two-clock, hybrid-triggered, budget-rationed freshness lifecycle that treats every value as decaying,
re-verifies the shared universe cheaply and lazily, detects job changes once at Layer 0, and propagates change as
a *signal* into stable owner views — never a silent overwrite.** Every part extends a structure TruePoint already
has (the shipped `freshness_status`/`last_verified_at` fields, the `intent_signals.job_change` enum, the SCD2
edge, the waterfall, the bulk job ledger, the `provider_configs` budget) rather than inventing a parallel
mechanism. Concretely:

1. **Two clocks, governed differently.** Clock A = master channel `last_verified_at` (system re-verifies the
   universe once, on TruePoint's cost, amortized across workspaces); Clock B = overlay snapshot
   `last_verified_at`/`freshness_status` (a frozen point-in-time copy; refreshing it is a per-workspace,
   charge-only-for-valid **re-reveal**). The user-facing badge reads Clock B with a "newer data available"
   affordance when Clock A is fresher.
2. **Decay scoring is continuous and free; re-verification is rationed and paid.** The freshness sub-score decays
   gracefully from `age/SLA` per field via a set-based sweep (no provider spend); an actual re-verify (SMTP/phone
   re-check) spends and is gated. Per-field SLAs stay as [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)
   sets them (employment 60d, email 90d, phone/firmographics 180d, intent 30d-rolling), re-tuned from the §2
   measured decay (which validates them and shows email is the field to watch).
3. **Hybrid trigger into one queue.** Event-driven (job-change, reveal, send, bounce, on-demand) **jumps** a
   single decay-priority `verification_jobs` queue that the nightly in-use decay sweep **fills**; one budget gate
   (`provider_configs` + breaker) caps both. Reject a blind fixed-clock TTL over the whole universe.
4. **Job change = new evidence → SCD2 transition, never a mutation.** Detect once at Layer 0; ER resolves to the
   same identity; in one transaction close the old edge (`is_current=false`, `ended_on`), open the new, recompute
   `current_company_id`, emit one signal. History is retained by construction; idempotent on
   `content_hash`/`UNIQUE(person,company,started_on)`; ambiguous re-affiliations route to the review band.
5. **Propagate with three rules.** Projection (search/facets) reprojects eagerly via outbox/CDC (eventual
   consistency, re-checked at read); the denormalized firmographic cache recomputes in-transaction; **overlay
   snapshots get a job-change *signal*, never a silent overwrite** — the workspace opts into a billable re-reveal,
   and an overlay pin outranks even that. Fan-out is async, bounded, idempotent.
6. **Cost control is the feature, not an add-on.** Re-verify only in-use records; let cold master records decay on
   paper and verify lazily at next reveal (the largest cut); order by decay × value; offer on-demand premium;
   waterfall trust÷cost + cache-first + hard monthly budget; master re-verify is system cost, overlay re-reveal is
   workspace cost — never conflated.

### What this rejects, and why

- **A single freshness clock — rejected.** Treating the overlay copy and the master record as one clock either
  (a) silently overwrites a workspace's curated snapshot on every master refresh (violates survivorship +
  owner-view stability; the Cognism reuse model, [RESEARCH_04 §2.3](./RESEARCH_04_tenancy_projection.md)), or (b)
  freezes the universe and never refreshes search. Two clocks, governed differently, is mandatory.
- **A blind fixed-clock TTL sweep over the whole universe — rejected.** Re-verifying billions of cold,
  never-revealed records on a 60–180-day cadence is unbounded provider spend
  ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):52, "wasteful;
  cost-unbounded"). Re-verify must be gated on *in-use* + decay-priority + budget.
- **Verify-only-on-reveal (no ongoing re-verify) — rejected.** Data ages after reveal; bounce/credit-back cost
  rises; exports go stale ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):51).
  The lifecycle needs an ongoing operating model (Apollo: "ongoing operating model, not annual cleanup", §3.1).
- **Silently overwriting a revealed/owned overlay value when the master changes — rejected.** It violates
  survivorship and the human pin ([ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md);
  [RESEARCH_03 §B.2](./RESEARCH_03_mdm_merge.md)) and the Cognism re-charge model. The correct surface is a signal
  + an opt-in billable re-reveal.
- **Mutating the employment edge in place on a job change — rejected.** It destroys history (the degenerate
  `account_id` overwrite TruePoint ships today, [RESEARCH_00 §3](./RESEARCH_00_current_state.md)) and makes
  "title change, same company" undetectable. SCD2 close-old/open-new is the consensus shape
  ([RESEARCH_02 §2.2](./RESEARCH_02_linking_patterns.md)).
- **Per-workspace job-change monitoring (the UserGems/Champify model) — rejected for TruePoint.** It is right for
  a tool sitting on one customer's CRM, but TruePoint owns the universe: detect **once** at Layer 0 and fan a
  signal to the N workspaces that hold the person — vastly cheaper at scale [INFERRED] and the structural advantage
  of the two-layer model.
- **Charging a workspace for a system master re-verify it did not request, or eating provider cost for every
  workspace's snapshot refresh — rejected.** It breaks the cost-per-reveal unit economics
  ([06 §10](../06-enrichment-engine.md)). Master re-verify is amortized system cost; overlay re-reveal is
  charge-only-for-valid workspace cost.

**Implementation status (gap → work-to-do, not license to skip a rule).** Shipped today: the Clock-B overlay
fields (`contacts.last_verified_at`/`data_quality_score`/`freshness_status`, [03 §5.2](../03-database-design.md):544-546),
the `intent_signals.job_change`/`new_hire` enum (`intel.ts:80-81`), the waterfall trust÷cost + circuit breaker
(`waterfall.ts`), the `provider_calls` cache + `provider_configs` budget (`intel.ts`), and the bulk job ledger a
re-verify campaign reuses (`enrichmentJobs.ts`). Designed-but-unbuilt: the entire Layer-0 master graph incl.
Clock-A channel freshness (`master_emails`/`master_phones.last_verified_at`, [03 §5.1](../03-database-design.md):444-458),
the SCD2 `master_employment` edge (`:428-436`), `verification_jobs`, the decay model, and the priority queue
([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md):28; [22 §4](../22-data-quality-freshness-lifecycle.md)).
Net-new Phase-6 invention: the **two-clock reconciliation**, the **hybrid-trigger-into-one-budgeted-queue**
composition, the **detect-once-at-Layer-0 → signal-fan-out** propagation, and the **in-use re-verify gate** (the
cost keystone). None of these gaps relaxes a constraint — when built, master re-verify stays system-owned and
un-attributed, overlay refresh stays an opt-in billable re-reveal that respects the pin, the edge stays SCD2 so
history survives, re-verify stays budget-gated and suppression-aware, and the deterministic keys stay backed by DB
uniques so concurrent re-verifies cannot mint duplicates. The BRAINSTORM gate should turn this into the concrete
trigger/queue/priority design and the "in-use" predicate; the PLAN gate into the `verification_jobs` schema, the
decay-curve function, and the job-change SCD2 transition + signal-fan-out spec.
