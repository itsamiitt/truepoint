# Phase 1 — Research (v1)

**Rule of this document:** every claim is either cited, marked `[VENDOR CLAIM]` (self-reported marketing,
treat as an upper bound), or marked `[COULD NOT VERIFY]`. Nothing here is inherited from `cascade 1.md` /
`cascade 2.md` without independent confirmation — those are reference designs for a different product, and
`cascade 2.md` itself warns that its provider figures are unaudited vendor claims.

Each section ends with **→ Implication**: what it means for TruePoint specifically, given what
`02-audit.md` found already built.

---

## R1. Technographic modeling — catalog vs. adoption edge

**Finding.** The market converges on a two-object model: a **technology catalog** (the product itself) and a
**detection/adoption edge** (this company, this technology, over this time window). PredictLeads publishes
them as two distinct datasets — a technologies dataset of ~54,000 tracked technologies and a technology
*detections* dataset of ~1.4 billion detections `[VENDOR CLAIM]`. The detection object carries a
`first_seen_at` timestamp used for adoption-window filtering.

`[COULD NOT VERIFY]` — the full field list of PredictLeads' detection and catalog objects. Their docs are
client-rendered; both `data_model` pages returned navigation without the schema body. TheirStack's dataset
doc URL 404s. **Do not copy a field list from `cascade 2.md` claiming provider authority; it is not
retrievable from the public docs.** What *is* verifiable is the shape (catalog + dated edge) and the
per-detection confidence idea, which multiple independent providers describe.

**Detection method taxonomy** (6sense, verbatim structure): two families —
- *Passive*: job descriptions listing required technologies; employee professional profiles mentioning
  tools; "human curated research."
- *Active*: HTML source signatures; JavaScript detection of embedded third-party tools; "Subdomain Hits"
  testing for multi-tenant SaaS platforms; "NS/MX Lookups" examining DNS infrastructure.

**Confidence model** (6sense, verbatim): a 0–100 score built from three factors —
1. **Recency** — *"A detection made last week carries more weight than one made several weeks ago,"* with
   decay logic that **varies by source type**.
2. **Detection volume** — *"A technology referenced across many job postings or employee profiles is more
   likely to be actively in use than one mentioned only once."*
3. **Source reliability** — *"Active sources are weighted more heavily than passive sources, reflecting the
   directness and verifiability of their signals."*

Refresh cadence is stated as every 2–4 weeks. 6sense's doc does **not** describe first/last-detected date
handling.

**→ Implication.** This is a three-input confidence function — recency × corroboration count × source
weight — and TruePoint already has all three inputs in the graph: `last_verified_at` / `observed_at`,
`source_count`, and `source_name`. The technology confidence score is therefore **the same fold already
written for `field_provenance`**, applied to a new edge type — not a new subsystem. Design decision D1's
fix (`technographics` jsonb → catalog + dated edge) is confirmed by independent market practice, and the
decay-varies-by-source-type detail is the strongest argument yet for finally building the decay curve
(audit D5), because a job-posting detection and a DNS detection cannot share a half-life.

Sources: [PredictLeads technology detections](https://docs.predictleads.com/v3/api-reference/technology-detections) · [PredictLeads: detect a company technology stack](https://blog.predictleads.com/2026/03/16/detect-company-technology-stack) · [6sense technographic data overview](https://support.6sense.com/docs/technographic-data-overview) · [ZoomInfo technographics guide](https://pipeline.zoominfo.com/sales/technographics)

---

## R2. Product intelligence — no established B2B-data pattern exists

**Finding.** Searching for a canonical B2B *product-intelligence* entity model returns commerce catalogs
(Salesforce B2B Commerce: Catalog → Category → Product → Product Media → variants/bundles), which model
*products you sell in a store*, not *products a company makes, that other companies adopt*. G2 and
Crunchbase categorize company products, but neither publishes an entity schema.

**→ Implication.** Product intelligence is **bespoke**, and the brief's product section is the least
evidence-backed part of the whole request. The honest move is to derive it from the technology model rather
than invent a parallel one: a product a company *sells* and a technology another company *adopts* are the
same object viewed from two ends. **Recommendation for Phase 3:** model `products` as a *specialization of
the technology catalog* (a technology with a vendor link is, functionally, that vendor's product) plus a
`product_features` child, rather than a separate hierarchy. This collapses two of the brief's five
intelligence domains into one table family and removes the product↔technology mapping problem entirely.
Flagged for human confirmation because it reinterprets the brief's structure — deliberately surfaced, per
rule 6, not silently applied.

Sources: [Salesforce B2B Commerce product & catalog data model](https://developer.salesforce.com/docs/commerce/salesforce-commerce/guide/b2b-b2c-comm-data-model-product-catalog.html)

---

## R3. Signal taxonomy — six families, industry-consistent

**Finding.** Independent sources converge on the same six buying-signal families:
1. Job postings / hiring surges (budget and initiative expansion)
2. Funding rounds and M&A (new budget, new priorities)
3. Technology-stack changes (openness to new tools)
4. Leadership changes in the target persona (new leaders bring new vendors)
5. Intent data / content engagement (active research)
6. Earnings calls and SEC filings (strategic priorities)

**→ Implication.** Families 1–4 and 6 are derivable from data TruePoint either owns or can license, and
they are *not* deferred non-goal X-04. **Only family 5 is X-04.** That resolves conflict C5 cleanly: build a
canonical signal store covering 1–4 and 6; leave family 5 out with the seam open. Audit finding D6 (closed
9-value CHECK enum on a tenant-scoped table) is the blocker — a canonical signal needs a Layer-0 home and an
extensible type vocabulary, because a closed enum makes every new signal family a migration.

Note the important distinction for TruePoint's compliance posture: signals 1–4/6 are *company* facts, not
person tracking. They carry far lighter privacy weight than family 5, which is exactly why the strategy
deferred family 5 and not the others.

Sources: [Salesmotion buying-signals guide](https://salesmotion.io/blog/buying-signals-guide) · [ZoomInfo B2B buying signals](https://pipeline.zoominfo.com/sales/b2b-buying-signals) · [Autobound signal platforms 2026](https://www.autobound.ai/blog/top-signal-data-platforms-b2b-sales-2026)

---

## R4. Data decay — the number that justifies the whole freshness model

**Finding.** Reported B2B contact decay clusters around **~2.1% per month, compounding to ~22.5% per year**,
with email decaying fastest because it is tied to employment status. Reported component rates: job title
~65.8%/yr, phone ~42.9%, address ~41.9%, email ~37.3%. Published ranges run from 22.5% to 70.3% annually
depending on whose methodology `[VENDOR CLAIM — all of these come from data vendors who sell the cure]`.
The direction and the dominant driver (job change) are consistent across every independent source; the
precise coefficient is not trustworthy.

**→ Implication.** Do **not** hard-code a decay constant from a vendor blog. Build the decay curve with the
half-life as a **configurable per-(field, source_type) parameter**, seeded at ~24 months for identity fields
and ~9–12 months for email, then calibrated against TruePoint's own bounce and reverification telemetry —
which the platform already collects via `verification_jobs` and the reverification sweeps. This is the
inert-config pattern: shipped defaulting to today's behaviour, tuned on real evidence.

This finding also directly supports outcomes S-09 (person has left the company) and S-13 (fast job-change
detection) — decay is not a nice-to-have, it is the mechanism behind two of the top-six outcomes.

Sources: [Cleanlist data-decay statistics](https://www.cleanlist.ai/blog/2026-01-22-b2b-data-decay-statistics) · [ZoomInfo on B2B data decay](https://pipeline.zoominfo.com/marketing/b2b-data-decay) · [Apollo on decay rates](https://www.apollo.io/insights/whats-the-average-rate-of-data-decay-in-a-b2b-contact-database-and-how-do-i-address-it)

---

## R5. Identity resolution — blocking is the real constraint

**Finding.** The Fellegi–Sunter model (1969) remains the standard for probabilistic linkage: per-attribute
weights from an m-probability (agreement given a true match) and a u-probability (agreement given a
non-match). The pipeline is universally **blocking → matching → clustering**.

Splink's own performance guidance gives hard numbers: comparison count grows with the square of record
count — *a dataset of 1 million records generates around 500 billion pairwise comparisons*. After blocking,
comparisons typically remain **10× to 1,000× the input row count**. Practical ceilings: ~20 million
comparisons on DuckDB on a laptop; start below 100 million on Spark/Athena; ~1 billion achievable on a small
cluster. Critical rule: **blocking rules must not use similarity/distance functions**, because those must be
evaluated across all candidate pairs before filtering. Recall matters more than precision in blocking.

**→ Implication.** This is the decisive fact for audit finding D4. TruePoint's `block_key` columns are
reserved and *deliberately unindexed*, which means today's ER ladder stops at the deterministic tier — and
that is architecturally *fine*, because deterministic keys here are unusually strong: `primary_domain`
(PSL-normalized), `linkedin_public_id`, `content_hash`, and the HMAC blind indexes on email and phone. Those
resolve the large majority of real pairs at zero comparison cost.

The probabilistic tier should be built as a **bounded, queued, offline job over blocked candidate sets**,
not as an online path — with the blocking key chosen so that no block exceeds a few thousand members. No
Spark, no Splink runtime dependency required: the m/u weight arithmetic is trivial; the expensive part is
candidate generation, which is a Postgres index problem. `forge.match_candidates` already exists as the
landing table for exactly this.

Sources: [Splink blocking rules](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html) · [Splink blocking-rule performance](https://moj-analytical-services.github.io/splink/topic_guides/blocking/performance.html) · [Fellegi–Sunter overview, O'Reilly *Hands-On Entity Resolution* ch.4](https://www.oreilly.com/library/view/hands-on-entity-resolution/9781098148478/ch04.html)

---

## R6. Survivorship / golden-record practice

**Finding.** MDM survivorship strategies are a small, well-known set: **source-system trust** (most reliable
system wins), **recency** (latest value wins), **frequency** (value appearing most often across systems
wins), and **completeness** (record with most populated attributes wins). Golden-record health is measured
by completeness rate, duplicate rate, match confidence score, and time-to-resolution.

**→ Implication.** TruePoint's `field_provenance` fold in `packages/core/src/prospect/fieldProvenance.ts`
already implements a survivorship policy; this research says the *inputs* are complete (source weight,
recency, corroboration count) and names one TruePoint does not yet weigh: **completeness**. Worth a Phase 3
review of the fold rather than a rewrite. `data_quality_snapshots` already exists as the health-metric home.

Sources: [LatentView MDM golden record](https://www.latentview.com/blog/mdm-golden-record/) · [D&B on golden records](https://www.dnb.com/en-us/resources/master-data/what-are-golden-records-in-master-data-management.html)

---

## R7. Postgres scale ceiling — the C2 decision, settled with primary sources

**Finding, from the PostgreSQL manual itself** (not a blog):

> *"The query planner is generally able to handle partition hierarchies with up to a few thousand partitions
> fairly well, provided that typical queries allow the query planner to prune all but a small number of
> partitions. Planning times become longer and memory consumption becomes higher when more partitions remain
> after the planner performs partition pruning."*

> *"Another reason to be concerned about having a large number of partitions is that the server's memory
> consumption may grow significantly over time, especially if many sessions touch large numbers of
> partitions. That's because each partition requires its metadata to be loaded into the local memory of each
> session that touches it."*

> *"Sub-partitioning can be useful to further divide partitions … Either of these can easily lead to
> excessive numbers of partitions, so restraint is advisable."*

> *"a rule of thumb is that the size of the table should exceed the physical memory of the database server"*
> before partitioning is worthwhile.

**→ Implication — this resolves C2 in favour of staying Postgres-only, with a written trigger.** The
constraint is *partition count*, not row count: a few thousand partitions is the planner's comfort zone, and
dropping a partition is vastly cheaper than a bulk DELETE (less WAL, no hours-long constraint validation).
A monthly-partitioned adoption edge burns 12 partitions/year — three orders of magnitude inside the ceiling.

The cascade documents' ClickHouse recommendation rests on an explicitly-labelled *estimate* ("tens of
billions of rows if you match BuiltWith-scale coverage"), and `cascade 2.md` itself sets the escape hatch:
*"If the adoption edge table stays under ~1–2 billion rows … skip ClickHouse for this table."* TruePoint has
no BuiltWith-scale crawl fleet and is not going to build one (that is non-goal S-05). **Decision for Phase 3:
Postgres-only, monthly range partitioning, BRIN on the time column. Revisit only when a measured trigger
fires** — recorded in `04-validation.md` as: adoption-edge rows > 1.5B, *or* p95 analytical latency on the
edge exceeds the SLO for two consecutive weeks. No new datastore ships on an estimate.

Sources: [PostgreSQL 18 manual §5.12 Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) · [Severalnines: advanced partitioning strategies](https://severalnines.com/blog/advanced-partitioning-strategies-for-postgresql-oltp-and-analytics-datasets-at-scale/)

---

## R8. Contribution networks — what the incumbents do, and why TruePoint deliberately differs

**Finding.** Apollo operates *"a network of over two million data contributors that share information about
their business contacts,"* fed by users adopting Email Finder / Open Tracker and similar features
`[VENDOR CLAIM]`. In listed jurisdictions — Argentina, Brazil, Canada, India, Mexico, Singapore,
Philippines, South Africa, California, Maryland, Oregon, the EU, the UK and Switzerland — Apollo
*"automatically sends an email notification to every new contact … when it adds them to its database,"*
explaining processing and rights. Independent commentary is blunt that the live objection is not missing
paperwork but *"how specific individuals' contact information entered the database."*

ZoomInfo runs *"a community of business professionals who voluntarily contribute their data in exchange for
platform credits."*

`[COULD NOT VERIFY]` — any public description of how these networks detect or reject *fabricated*
contributions. Searching for contribution-fraud controls returns financial fraud-consortium literature, not
B2B contact co-ops. The pattern that literature does offer and that transfers: **local tokenization before
sharing** — participants compare tokenized identifiers rather than sending raw PII outside their own
environment.

**→ Implication, and a genuine divergence worth stating plainly.** ZoomInfo's credits-for-contribution model
is precisely what CLAUDE.md rule 7 forbids, and the reason is defensible on its own merits, not just
policy: a contribution that earns currency creates an incentive to fabricate, which is outcome **A-03**'s
whole problem. TruePoint's "nothing to farm" property is a *fraud control*, achieved by removing the payoff
rather than by detecting the forgery after the fact — and no incumbent publicly documents a forgery detector,
which suggests removing the incentive is the stronger position.

The tokenization pattern is already TruePoint's: HMAC blind indexes let a contribution be matched against
the graph without the value being revealed, and `master_emails.email_enc` is explicitly nullable so a
match-against mint stores the dedup key with **no revealable value**. That is the co-op-safe primitive
incumbents describe, already shipped.

The notification-on-add obligation is the concrete compliance item to check against
`docs/strategy/09-compliance.md` in Phase 4 — TruePoint has `consent_records` and `dsar_requests`, but
whether a *notification-on-first-storage* flow exists for those jurisdictions is an open audit question.

Sources: [Apollo data overview](https://knowledge.apollo.io/hc/en-us/articles/45824429846669-Apollo-Data-Overview) · [Apollo GDPR processing notice](https://www.apollo.io/privacy-policy/processing-notice) · [Apollo B2B data network](https://www.apollo.io/product/b2b-data) · [Unit21: fraud consortium](https://www.unit21.ai/fraud-aml-dictionary/fraud-consortium)

---

## R9. Profile UX — the gap incumbents leave open

**Finding, and it is the most commercially useful sentence in this document:** comparative review of ZoomInfo
and Apollo reports that **neither vendor surfaces "last verified" timestamps in the standard UI** — users
cannot see when a record was last refreshed. ZoomInfo assigns confidence scores to records, but coverage
quality *"drops sharply"* outside North America.

**→ Implication.** TruePoint's outcome S-10 ("record confidence/verification recency visible at a glance")
and A-01 ("every stored field has provenance and a lawful basis") target a hole the two market leaders leave
open, and the machinery to fill it — `provenance_event`, `provenanceBadgeRepository`, `field_provenance`,
`last_verified_at` — is already built. The four intelligence profiles in Phase 8 should therefore treat
**per-field provenance and freshness as a primary UI element, not a detail drawer**. That is the design
thesis for Phase 8, and it is evidence-backed rather than aesthetic.

Sources: [Cleanlist: 1,000-lead Apollo vs ZoomInfo test](https://www.cleanlist.ai/blog/2026-03-07-apollo-vs-zoominfo) · [Cognism: Apollo vs ZoomInfo data](https://www.cognism.com/blog/apollo-vs-zoominfo) · [BookYourData comparison](https://www.bookyourdata.com/blog/zoominfo-vs-apollo)

---

## R10. Licensing — C4 verified, and it is a real decision

**Finding, confirmed from the repository itself, not a blog:** `enthec/webappanalyzer` is **GPL-3.0**. It
states it *"is a continuation of the iconic Wappalyzer that went private in August 2023,"* and its
maintainers commit to keeping it public and preserving the JSON structure. Each technology definition
carries: required `cats` (category IDs) and `website`; optional `description`, `icon`, `cpe`, `saas`, `oss`,
`pricing`; detection patterns across `cookies`, `dom`, `dns`, `js`, `headers`, `text`, `css`, `meta`,
`scripts`, `urls`; and relationship fields `implies`, `requires`, `excludes`, `requiresCategory`.

**→ Implication.** `cascade 2.md`'s claim is accurate and its warning stands. The field set is genuinely a
ready-made catalog schema — `implies`/`requires`/`excludes` in particular give the technology-stack
relationship graph the brief's Technology Profile asks for, for free. But TruePoint ships `apps/extension`,
a **distributed artifact**, so the copyleft question is live and cannot be waved off with "we're SaaS."

**Three options for the human decision (C4), in preference order:**
1. **Use the taxonomy shape, not the data.** Model the catalog on those field names (field names are not
   copyrightable) and populate from licensed/public sources. No copyleft exposure. Slowest to seed.
2. **Server-side only, never in the extension bundle.** Catalog lives in Postgres, reached by API; the
   extension ships no fingerprint data. Materially reduces but does not formally eliminate the question.
3. **Embed in the distributed extension.** Requires GPL-3.0-licensing the derivative work. Almost certainly
   unacceptable for a commercial product.

**Recommendation: option 1.** It gets the schema benefit — which is the part that matters — with zero legal
exposure, and it is consistent with `cascade 2.md`'s own fallback ("treat enthec purely as a seed reference").

Sources: [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer)

---

## Research decisions carried into Phase 3

| ID | Decision | Basis | Status |
|---|---|---|---|
| RD-1 | Catalog + dated adoption edge, replacing the `technographics` jsonb blob | R1, market convergence | Ready |
| RD-2 | Confidence = recency × corroboration × source weight, decay half-life **per (field, source_type)** | R1, R4 | Ready |
| RD-3 | Products modeled as a specialization of the technology catalog, not a parallel hierarchy | R2 (no established pattern) | **Needs human confirm — reinterprets the brief** |
| RD-4 | Canonical Layer-0 signal store, extensible type vocabulary, covering signal families 1–4 and 6; family 5 (intent) stays out per X-04 | R3 | Ready — resolves C5 |
| RD-5 | **Postgres-only.** Monthly range partitioning + BRIN. No ClickHouse/Citus/Kafka. Written revisit trigger. | R7, primary source | **Resolves C2** |
| RD-6 | Probabilistic ER tier = bounded offline job over blocked candidates; no Spark, no Splink runtime | R5 | Ready |
| RD-7 | Technology catalog schema modeled on enthec's field shape; data seeded from licensed/public sources only | R10 | **Recommendation for C4 — needs human sign-off** |
| RD-8 | Provenance + freshness as primary UI elements in all four profiles | R9, competitor gap | Ready |
| RD-9 | Keep the no-earned-currency rule; it is the A-03 fraud control, not merely policy | R8 | Confirmed |

## Still open after v1

- Notification-on-first-storage obligation vs. TruePoint's current consent flow — audit question for Phase 2 v2.
- Whether completeness should join the survivorship fold (R6).
- Provider field-level schemas remain `[COULD NOT VERIFY]`; if precise parity matters, it needs a vendor
  conversation, not more searching.
