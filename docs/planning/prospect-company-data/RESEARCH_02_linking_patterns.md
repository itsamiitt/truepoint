# Phase 2 — The Linking Layer (person ↔ company): Patterns Research

> **Gate: RESEARCH.** Phase 2 of the prospect↔company data initiative — the **person↔company edge**,
> ADR-0021's *"central design object."* This doc studies how the leading data vendors and the identity-graph
> literature model employment/affiliation, job changes, multiple affiliations, ambiguous company matches, and
> company-less people, then maps each pattern onto TruePoint's constraints and recommends an edge model.
> **Depends on:** `RESEARCH_00_current_state.md` (the frozen Phase-0 baseline — the degenerate `account_id`
> link and its four limits, U2 edge-provenance gap). **Ground truth:** the planned `master_employment` DDL
> (`03-database-design.md:428-436`), ADR-0021, the shipped match-key normalizers (`matchKeys.ts`). This gate
> **researches and documents only** — no brainstorm, no plan, no code/schema is written or modified. External
> claims are marked **[VERIFIED — url]** vs **[INFERRED]** (reasoned from public behaviour, not documented).

---

## 0. Scope & method

The edge is `master_employment` — a person↔company relationship carrying title, department, seniority, tenure,
and current/historical state, resolved primarily by email-domain → company `primary_domain`/`alt_domains`
(ADR-0021:39-40; `03-database-design.md:387-388`). Phase 0 already established that what is *built* is a single
nullable FK `contacts.account_id` (`contacts.ts:98`) with **four structural limits** — no history, no
multi-affiliation, no edge provenance, no shared company identity (`RESEARCH_00_current_state.md` §3) — and
that **edge-level provenance is undesigned anywhere** (RESEARCH_00 U2, line 297). The planned `master_employment`
schema fixes limits 1, 2, and 4 but **carries no source/confidence/as-of on the edge itself** (`03 §5.1` columns
are `title, department, seniority_level, is_current, started_on, ended_on` only — no provenance).

This research answers five questions that the planned DDL leaves open, by studying who already solved them:

1. **Direct FK vs affiliation EDGE** — is one current pointer ever enough, and what does the edge carry?
2. **Job-change history** — SCD2 (validity ranges + current flag) vs bi-temporal (valid-time + transaction-time)?
3. **Multiple affiliations** — advisor / dual-role / contractor / board seats; which edge is "current"?
4. **Ambiguous company matches** — domain→company when a domain is shared, freemail, a subsidiary, or a rebrand.
5. **Company-less people** — founders pre-domain, freelancers, students, the unemployed-in-transition.

External research uses primary vendor docs where they exist; vendor *internal storage* is almost never published,
so structural claims about a competitor's schema are marked **[INFERRED]** unless a doc states them.

---

## 1. What the leading platforms do

### 1.1 People Data Labs — the cleanest *published* model: an `experience[]` array, not an FK

PDL is the most useful external reference because its **person schema is public**. A person carries an
`experience` **array** of objects, each a self-contained affiliation: `is_primary` (bool — the current job),
`start_date`/`end_date` (`end_date` is `null` while current), a `title` object (`name, role, sub_role, class,
levels`), a **nested `company` object** (name, industry, size, location, LinkedIn id…), and **per-experience
metadata** `first_seen, last_seen, num_sources` **[VERIFIED — https://docs.peopledatalabs.com/docs/fields]**.
The "current company" is **not a foreign key** — it is *derived* by copying the `is_primary:true` experience into
flattened `job_company_*` fields, plus `job_last_changed` and `job_last_verified` timestamps; entries are sorted
primary-first then `start_date` descending **[VERIFIED — same]**. A separate `job_history` array holds
"supplementary roles that may have been removed or changed on resumes" — i.e. a lower-fidelity historical tail
**[VERIFIED — same]**.

Three takeaways that bind our design:

- **The edge IS the unit, and it is many-per-person.** PDL never models "one company per person"; it models a
  list of affiliations and *computes* the current one. This is the multi-affiliation answer (limit #2).
- **Provenance lives on each affiliation** (`num_sources` = corroboration count; `first_seen`/`last_seen` =
  the freshness window). This is exactly the **edge-level provenance** RESEARCH_00 flags as undesigned (U2):
  PDL proves it belongs *on the edge*, not on the person.
- **"Current" is denormalized, not authoritative.** `job_*` is a cache of `is_primary`; the array is the truth.
  This validates `master_persons.current_company_id` as a denormalization (`03-database-design.md:413,426`) —
  but warns it must be *derived from* the edge set, never hand-set.

### 1.2 ZoomInfo — "Tracker": the job-change *signal* as a first-class product

ZoomInfo's job-change product (**Tracker**) reviews tracked contacts **weekly** and emits **three distinct
signal types**: *employer change* (left company A for company B), *title change* (promotion within the same
company), and *department move* **[VERIFIED — https://pipeline.zoominfo.com/sales/job-change-alerts;
https://help.zoominfo.com/s/article/How-to-Use-Tracker]**. The framing in its launch is the load-bearing
insight: *"retain visibility into key buyers who switch to new accounts"* — a job change is simultaneously a
**new buyer at the new account and an open seat at the old one**
**[VERIFIED — https://ir.zoominfo.com/news-releases/news-release-details/zoominfo-launches-tracker-help-companies-retain-visibility-key/]**.
New title/employer data *"flows into the contact record automatically, keeping the source-of-truth fresh"*, and
accuracy comes from ML + NLP + automated validation + **human researchers cross-referencing multiple sources**
**[VERIFIED — pipeline.zoominfo.com/sales/job-change-alerts]**. Tracker caps tracked contacts at **5,000/user**
**[VERIFIED — help.zoominfo.com]**.

That ZoomInfo can name three signal types means it **diffs structured state across time** — strong evidence it
stores employment as a (person, company, title, dept, validity) record set rather than mutating one row, because
"title change *within the same company*" is only detectable if the prior (company, title) tuple is retained
**[INFERRED]**. ZoomInfo also sells company **hierarchy** (parent/subsidiary) as account data
**[VERIFIED — https://www.cognism.com/blog/... cross-ref; ZoomInfo docs]**, implying company nodes are linked
parent→child (mirrors `master_companies.parent_company_id`, `03-database-design.md:397`).

### 1.3 Apollo — waterfall re-resolution on change, dedup-merge at the overlay

Apollo runs **265M contacts / 60M companies** and treats a job change as a **re-enrichment trigger**: it
"searches for new emails, job titles, and company names to verify if a contact has changed roles," and on a miss
falls through **waterfall enrichment** across third-party sources until a new email is found
**[VERIFIED — https://knowledge.apollo.io/hc/en-us/articles/5130064363661-Use-Job-Change-Alerts-to-Enrich-Contacts;
https://www.apollo.io/product/enrichment-job-change-alerts]**. Critically, Apollo markets *"find **new contacts
at existing accounts**"* — i.e. the account node persists and gains/loses people over time, the account is not
re-created per contact **[VERIFIED — https://www.apollo.io/insights/can-data-enrichment-identify-new-contacts-at-companies-already-in-my-list]**.
At the customer's CRM layer, Apollo handles collisions with **dedup detection rules + a merge step**, and on a
detected job change can *update the existing record OR create a new one*
**[VERIFIED — https://knowledge.apollo.io/hc/en-us/articles/4413921630989-Use-CRM-Enrichment]**. The
"update-vs-create" fork is the same overlay decision TruePoint's importer makes under `conflict_policy`
(`RESEARCH_00` §4.1(b), `runImport.ts:230-241`).

### 1.4 Cognism — explicit account/contact split + job-change triggers + hierarchy

Cognism models **Accounts** (companies; name, address, industry, **hierarchy, subsidiaries, parent companies**)
and **Contacts** (people linked to accounts), and fires **job-change triggers** on both *company change* and
*title change* **[VERIFIED — https://www.cognism.com/blog/lead-enrichment; https://www.cognism.com/faq;
https://pipeline.zoominfo.com/sales/cognism]**. Company **assignment** "defines ownership of an account … to
avoid duplicate outreach" and supports assigning **multiple accounts** and targeting **personas within companies**
**[VERIFIED — https://help.cognism.com/hc/en-gb/articles/34154975914130-How-to-Set-Up-Teams-and-Assign-Companies-and-Personas]**
— the account is the shared node, ownership/assignment is the per-team overlay. This is structurally TruePoint's
exact split: shared company identity (Layer 0) + per-workspace `owner_user_id`/`assigned_team_id` (overlay,
`03-database-design.md:503-505,540-541`).

### 1.5 Clay — affiliation is *computed by a cost-ordered waterfall*, not stored once

Clay's model is process-not-schema: a **waterfall** queries providers **in cost order**, stops on the first valid
hit, **refunds credits on a miss**, and validates the result (default ZeroBounce)
**[VERIFIED — https://www.clay.com/waterfall-enrichment; https://university.clay.com/lessons/enrich-people-waterfalls-clay-101]**.
It enriches at **contact level** (email/phone/title) **and company level** (revenue, headcount, tech stack) and
integrates PDL for the person/experience layer
**[VERIFIED — https://university.clay.com/docs/people-data-labs-integration-overview]**. Clay confirms the
**provider-waterfall** pattern TruePoint already ships (`waterfall.ts:50-60`, trust÷cost ordering) — relevant
here because the *winning provider per field* is the provenance Phase 3 must capture, and the *company a provider
returns* is what feeds the edge.

### 1.6 Clearbit (now HubSpot Breeze) — domain is the company primary key; name→domain is fuzzy

Clearbit's stated principle: *"A domain name makes a great identifier because it's unique, non-proprietary, it
resolves (or doesn't), and unlike company names, there can only be one domain name"*
**[VERIFIED — https://clearbit.com/blog/company-name-to-domain-api]**. Name→domain is an **ML entity-resolution**
problem over *"millions of company names — including abbreviations, subsidiaries, and DBAs"*; it does an exact
match first, else a **fuzzy** match, and **breaks ties by highest website traffic**
**[VERIFIED — same]**. This is direct validation of `master_companies.primary_domain` as *the* company key
(`03-database-design.md:392`) and of `name_normalized` as the no-domain fallback (`:395`), and it names the exact
hazard for the edge: a short/shared name resolves to the wrong domain unless tie-broken with context.

### 1.7 LinkedIn Sales Navigator — three saved-entity alert types, edge implied by the source-of-truth

Sales Navigator continuously monitors **saved** leads/accounts and emits **"Lead Changed Jobs"** (moved company),
**"Lead Changed Roles"** (new role, same company), and — at the account — **"Talent Moving to Another Account"**
**[VERIFIED — https://www.linkedin.com/help/sales-navigator/answer/a105133;
https://www.linkedin.com/help/sales-navigator/answer/a108112]**. LinkedIn is the *origin* of the experience-array
model the whole industry copies (a profile's "Experience" section is an ordered list of positions with company,
title, dates) — `linkedin_public_id` is therefore TruePoint's strongest person key (`matchKeys.ts:23-24,123-125`;
`master_persons.linkedin_public_id`, `03-database-design.md:411`), and the LinkedIn company page id is the
strongest company key after domain (`master_companies.linkedin_company_id`, `:396`).

### 1.8 Synthesis — the cross-vendor pattern

| Capability | PDL | ZoomInfo | Apollo | Cognism | Clay | Clearbit | Sales Nav |
|---|---|---|---|---|---|---|---|
| Person↔company shape | `experience[]` array **[V]** | record set, diffed **[I]** | contact↔account, persists **[V]** | contact↔account **[V]** | waterfall-computed **[V]** | n/a (company side) | profile positions list **[V]** |
| Job-change as | dates + `job_last_changed` **[V]** | 3 signal types **[V]** | re-enrich trigger **[V]** | company+title trigger **[V]** | re-run waterfall **[I]** | n/a | 3 alert types **[V]** |
| Multi-affiliation | many entries, `is_primary` **[V]** | implied by set **[I]** | new contacts/account **[V]** | personas/account **[V]** | per-row **[I]** | n/a | positions list **[V]** |
| Company key | nested `company.id` **[V]** | hierarchy ids **[V/I]** | account id **[V]** | account+hierarchy **[V]** | provider id **[I]** | **domain** (traffic tiebreak) **[V]** | li company id **[V]** |
| Edge provenance | `num_sources, first/last_seen` **[V]** | ML+human verify **[V]** | source per enrich **[I]** | sourced **[I]** | provider per field **[V]** | — | — |

**The convergent pattern: a person owns a *set* of dated, sourced affiliation records; "current" is a derived
flag/cache; the company is a separately-resolved shared node keyed by domain; a job change is a *diff* over the
set that fires a signal. No serious vendor uses a single mutable current-company pointer.** TruePoint's degenerate
`contacts.account_id` (`contacts.ts:98`) is the outlier the industry abandoned; the planned `master_employment`
edge (`03-database-design.md:428-436`) is the consensus shape — but it is missing the *provenance* and
*resolution-state* the consensus also carries.

---

## 2. The modeling patterns, evaluated against TruePoint

### 2.1 Direct FK vs employment/affiliation EDGE

A direct FK (`contacts.account_id`) encodes exactly one fact: "right now, our best guess is company X." It cannot
express tenure, history, a second job, *or how confident we are*. Every vendor in §1 models the relationship as a
**first-class edge/record** so that title/dept/seniority/dates/source attach **to the affiliation, not the person**
— which is the only way "title changed within the same company" (ZoomInfo signal 2) is even expressible. TruePoint's
target already chose the edge (`master_employment`); this research's contribution is *what the edge must carry beyond
the planned columns*: **source, confidence, and an as-of timestamp** (the U2 gap; PDL's `num_sources/first_seen/
last_seen` is the existence proof).

```
  TODAY (overlay, degenerate)            TARGET (Layer-0 edge, consensus shape)
  contact ──account_id──▶ account        master_person ──┐
  (1 company, mutable, no history)                       │ master_employment (EDGE: 0..N)
                                                         ├─ title, dept, seniority
                                                         ├─ is_current, started_on, ended_on   ◀─ tenure/history
                                                         ├─ source, confidence, as_of          ◀─ U2 gap (add)
                                                         └─▶ master_company  (resolved by domain/PSL)
                                          master_person.current_company_id = derived cache of is_current edge
```

### 2.2 SCD2 vs bi-temporal for job-change history

Two ways to keep history:

- **SCD2** — one row per affiliation with a **validity range** (`started_on`/`ended_on`) and a **current flag**
  (`is_current`); a change **closes the old row** (sets `ended_on`, `is_current=false`) and **opens a new one**.
  Single timeline; prior history retained and queryable; cost is row-count growth
  **[VERIFIED — https://datacadamia.com/data/type/cube/modeling/scd;
  https://learn.microsoft.com/en-us/fabric/data-factory/slowly-changing-dimension-type-two]**.
- **Bi-temporal** — track **valid-time** (when the fact was true in reality) *and* **transaction-time** (when we
  learned it), so a *retroactive correction* ("we discovered on Mar-15 that they actually left on Feb-15") is
  representable and historical queries are reproducible "as we knew it then"
  **[VERIFIED — https://scaleup.healthcare/blog/bitemporal-modeling/]**.

**The planned `master_employment` is SCD2** by construction: `is_current` + `started_on`/`ended_on` +
`UNIQUE(master_person_id, master_company_id, started_on)` is exactly an SCD2 grain (`03-database-design.md:433-434`).
That is the right default — it answers "where did they work and when," which is all the job-change *signal* needs.
**Full bi-temporal is over-engineering for a prospecting graph**: the expensive thing bi-temporal buys (reproducing
a past *belief* for audit/payroll-style correctness) is not a sales-intelligence requirement, and it roughly doubles
the schema and every query. **But one transaction-time field is cheap and worth it** — an `as_of`/`observed_at` (and
keeping the *evidence* in `source_records`, `03-database-design.md:461-471`) lets ER re-evaluate a stale edge and
lets us answer "when did we *learn* of this move," without paying for the full bi-temporal join discipline. Net:
**SCD2 grain + a single observed-at + immutable source_records lineage** — a pragmatic 1.5-temporal model, not 2.

### 2.3 Confidence-scored edges + edge-level provenance

The identity-graph literature is explicit: *"every edge carries a confidence score"* and *"edges should be stored
with confidence scores, timestamps, and source provenance"*; deterministic matches (verified email / domain) score
highest, probabilistic (name+employer+title) lower, and the **score routes the merge**: above a cutoff merge, in a
gray zone flag for review, below keep separate **[VERIFIED — https://tomba.io/blog/b2b-identity-graph;
https://prospeo.io/s/b2b-identity-graph;
https://www.revsure.ai/blog/building-a-unified-identity-graph-...]**. The same source prescribes a **freshness decay**:
*"attach a 'last verified' timestamp and downgrade confidence as it ages"* and **re-solve when titles or domains
change** **[VERIFIED — tomba.io/blog/b2b-identity-graph]**. This is a direct match to TruePoint's freshness model
(`freshness_status fresh|aging|stale|expired`, ADR-0025; `03-database-design.md:546`) — but TruePoint applies it to
the *person/contact*, not the *edge*. **The research conclusion: the edge needs its own `confidence`, `source`, and
`as_of`/`last_verified` triple** — the U2 gap — and the existing two-threshold ER routing (`match_links.review_status`
∈ `auto|pending|confirmed|rejected`, `03-database-design.md:481-482`; ADR-0015 calibrated cutoffs) should govern
**edge** acceptance the same way it governs entity merges. A fuzzy `deterministic_domain`+`fuzzy_name_company` edge
(`matchKeys.ts:23-28`) is exactly the gray-zone case that must land in review, never auto-bind.

### 2.4 Domain → company resolution feeding the edge

The edge's company side is resolved by **registrable domain (eTLD+1 via the Public Suffix List)** — already computed
in code (`registrableDomain` via `tldts`, `matchKeys.ts:74-81`) and already the planned company key
(`master_companies.primary_domain`, `03-database-design.md:392`). The failure modes the literature names, and the
TruePoint handling each implies:

| Hazard | Example | Consequence if naïve | Handling (existing hook) |
|---|---|---|---|
| **Freemail / ISP domains** | `john@gmail.com`, `@outlook.com` | every freemailer "works at Gmail" — a giant false company | A **freemail/role-domain blocklist**: such a domain yields **no company edge** (company-less, §2.6), never a `master_company`. (Undesigned today.) |
| **Shared/short name** | "Apex" → 5 companies | wrong domain bound by traffic-rank | Clearbit's traffic tiebreak is a heuristic, not truth — route to **review** below a confidence cutoff (§2.3) **[VERIFIED — clearbit.com/blog/company-name-to-domain-api]** |
| **Subsidiary vs parent** | `aws.amazon.com` user vs `amazon.com` | merges/splits two real companies | `parent_company_id` hierarchy (`03-database-design.md:397`) + `alt_domains[]` (`:393`) keep them distinct but linked **[VERIFIED — elvesora.com/...; cognism hierarchy]** |
| **Rebrand / acquired brand / redirect** | `fb.com`→`meta.com` | two company rows for one entity | `alt_domains[] citext[]` on the company absorbs redirects/old brands (`:393`) |
| **Multi-tenant / agency domain** | contractors all on `@agency.com` | infers wrong employer | low-confidence domain edge → review; corroborate with LinkedIn company id (`:396`) |

Verified industry consensus: *"a domain lookup may return a plausible domain, but that does not make the match
safe … subsidiary, regional office, or parent could all be valid candidates"* → auto-match only on high confidence,
**review** when plausible-but-mutating, **reject** on conflict
**[VERIFIED — https://www.elvesora.com/blog/handling-ambiguous-company-names-domain-matching]**. This is the same
auto/pending/rejected routing as §2.3 — domain→company resolution is just edge resolution on the company end.

### 2.5 Firmographic backfill onto the person view

Vendors flatten the current company's firmographics onto the person for query speed — PDL copies `job_company_*`
onto the person from the `is_primary` experience **[VERIFIED — docs.peopledatalabs.com/docs/fields]**. TruePoint's
target does this with `master_persons.current_company_id` (denormalized from the current edge,
`03-database-design.md:413`) and the search topology *"flatten[s] person+company so one query answers 'person at
company with these company traits'"* (ADR-0021:`02-architecture`; ADR-0035; the shared ground-truth's search note).
**Research caution: the backfill must be a derived projection of the edge, recomputed when the current edge changes
— never an independently writable field** (else the person and the edge disagree after a job change, re-introducing
limit #1's staleness at a new layer). The denormalization is a cache; the edge set is truth (the PDL discipline).

### 2.6 Company-less people

Real and common: a founder before the domain exists, a freelancer, a student, a between-jobs prospect, or a person
whose only signal is a freemail address (§2.4). The consensus shape handles this **natively** because the edge is
`0..N`, not `1`: a person with **zero** `master_employment` rows is simply company-less; `current_company_id` is
`NULL`; firmographic facets are absent (`master_persons.has_email/has_phone` still apply,
`03-database-design.md:418-419`). The degenerate FK *also* allows `account_id = NULL` (`contacts.ts:98`) — but it
conflates "no company" with "company not yet resolved," and it strands a domainless company entirely (the importer
**skips** domainless accounts, `RESEARCH_00` §3 / `runImport.ts:205`). The edge model separates these cleanly:
no edge = company-less; a `pending`-review edge = unresolved; a non-freemail domain with no `master_company` yet =
**mint a company node** (Clearbit: the domain *is* the identity even before we have firmographics). **A name-only
company with no domain** is the genuinely hard case — it can only ever be a low-confidence `name_normalized` edge
(`:395`) held in review, never an auto-bound affiliation.

---

## 3. Isolation & ownership of the edge — shared canonical infra vs per-tenant

This is the sharpest TruePoint-specific tension, and it is **not** a question any external vendor answers (none of
them run a per-customer RLS overlay over a shared graph the way ADR-0021 does).

**The edge lives at Layer 0 (system-owned), not in the workspace.** `master_employment` is part of the global
master graph, which is **system-owned and NOT workspace-RLS-scoped** — isolation is by **access path** (masked
search + paid reveal + privileged/admin roles), never a `workspace_id` predicate (ADR-0021 Decision & Mitigation,
`:33-35,129`; `03 §9`). A workspace must **never** be able to read `master_employment` directly. Concretely:

```
  Layer 0 (system-owned, NO RLS)              Layer 1 (per-workspace, FORCE RLS on workspace_id)
  master_persons ─ master_employment ─ master_companies
        ▲                                          ▲
        │ master_person_id (soft FK, no RLS)       │ master_company_id
        │                                          │
  contacts (overlay) ───account_id──▶ accounts (overlay)
        └─ workspace_id = current_setting('app.current_workspace_id')  ◀─ the only wall a workspace sees
  Access to the edge: masked search (returns IDs) → paid reveal → COPIES the resolved company into the overlay
```

Consequences this research surfaces for the edge specifically:

- **The overlay never stores the edge; it stores the *result* of reading it.** A reveal copies the *currently
  resolved* company/title into the workspace's `contacts.account_id`/`job_title` (the existing reveal-copies-value
  mechanic, ADR-0021:48-51,84). So the overlay holds a **point-in-time snapshot** of the edge; the live edge keeps
  evolving in Layer 0. **A job change at Layer 0 does NOT silently rewrite a workspace's revealed contact** — that
  would violate "user-entered/owned values are not silently overwritten" (ADR-0015 survivorship; RESEARCH_00 §5/U3).
  Instead it should surface as a **job-change *signal*** the workspace can act on (the ZoomInfo/Sales-Nav model),
  exactly the Phase-3 reconciliation question (U3) — flagged here, not solved.
- **Edge confidence/provenance is system-global, but visibility of the *underlying channel* stays gated.** The edge
  itself (person works at company, title, dates) is masked-searchable; the *email/phone* that corroborates it
  (`master_emails`/`master_phones`) is **never** returned by search, only by paid reveal (`03-database-design.md:383-384`).
  So "what's the edge's source" is answerable to the system/admin (`source_records` lineage), and a *masked* form of
  the edge is searchable, but the PII evidence behind it stays reveal-gated.
- **DSAR/deletion cascades through the edge.** A data subject is one `master_persons` identity (found by
  `email_blind_index`); erasure tombstones the overlay copies **and** must `ON DELETE CASCADE` the
  `master_employment` edges (`03-database-design.md:430-431`), the `master_emails`/`master_phones`, and the
  `source_records` evidence, then insert a GLOBAL suppression row to block re-import (ADR-0021 deletion;
  `RESEARCH_00` §0/DELETION). The edge is *in* the blast radius of erasure — its `ON DELETE CASCADE` to
  `master_persons` already encodes that (`:430`).
- **Per-workspace edge curation is an overlay concern, not an edge mutation.** Cognism/Apollo "account ownership"
  and "assignment" are **per-team overlay** state (`accounts.owner_user_id/assigned_team_id/visibility`,
  `03-database-design.md:503-505`) — they never write the shared edge. A workspace correcting "no, she's actually at
  company Z" edits its **overlay**, and (only if co-op CONTRIBUTE-TO is opt-in enabled, ADR-0021:60-62) feeds a
  `source_record` that ER may use to *propose* a new global edge — it never directly mutates `master_employment`.

---

## 4. Tradeoffs against the TruePoint cross-cutting constraints

| Constraint (shared ground-truth) | Edge-model implication | Risk if ignored |
|---|---|---|
| **Multi-tenant RLS** | Edge is Layer-0 system-owned; overlay reads by access path only; no `workspace_id` on the edge | A `workspace_id` on the edge would shatter the "dedup the universe once" promise and leak isolation into the shared graph |
| **Per-owner visibility** | Ownership/assignment of the *affiliation* is overlay state (`owner_user_id`, `assigned_team_id`), never on the edge | Putting owner on the edge would make a shared fact per-tenant — wrong layer |
| **Canonical identity (4-signal)** | Company end resolved by `primary_domain`/PSL (sig 3, strongest company key) + `linkedin_company_id`; person end by `linkedin_public_id`/email-BI; build on `matchKeys.ts`, do not reinvent | A second normalizer drifts bulk-vs-batch (ADR-0037 forbids) |
| **Field/edge provenance** | Add `source`+`confidence`+`as_of` to the edge (U2); SCD2 grain + immutable `source_records` lineage | Without it, a job change is indistinguishable from a bad-source flap; cannot re-evaluate or unwind |
| **Scale: billions of edges** | Edge table is the largest in the graph (people × jobs); needs `idx_employment_current` partial (`:436`), Citus-shard by `master_person_id`, and **denormalized `current_company_id`** so "person at company with traits" is **not** a per-row join | A join per result row = N+1 at billions; an unbounded multi-affiliation fan-out per person = unbounded result set |

**What breaks first at 10×** (the scale-gate question): the **current-company denormalization going stale** at write
volume — every job change must atomically (a) close the old edge, (b) open the new edge, (c) recompute
`current_company_id`, and (d) emit a job-change signal, all idempotently keyed on `source_records.content_hash`
(`03-database-design.md:464`). If (c) lags (a)/(b), the flattened search docs (ADR-0035) serve a person at the wrong
company — the single most expensive correctness bug here. Second to break: **fuzzy `name_normalized` edges**
auto-binding under load instead of queuing for review, inflating the false-merge rate past ADR-0015's ≤0.5% target.

---

## 5. Open questions handed to the BRAINSTORM gate (not answered here)

1. **Edge provenance shape** — is it columns on `master_employment` (`source`, `confidence numeric(4,3)`,
   `observed_at`) or a child `employment_evidence` table mirroring `match_links`→`source_records`? (U2; PDL uses
   per-experience metadata, leaning columns.)
2. **Job-change → overlay reconciliation** — does a Layer-0 edge change push a *signal* (ZoomInfo model) or
   re-offer a reveal, and never overwrite a workspace's owned `account_id`? (U3 — Phase 3 territory.)
3. **Multi-affiliation "current" tiebreak** — when two edges are `is_current` (advisor + day job), which sets
   `current_company_id`? (PDL `is_primary`; need our own primary-selection rule — likely email-domain match wins.)
4. **Freemail/role-domain blocklist** — the source-of-truth list and where it lives (config vs PSL-private section).
5. **Edge review queue** — does `master_employment` get its own `review_status`, or are ambiguous edges held as
   `match_links` rows until confirmed? (Reuse vs duplicate the existing two-threshold machinery.)

---

## 6. Recommendation

**Adopt a confidence-scored, SCD2-grain employment EDGE — the cross-vendor consensus shape — and treat the planned
`master_employment` (`03-database-design.md:428-436`) as the correct skeleton that this initiative must *extend with
provenance and resolution-state*, not replace.** Concretely, the recommended edge model is:

1. **An edge, never a pointer.** Person owns `0..N` `master_employment` affiliations; the company is a separately
   domain-resolved shared node; "current" is a **derived** `is_current` flag mirrored into
   `master_persons.current_company_id` as a *recomputed cache* (PDL's `is_primary`→`job_*` discipline,
   **[VERIFIED — docs.peopledatalabs.com/docs/fields]**). This natively delivers history (limit #1),
   multi-affiliation (limit #2), and company-less people (zero edges).
2. **SCD2 + one transaction-time field, not full bi-temporal.** Keep `started_on`/`ended_on`/`is_current` +
   `UNIQUE(person, company, started_on)` (already planned), add a single **`observed_at`/`last_verified`** and lean
   on immutable `source_records` for lineage. Reject full bi-temporal: its retroactive-belief reproduction is
   payroll/audit-grade correctness a prospecting graph does not need, at ~2× schema/query cost
   **[VERIFIED — scaleup.healthcare/blog/bitemporal-modeling]**.
3. **Provenance + confidence ON the edge (closes U2).** Add `source`, `confidence`, and `as_of` to the affiliation
   (PDL's `num_sources`/`first_seen`/`last_seen` is the existence proof; identity-graph literature mandates it
   **[VERIFIED — tomba.io/blog/b2b-identity-graph]**). The edge's confidence routes via the **same two-threshold
   ER machinery already specified** — auto-accept ≥ high cutoff, **review** in the gray zone (`match_links.review_status`
   `pending`), reject below (ADR-0015; `03-database-design.md:481-482`).
4. **Domain→company resolution via PSL, with a review queue and a freemail blocklist.** Use the shipped
   `registrableDomain`/`matchKeys.ts:74-81` (no second normalizer — ADR-0037), key the company on `primary_domain`
   with `alt_domains[]` for redirects/acquired brands and `parent_company_id` for subsidiaries; **freemail/role
   domains yield no company edge** (company-less, not a fake company); short/shared/ambiguous names resolve to
   **review**, never an auto-bound edge (Clearbit traffic-tiebreak is a heuristic, not truth
   **[VERIFIED — clearbit.com/blog/company-name-to-domain-api; elvesora.com/...]**).
5. **Firmographic backfill is a derived projection.** `current_company_id` and the flattened search docs are a cache
   of the current edge, recomputed transactionally on any job change — never independently writable (else staleness
   returns at a new layer).
6. **The edge is Layer-0 system-owned; the workspace touches it only by access path.** No `workspace_id` on the edge;
   reveal copies a point-in-time snapshot into the overlay; a later Layer-0 job change surfaces as a **signal**, not
   a silent overwrite; DSAR erasure cascades through the edge (`ON DELETE CASCADE` to `master_persons`).

**What I explicitly reject:**

- **The direct single-FK link (`contacts.account_id` as the model).** It is the pattern every vendor in §1
  abandoned; it cannot express tenure, a second affiliation, history, or confidence, and it conflates "no company"
  with "unresolved." It survives only as the *overlay snapshot* of a revealed edge, not as the link's source of truth.
- **Full bi-temporal modeling.** Over-engineered for sales intelligence (§2.2); SCD2 + a single observed-at +
  `source_records` lineage is the right cost/value point.
- **A `workspace_id`-scoped (per-tenant) employment edge.** It would re-fragment the universe ADR-0021 exists to
  unify (the same human as N edges across N workspaces), defeat global dedup, and bleed RLS into the shared graph.
  Per-tenant curation/ownership of the affiliation belongs on the *overlay* (`owner_user_id`/`assigned_team_id`),
  not the edge.
- **Auto-binding fuzzy edges.** A `fuzzy_name_company` or name-only/ambiguous-domain affiliation must enter the
  review queue, never auto-merge — auto-binding the gray zone is the fast path to breaching ADR-0015's ≤0.5%
  false-merge target under load.
- **Treating a Layer-0 job change as an overlay overwrite.** It violates survivorship (user-owned/revealed values
  are not silently superseded); the correct surface is a job-change *signal* + a re-reveal offer (the U3
  reconciliation Phase 3 owns) — flagged here, deliberately not designed in this RESEARCH gate.
