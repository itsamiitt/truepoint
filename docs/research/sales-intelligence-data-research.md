# The Data Side of Sales Intelligence — Founder's Research Brief

> Tailored to: an **end-to-end B2B prospecting CRM** (find → reveal verified email/phone on credits → score →
> sequence → send), **compliance-first**, **per-workspace data ownership**, **US-first** with EU on the
> roadmap, **deciding build-vs-buy**. Compiled 2026-06-02.

## How to read this (epistemic legend — read first)

This brief blends a fact-checked research pass with domain synthesis. Every claim is tagged:

- **✅ Verified** — survived adversarial multi-agent verification this run; primary/strong source cited.
- **📄 Sourced (directional)** — a real source was found, but the *specific figure* did not pass the strict
  verifier (often because the agent abstained, not because it's false). Treat as directional; verify before betting on it.
- **🧭 Domain** — standard industry practice / my synthesis (knowledge cutoff Jan 2026), not independently
  re-verified this run.
- **⚠️ Do not rely** — a specific claim that was **refuted** or could not be confirmed; flagged so you don't repeat it.

**What the research could and couldn't confirm:** strongest on US data-broker law (CA Delete Act/DROP),
entity-resolution tooling (Zingg, Splink), the build-vs-buy/waterfall model (Clay), and scraping case law
(hiQ/CFAA). **Weak/unconfirmed:** all specific provider *pricing*, provider *accuracy benchmarks*, and *data-decay
percentages* — these were refuted or abstained in verification, so I give them as directional ranges with explicit
caveats. **Do not quote exact pricing or accuracy percentages as fact without checking the vendor directly.**

---

## 1. Data Acquisition — how you actually get the data

**Summary.** There are seven legitimate ways to source sales-intelligence data; you will use a *blend*, but as a
funded-but-early startup you should **license/aggregate, not build a proprietary dataset**. Building your own data
layer means solving a cold-start contributory-network problem + scraping infrastructure + a massive,
never-ending verification bill — the thing incumbents spent a decade and hundreds of millions on. The pragmatic
modern pattern is **multi-provider "waterfall" enrichment**: query several providers in sequence until you get a
valid match, maximizing coverage without owning the data. **✅ Verified:** Clay productizes exactly this —
a marketplace aggregating *150+ providers* (vendor-stated) with sequential waterfall enrichment to lift fill rates
([clay.com](https://www.clay.com/), [waterfall](https://www.clay.com/waterfall-enrichment),
[Cleanlist review](https://www.cleanlist.ai/blog/clay-data-enrichment-review)).

**The seven sourcing methods**

| Method | What it is | Reality for you |
|---|---|---|
| **Licensed providers** | Pay a vendor's API/seat for their data | 🧭 Your default. Fastest, lowest legal risk, no infra |
| **Contributory / co-op networks** | Users sync their inbox/CRM; the pool grows from everyone's data | 🧭 How Apollo/ZoomInfo/Cognism/PDL actually *built* their data. Powerful flywheel but raises privacy questions (your users' contacts feed the pool — disclose it) |
| **Web scraping** | Crawl public web / LinkedIn | 🧭 High ToS + legal risk (see §2). You explicitly chose **not** to scrape — good |
| **Public records** | Gov/registry data | 🧭 Free firmographics: SEC EDGAR, Companies House (UK), OpenCorporates, Crunchbase (licensed), gov business registries |
| **Partnerships / data licensing** | Buy/resell another firm's dataset | 🧭 Used for niche coverage (e.g., a regional or technographic set) |
| **First-party signals** | Your own product/website telemetry | 🧭 Website de-anonymization (reverse-IP), product usage, form fills — increasingly the highest-trust intent source |
| **User-contributed** | CSV uploads, CRM sync into the workspace | 🧭 Your per-workspace model already does this; it's also the seed of a future co-op |

**The four data categories and where each comes from** (🧭 unless noted):

| Category | What it covers | Typical sources / vendors |
|---|---|---|
| **Firmographic** | Company size, industry, revenue, location, hierarchy | Registries, Crunchbase, Clearbit/Breeze, ZoomInfo, People Data Labs, Coresignal |
| **Technographic** | What tech a company runs | **BuiltWith, Wappalyzer, HG Insights, Datanyze, 6sense** — detected from site code, DNS, job posts, ad pixels ([ZoomInfo overview](https://pipeline.zoominfo.com/sales/b2b-technographic-data-providers)) |
| **Contact (email/phone)** | Work email, direct dial, mobile | Providers (Apollo/ZoomInfo/Lusha/Cognism) + pattern-inference + **verification** (§3) + contributory data |
| **Intent / buying signals** | Who's in-market now | **Bombora** (co-op of B2B publishers — the category standard), **G2** buyer intent, **6sense**, website de-anon, job-change/funding/hiring signals ([intent providers overview](https://salesmotion.io/blog/intent-data-providers)) |

**Provider landscape (build-vs-buy candidates).** Coverage/accuracy/price are **directional** — vendor pricing
is opaque and negotiated:

| Provider | Niche | Pricing posture (📄 directional) | Trade-off |
|---|---|---|---|
| **Apollo.io** | All-in-one, PLG, huge DB, contributory | Cheap, self-serve, ~low-$/seat tiers | Breadth + price; accuracy lower than premium ⚠️ |
| **ZoomInfo** | Premium depth, intent (Bombora), enterprise | Opaque annual contracts, high 5-figures+ ⚠️ | Best coverage/depth; cost, lock-in, contracts |
| **Clearbit → HubSpot Breeze** | Enrichment-as-feature | Credits inside HubSpot | Great if HubSpot-centric; less standalone |
| **People Data Labs (PDL)** | Raw person/company *data API* to build on | Volume/API pricing | Build-your-own-layer enabler; you do the app |
| **Coresignal** | Firmographic / job-postings / employee data API | Volume/API pricing | Strong company intel; ⚠️ PDL-vs-Coresignal size claims unconfirmed |
| **Lusha** | LinkedIn extension, EU contacts | Per-seat/credits | Easy; lighter coverage |
| **Cognism** | Compliance-first, EU phone ("Diamond") | Per-seat, fuller credits | Best EU/GDPR posture; ⚠️ specific Diamond phone connect-rate claims were **refuted** — don't quote them |

> **⚠️ Do not rely:** the widely-circulated figures "ZoomInfo $25–40k/yr, Apollo $3.5–9k/yr, Clearbit $10–20k/yr
> for a 5-person team" and the "ZoomInfo 85% / Apollo 80% email accuracy" benchmark
> ([Cleanlist 2026](https://www.cleanlist.ai/blog/zoominfo-apollo-clearbit-data-provider-comparison-2026))
> **did not pass verification.** Use them only as a rough order of magnitude and confirm with each vendor.

**Beginner pitfalls.** (1) Trying to **build your own data layer** before you have distribution — you'll burn
runway on a cold-start problem. (2) Assuming **one provider covers everything** — coverage is patchy; waterfall
across 2–3. (3) Forgetting that **contributory networks mean your users' synced contacts feed the pool** — that's
a privacy disclosure you must make. (4) Optimizing for **coverage over accuracy** — high fill rate with 20% bounces
destroys trust (and, for your model, sender reputation).

---

## 2. Legal & Compliance — collecting *and selling* B2B contact data

**Summary.** This is the area where the research is strongest and where a beginner most underestimates risk. The
load-bearing fact: **if you sell/broker contact data on California residents, you are likely a "data broker" and
must comply with the Delete Act on a live, dated timeline.** B2B is **not** exempt from the major privacy laws
anymore. Build compliance infrastructure **day one** — it cannot be retrofitted into a data product.

**✅ Verified — California Delete Act (SB 362, 2023) & DROP.** California created **DROP**, a single-request
deletion platform covering **500+ registered data brokers**. Brokers must **register annually** with the CPPA
(California Privacy Protection Agency), report categories of data collected/shared, process DROP deletion requests,
and undergo audits. Timeline: DROP opened to consumers **Jan 1, 2026**; brokers must **begin processing DROP
deletions Aug 1, 2026**; third-party audits begin **Jan 1, 2028** (every 3 yrs). 2026 registration fee ≈ **$6,000**;
penalties ≈ **$200/deletion-request/day** for non-compliance.
Sources: [privacy.ca.gov/drop](https://privacy.ca.gov/drop/about-drop-and-the-delete-act/),
[cppa.ca.gov/data_brokers](https://cppa.ca.gov/data_brokers/), SB 362 (leginfo). **This very likely applies to your
product** — treat data-broker registration as a go-to-market gate.

**The rest of the map** (🧭 / 📄):

- **GDPR (EU) — 🧭/📄.** B2B prospecting generally relies on **legitimate interest** (Art. 6(1)(f)) *with a
  documented Legitimate Interest Assessment/balancing test* and a transparency notice — **not** blanket consent.
  But **ePrivacy** rules in several member states require **consent to send** marketing email to individuals;
  role/corporate addresses are treated more leniently in some countries. Right to **object** → immediate
  suppression. ([litemail GDPR legitimate-interest guide, 2026](https://litemail.ai/blog/gdpr-legitimate-interest-cold-email-2026) — directional.)
- **CCPA/CPRA + US state laws — 🧭.** The **B2B exemption sunset (Jan 2023)** — business contacts now have full
  rights. Must honor **opt-out of "sale/sharing"** (and "sale" is defined broadly), respect **Global Privacy
  Control** signals, and post the required notices. ~20 US states now have comprehensive laws; several add
  **data-broker registration** (e.g., Texas, Oregon, Vermont) beyond California.
- **CAN-SPAM (US email) — 🧭.** No opt-in required, but: truthful headers/subject, a valid **physical postal
  address**, and a **working unsubscribe honored within 10 days.** (Your send engine already injects these.)
- **CASL (Canada) — 📄.** Much stricter: **opt-in (express or implied consent) required** to email; large
  penalties. ([litemail CASL guide, 2026](https://litemail.ai/blog/casl-cold-email-canada-guide-2026) — directional.)
- **Others — 🧭.** UK GDPR + PECR; Australia Spam Act + Privacy Act; treat each new region as its own legal review.

**Scraping legality — ✅ partially settled, still risky.** The US Ninth Circuit (reaffirmed **April 18, 2022**
after SCOTUS vacated/remanded *hiQ v. LinkedIn* on **June 14, 2021** in light of *Van Buren*) held that **scraping
publicly accessible data that doesn't require an account does *not* violate the CFAA**. BUT this was a
*preliminary-injunction-stage* ruling, and the case later **settled (Dec 2022) on breach-of-contract / ToS and
fake-account grounds** — so **scraping behind a login or against a site's ToS remains legally risky** (breach of
contract, trespass to chattels). Sources:
[CA9 opinion 17-16783](https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf),
[Van Buren](https://www.supremecourt.gov/), [hiQ summary](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn).
*(⚠️ The widely-cited **Meta v. Bright Data** "logged-out scraping is fine" framing could not be verified this run —
treat the scraping-ToS area as unsettled.)* **Since you integrate providers rather than scrape, you mostly inherit
this risk through your vendors** — so vet each provider's sourcing and require contractual reps/DPAs.

**Compliance infrastructure you need on day one** (🧭 — and which your design already includes):
suppression/Do-Not-Contact list that **gates both reveal and send**; **DSAR** intake + fulfillment (access /
delete / rectify) with fan-out across all copies; **consent / lawful-basis records** per subject × jurisdiction;
**sub-processor list + signed DPAs** with every data vendor; **append-only audit log**; public **privacy notice**;
**GPC/opt-out** handling; and **data-broker registration** where applicable.

**Beginner pitfalls.** (1) Believing **"B2B data is exempt"** — false under CPRA and (mostly) GDPR. (2) Assuming
**CAN-SPAM's permissiveness applies globally** — CASL/GDPR are opt-in/consent regimes. (3) **Not realizing you're a
"data broker"** and missing CA registration / DROP. (4) Treating compliance as a **later feature** — DSAR-deletion
and provenance must be in the schema from the first migration, or you can't prove deletion.

---

## 3. Data Verification & Accuracy

**Summary.** Verification is the moat for a "you only pay for verified data" product. Email verification is a
well-understood pipeline; phone and title verification are harder and partly manual. **The dirty secret: vendor
"95–99% accuracy" claims are marketing** — independent tests come in lower and vary by segment. Measure it yourself.

**How email verification works (🧭):** syntax check → **MX record** lookup → **SMTP handshake** (`RCPT TO` without
sending) → **catch-all** detection (domain accepts everything → "accept-all/risky") → role-based (`info@`,
`sales@`) and **disposable-domain** detection → result: `valid / invalid / risky / catch-all / unknown`. Done in
real time at reveal/send. **Phone (🧭):** `libphonenumber` for format/region → **line-type/carrier lookup**
(Twilio Lookup, Telnyx) → for "direct/mobile" confidence, providers add **human/manual verification** (e.g.,
Cognism "Diamond"; ⚠️ but the specific connect-rate numbers were **refuted** — don't cite them). **Title (🧭):**
multi-source corroboration + **recency/job-change signals** + confidence scoring.

**Verification vendors (📄 — names solid, prices directional):** **ZeroBounce, NeverBounce, Kickbox, Bouncer,
MillionVerifier, Emailable, Debounce.** Pricing is typically **~$0.001–0.01 per verification**, volume-tiered
(bulk lands ~$0.004 or below). ([instantly.ai 2026 verification benchmark](https://instantly.ai/blog/2026-email-verification-benchmark-accuracy-scores-for-8-top-tools/),
[mailvalid cost 2026](https://mailvalid.io/blog/the-real-cost-of-email-verification-in-2026),
[Cleanlist glossary](https://www.cleanlist.ai/glossary/email-verification) — all directional; ⚠️ the specific
per-tool accuracy scores did not pass verification).

**Measuring & reporting accuracy (🧭):** track **bounce rate** (sends), **valid-rate** (verifications),
**connect rate** (phones); report a **verified status + last-verified date** per field. Don't claim a single
headline accuracy number; show *status honestly* (your `email_status` model is the right approach).

**Data decay (⚠️ industry-lore, unverified):** the most-repeated figures are **"~30% of B2B contact data decays per
year"** / "~2–3%/month" / "70% over 3 years." These are *widely cited but were not independently verifiable this
run* (the Cognism "re-verify 95% of senior contacts every 30 days" claim was **refuted**). Treat decay as **real
and significant but un-benchmarked** — and **re-verify at point of use** rather than trusting any stored "fresh"
flag. Keep fresh via: verify-on-reveal, scheduled re-verification jobs, **bounce/complaint feedback loops** (auto-
suppress + re-check), and **job-change detection**.

**Beginner pitfalls.** (1) **Trusting provider accuracy claims** instead of measuring bounces on your own sends.
(2) Running **SMTP verification from your own IPs** at volume → getting blocklisted (use a vendor). (3) Treating
**catch-all domains as "valid"** → false confidence + bounces. (4) Verifying **once at import** and never again —
decay makes that worthless; verify at reveal/send.

---

## 4. Data Management & Architecture

**Summary.** Two hard problems: (a) **entity resolution** (is this one person or three? one company or five?
across messy multi-source data with no shared key), and (b) **continuous update at scale**. Use a transactional DB
for the app and an analytical warehouse for batch resolution/analytics; adopt a proven ER library rather than
hand-rolling fuzzy matching.

**Entity resolution & dedup — ✅ Verified tools:**
- **Zingg** (AGPL-3.0) — ML entity resolution via **active learning**: a **blocking model** clusters near-similar
  records (avoiding O(n²) — down to ~0.05–1% of comparisons) + a **similarity classifier** for fuzzy matches;
  trains on small samples. ([github.com/zinggAI/zingg](https://github.com/zinggAI/zingg)).
- **Splink** (MIT, maintained by the **UK Ministry of Justice**) — **probabilistic record linkage**
  (Fellegi-Sunter); links **~1M records on a laptop in ~1 min** (DuckDB) and **100M+** on Spark/Athena.
  ([github.com/moj-analytical-services/splink](https://github.com/moj-analytical-services/splink)).
- 🧭 Also: **Senzing** (commercial, real-time ER), **dbt** (transforms/tests), `recordlinkage`/`dedupe` (Python).
  Splink's MIT license makes it the friendlier default; Zingg if you want batteries-included ML + MDM.

**Storage / warehouse (🧭):** transactional **PostgreSQL** for the live app (your Aurora choice fits); an
analytical **warehouse** for entity-resolution batch jobs and reporting — **Snowflake / BigQuery** (managed,
elastic) or **ClickHouse** (fast, cheap for event/intent analytics; your event layer). For 100M+ rows: partition
by time/tenant, columnar analytics offload, blind-indexes for encrypted-PII uniqueness.

**ETL/ELT (📄 — choices solid, comparison source flagged):** **Fivetran** (managed, lowest-maintenance, priced by
Monthly Active Rows → can get expensive), **Airbyte** (open-source/cloud, cheaper, more ops), **dbt** (the
transformation/ELT standard), **Meltano**. ([weld fivetran-vs-airbyte](https://weld.app/blog/fivetran-vs-airbyte-2025)
— flagged low-reliability; verify pricing directly.)

**Beginner pitfalls.** (1) **Hand-rolling fuzzy matching** → duplicate explosion + false merges; use Splink/Zingg.
(2) Maintaining a single global **"golden record"** when **per-workspace copies** are simpler and avoid
cross-customer merge bugs (your ADR already chose this). (3) **No provenance** → can't fulfill DSAR-deletion or
explain a field. (4) Putting analytics load on the transactional DB → both suffer.

---

## 5. Advanced Technologies (AI/ML) — table-stakes vs. differentiating in 2026

**Summary.** AI is now woven through the stack, but most of it is table-stakes. The genuine 2026 edge is **agentic,
signal-driven research and orchestration** — not "an AI that sends emails for you" (that's facing a deliverability
and trust backlash).

- **✅ Verified differentiator — agentic research.** Clay's **Claygent** = reusable, versioned AI agents that
  research the web and orchestrate workflows, connectable to external context (Salesforce, Gong, Docs) via **MCP**.
  ([clay.com/claygent](https://www.clay.com/claygent)). This "agent researches each account" pattern is where the
  category is heading.
- 🧭 **Lead scoring** — fit (logistic regression / gradient-boosted trees on firmographic + technographic) +
  intent + engagement → composite. ([warmly AI lead scoring](https://www.warmly.ai/p/blog/ai-lead-scoring)).
- 🧭 **LLM-based extraction/enrichment** — parse unstructured web/job-posts/news into structured fields; powerful
  but **must be verified** (LLMs hallucinate values).
- 📄 **AI SDRs** — autonomous prospecting agents are a hot 2026 category but face **"AI slop"/deliverability
  backlash**; the defensible posture is **augmented-human** (AI drafts, human approves).
  ([mutinyhq AI sales agents 2026](https://www.mutinyhq.com/blog/ai-sales-agents-the-2026-category-guide)).

**Table-stakes (2026):** AI email drafting, basic lead scoring, NL search, enrichment. **Differentiating:**
agentic per-account research, real-time **signal/trigger**-based selling, waterfall orchestration, reliable
LLM extraction-with-verification, and an **augmented-human** stance.

**Beginner pitfalls.** (1) Shipping an **autonomous AI SDR** and torching deliverability/brand. (2) **Lead scoring
with no ground-truth labels** (no closed-won data) → noise. (3) Trusting **LLM-extracted fields without
verification** → confident wrong data. (4) Believing AI fixes data quality — it **amplifies** whatever you feed it.

---

## 6. Integrations

**Summary.** Buyers expect you to push clean data **into the tools they already live in.** CRM sync (Salesforce +
HubSpot first) is table-stakes; the fast way to ship breadth is a **unified-API / embedded-iPaaS** layer rather
than hand-building each connector.

**What to support (🧭, priority order):** **Salesforce + HubSpot** (must-have) → **Pipedrive** → sales-engagement
(**Outreach, Salesloft**) → conversation (**Gong/Chorus**) → **Slack** → for enterprise, **data warehouse +
reverse-ETL** (**Census, Hightouch** push warehouse data to CRMs) → CSV/Zapier.

**How to build it (📄):** your own **REST API + webhooks** (e.g., `reveal.completed`, `import.completed`) +
OpenAPI + OAuth. To avoid building N CRM connectors, use an **embedded integration platform**: **Merge.dev**
(one unified API across many CRMs/HRIS/etc.), **Paragon**, **Tray.io**, **Workato**.
([Merge vs Paragon](https://www.merge.dev/vs/paragon)). Merge gets you "we integrate with your CRM" in weeks, not quarters.

**Buyers expect out of the box:** bi-directional sync, **field mapping (no-code)**, dedup-on-write, scheduled +
real-time, and clear conflict handling.

**Beginner pitfalls.** (1) **Hand-building each CRM integration** — start with a unified API. (2) **One-way push
with no conflict handling** → overwrites customer data, churns trust. (3) Ignoring **Salesforce/HubSpot API rate
limits** and per-call costs. (4) **No dedup on write** → you create duplicates in the customer's CRM (the exact
problem they hired you to solve).

---

## 7. Full Automation — the self-running data lifecycle

**Summary.** Automate the loop **acquire → clean/normalize → enrich (waterfall) → verify → entity-resolve/dedup →
score → deliver (CRM/API/export)** as event-driven + scheduled jobs with strict cost/idempotency controls.

**Orchestration options (📄):** **Airflow** (mature, batch, heavy), **Dagster** (modern, asset/data-aware),
**Prefect** (pythonic, dynamic), **Temporal** (durable, long-running per-entity workflows with built-in retries —
excellent fit for enrichment/reveal pipelines), plus job **queues** (**BullMQ/Redis**, **SQS**, **Kafka** for
streams). ([Dagster vs Prefect vs Airflow 2026](https://www.getorchestra.io/blog/dagster-vs-prefect-vs-airflow-complete-data-orchestration-comparison-2026)).
🧭 Your current **BullMQ workers** are right for job-level work now; reach for **Temporal or Dagster** only when
multi-step, long-running, retry-heavy pipelines outgrow simple queues.

**Architecture must-haves (🧭):** **idempotent** jobs (no double-charge), **provider response caching** (never pay
twice — keyed on a normalized request hash), **per-provider rate limits + circuit breakers + daily cost budgets**,
**dead-letter queues + retries with backoff**, **CDC** for search/warehouse sync, and end-to-end observability/cost
dashboards.

**Beginner pitfalls.** (1) **No idempotency** → double-charging credits / duplicate work on retry. (2) **No
provider caching** → cost blowout. (3) **Synchronous enrichment** blocking the UI — make it async with progress.
(4) **No DLQ/alerting** → silent pipeline failures you discover via customer complaints.

---

## 8. Tools & Vendor Landscape (master list by layer)

> Pricing tiers are **directional (📄/🧭)** — vendor pricing is opaque/negotiated; confirm directly.

| Layer | Vendors | Rough tier | When to use |
|---|---|---|---|
| **Aggregator / waterfall** | **Clay** ✅, Clearbit/Breeze | ~$149–800+/mo + enterprise (📄) | Start here — buy coverage without building |
| **All-in-one provider** | **Apollo** (cheap/PLG), **ZoomInfo** (premium) | Apollo low; ZoomInfo high 5-fig+ (⚠️ unverified) | Apollo for breadth+price; ZoomInfo for depth/intent |
| **Raw data API (build-your-own)** | **People Data Labs**, **Coresignal** | Volume/API | If you want to own the data layer later |
| **EU / compliance-first** | **Cognism**, **Lusha** | Per-seat | EU phone + GDPR posture |
| **Technographic** | **BuiltWith, HG Insights, Wappalyzer, Datanyze** | Varies | Tech-stack targeting |
| **Intent** | **Bombora** (co-op), **G2**, **6sense** | Mid–high | In-market signals |
| **Email verification** | **ZeroBounce, NeverBounce, Kickbox, Bouncer, MillionVerifier** | ~$0.001–0.01/verify (📄) | Verify-on-reveal/send |
| **Phone validation** | **Twilio Lookup, Telnyx** | Per-lookup | Line type / carrier |
| **Entity resolution** | **Splink** (MIT) ✅, **Zingg** (AGPL) ✅, **Senzing** (commercial) | OSS free / commercial | Dedup people + companies |
| **ETL/ELT** | **Fivetran** (managed), **Airbyte** (OSS), **dbt** (transform) | Fivetran by MAR; Airbyte cheaper (📄) | Move + transform source data |
| **Warehouse / DB** | **Postgres** (app), **Snowflake/BigQuery** (analytics), **ClickHouse** (events) | Usage-based | App vs analytics split |
| **Reverse-ETL** | **Census, Hightouch** | Mid | Push warehouse → CRM (enterprise) |
| **Embedded integrations** | **Merge.dev**, **Paragon**, **Tray**, **Workato** | Mid–high | Ship many CRM integrations fast |
| **Orchestration** | **BullMQ** (now), **Temporal, Dagster, Prefect, Airflow** | OSS / cloud | Self-running pipeline |
| **Agentic / AI** | **Clay/Claygent** ✅, LLM APIs (Anthropic/OpenAI) | Usage | Per-account research, extraction |

---

## Prioritized Roadmap — which data decisions to make first

Ordered by *dependency + risk*, not by what's fun to build.

1. **Compliance baseline (do this first — it's legally required and un-retrofittable).** Suppression gating
   reveal+send, DSAR (access/delete/rectify) with provenance to prove deletion, consent/lawful-basis records,
   sub-processor list + DPAs, audit log, privacy notice, GPC/opt-out. **And determine data-broker registration
   applicability now** — CA Delete Act/DROP is live with broker processing from **Aug 1, 2026** (✅). *Rationale:
   legal exposure + it gates go-to-market; the schema must carry provenance from migration #1.*

2. **Build-vs-buy: choose BUY + waterfall (don't build a data layer).** *Rationale:* a proprietary dataset is a
   cold-start, capital-intensive trap; waterfall enrichment (✅ Clay-proven) gives coverage now. Revisit
   building-your-own (via PDL/Coresignal + a contributory loop) only after product-market fit.

3. **Pick the first provider(s) + a verification vendor.** Start with **one broad, API-first, affordable source**
   (Apollo or a raw API like PDL) + **one email-verification vendor** (ZeroBounce/NeverBounce) to power
   **verify-on-reveal** (your "pay only for valid data" differentiator). Add a 2nd/3rd provider as a waterfall later.
   *Rationale:* unblocks the core reveal loop; verification is your trust wedge.

4. **Storage + entity-resolution strategy.** Postgres app DB with **per-workspace copies** (no global golden
   record); choose **Splink** (MIT) for dedup when volume warrants; add an analytics warehouse/ClickHouse only when
   reporting/intent volume demands it. *Rationale:* avoids the hardest distributed-merge bugs early.

5. **Integrations via a unified API.** Ship Salesforce + HubSpot sync through **Merge.dev** rather than hand-built
   connectors; expose your own REST API + webhooks. *Rationale:* buyers expect CRM sync; unified API is the fastest credible path.

6. **Automation hardening.** Idempotency, provider caching, rate limits/circuit breakers, cost budgets, DLQs on
   your existing **BullMQ** workers; graduate to **Temporal/Dagster** only if pipelines get long-running/complex.

7. **Advanced AI last.** Lead scoring (once you have closed-won labels), agentic per-account research, LLM
   extraction-with-verification, augmented-human (not autonomous) drafting. *Rationale:* AI amplifies data quality —
   build the clean, verified foundation first.

---

## Sources & verification notes

**✅ High-confidence (verified this run):** CA Delete Act/DROP
([privacy.ca.gov](https://privacy.ca.gov/drop/about-drop-and-the-delete-act/),
[cppa.ca.gov](https://cppa.ca.gov/data_brokers/)); Zingg
([github](https://github.com/zinggAI/zingg)); Splink
([github](https://github.com/moj-analytical-services/splink)); Clay marketplace + waterfall
([clay.com](https://www.clay.com/), [waterfall](https://www.clay.com/waterfall-enrichment)); Claygent
([clay.com/claygent](https://www.clay.com/claygent)); hiQ/CFAA scraping
([CA9 opinion](https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf)).

**📄 Directional sources found (specific figures NOT independently verified):**
[Cleanlist provider comparison](https://www.cleanlist.ai/blog/zoominfo-apollo-clearbit-data-provider-comparison-2026),
[Crustdata PDL vs Coresignal](https://crustdata.com/blog/coresignal-vs-peopledatalabs),
[salesmotion intent providers](https://salesmotion.io/blog/intent-data-providers),
[ZoomInfo technographic](https://pipeline.zoominfo.com/sales/b2b-technographic-data-providers),
[litemail GDPR LI](https://litemail.ai/blog/gdpr-legitimate-interest-cold-email-2026),
[litemail CASL](https://litemail.ai/blog/casl-cold-email-canada-guide-2026),
[instantly.ai verification benchmark](https://instantly.ai/blog/2026-email-verification-benchmark-accuracy-scores-for-8-top-tools/),
[mailvalid cost](https://mailvalid.io/blog/the-real-cost-of-email-verification-in-2026),
[cognism data decay](https://www.cognism.com/blog/data-decay),
[Merge vs Paragon](https://www.merge.dev/vs/paragon),
[Dagster/Prefect/Airflow](https://www.getorchestra.io/blog/dagster-vs-prefect-vs-airflow-complete-data-orchestration-comparison-2026),
[warmly AI lead scoring](https://www.warmly.ai/p/blog/ai-lead-scoring),
[mutinyhq AI sales agents](https://www.mutinyhq.com/blog/ai-sales-agents-the-2026-category-guide).

**⚠️ Refuted / could-not-verify (do NOT rely on):** specific provider pricing (ZoomInfo/Apollo/Clearbit per-team
$ figures); provider email/phone accuracy benchmarks (the "85%/80%" test); Cognism Diamond phone connect-rate
("3x / 45%"); Cognism "re-verify 95% of senior contacts every 30 days"; the precise data-decay percentage; the
*Meta v. Bright Data* logged-out-scraping framing; PDL-vs-Coresignal dataset-size claims. **Verify these
first-hand before making a decision that depends on them.**

> **Method note.** Produced by a fan-out research workflow (5 angles → 26 sources → 113 claims → 25 adversarially
> verified → 7 confirmed) plus domain synthesis. The verifier was deliberately strict and several verifier agents
> errored (abstained), so confirmed findings are narrow but trustworthy; everything tagged 📄/🧭 is sound industry
> practice but should be confirmed against primary/vendor sources before you commit budget.
