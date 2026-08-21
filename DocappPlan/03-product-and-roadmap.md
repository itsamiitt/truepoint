# 03 — Product & Roadmap

## The build order (and why this order)

Sell first, build second. Each phase generates revenue that funds the next, and each phase reuses assets we already have. We never spend months building before a customer pays.

---

## Phase 1 — Sell flat files (Months 0–4)

**Goal:** first paying customers with almost no new engineering.

**What we ship:**
- 2–3 packaged datasets from our existing pipeline. Start with what we already produce, for example:
  - *US CPA/accounting firms* (we already defined this ICP: geography, size, revenue, decision-maker titles).
  - One more vertical chosen from customer conversations (e.g., US MSPs/IT services, or funded SaaS 11–200 employees).
- Each dataset: company record + 1–3 verified decision-maker contacts, monthly refresh, delivered as CSV + JSON.
- A simple landing page per dataset: field list, sample of 25 rows, price, buy button (Stripe/Razorpay).

**Quality promise (our differentiator):** every row passes our QC funnel (procured → QC → qualified → packaged). We publish our packaging/quality percentage. We offer credit-back for any bounced email above an agreed threshold (e.g., >5%). Nobody cheap does this; it is why we can charge more than list brokers.

**Pricing:** $500–$2,000 per dataset per month depending on size and refresh rate (details in file 05).

**Success criteria to move on:** 5–10 paying dataset customers OR $3k+ MRR OR clear demand signals for API access from prospects.

---

## Phase 2 — Launch the API (Months 3–8)

**Goal:** recurring usage revenue; become "infrastructure."

**What we ship:**
1. **`/person/enrich`** — input: email OR LinkedIn URL OR name+company. Output: full person record. Waterfall behind it: our own DB (cache) → Crustdata → Sales Nav fallback → other sources. Cache-first means every purchased record becomes an asset.
2. **`/company/enrich`** — input: domain or name. Output: firmographics, headcount, funding, tech hints. Company identification/matching is **free** (near-zero credits) — developers call it constantly, and charging for it poisons the developer experience.
3. **`/search`** — filter-based people & company search over our growing database.
4. **API keys, credit metering, usage dashboard, Stripe billing.** Metering must be correct from day one — billing bugs destroy trust instantly.
5. **MCP server** — one-line install so any Claude/agent builder can use us as a tool. Cheap to build, disproportionate distribution value, and it puts us in agent tool directories early.
6. **Docs** — a public docs site with copy-paste curl examples. Docs are our sales team.

**Engineering shape (lean):** API gateway + auth/metering service, Postgres for the entity store, Redis for cache/rate limits, a queue for waterfall jobs, webhook sender. Our Hono/Bun performance work applies directly here — low latency is a selling point for agent workloads.

**Success criteria:** 15+ active API customers, $8–12k MRR, cache hit rate above 30%.

---

## Phase 3 — Own the supply (Months 6–18, overlaps Phase 2)

**Goal:** shift the data we sell from "bought" to "owned." This is the margin and moat phase. Full detail in file 04.

**What we ship:**
1. **Contributor network v1** inside Truepoint + the Chrome extension: users share verified signature/contact data and CRM-observed corrections; they earn credits. Give-to-get.
2. **First-party crawlers**, in this order:
   - Company websites (team pages, about pages) — refresh firmographics.
   - Job boards + career pages — hiring signals (the highest-value signal for sales tools).
   - Funding announcements + press — funding signals.
   - **India: MCA registry, Indian job portals, Indian startup news** — the APAC coverage wedge.
3. **Verification layer:** email verification (SMTP-level checks + pattern inference), cross-source agreement scoring, human QC sampling. Every record gets a confidence score customers can see.

**Success criteria:** by month 12, 40%+ of delivered records come from cache/contributed/crawled sources (not paid vendor calls). By month 18, 60%+.

---

## Phase 4 — Win the agent market (Months 9–24)

**Goal:** differentiation and lock-in with the fastest-growing buyer segment.

**What we ship:**
1. **Watchers API** — webhook subscriptions on conditions: job change of a tracked person, headcount growth over X%, first hire in a department, new funding, job posts matching keywords. Watchers replace polling, save customers credits, and are painful to switch away from.
2. **Signals feed** — a daily/streaming feed of change events for a customer's tracked universe.
3. **Agent-native features:** structured JSON schemas designed for LLM consumption, batch endpoints, an MCP tool set covering search + enrich + watch.
4. **APAC data pack** — productized India/SEA coverage as a named differentiator ("the freshest India B2B data available by API").

**Success criteria:** watchers/signals reach 25%+ of revenue; at least 2 OEM contracts; NRR (net revenue retention — how much last year's customers pay this year) above 110%.

---

## Product principles (apply to every phase)

1. **Charge only when data is returned.** No-match = no charge. This one policy wins deals against incumbents.
2. **Cache everything, refresh smartly.** Refresh on access if older than N days; refresh proactively for watched entities.
3. **Expose confidence, never fake certainty.** A record with a confidence score is more valuable than a guess presented as fact.
4. **Latency is a feature.** Agent workloads are chained calls; every 100ms matters.
5. **The dashboard exists to show usage and spend clearly** — not to become a prospecting tool. If customers ask for UI workflows, that demand belongs to Truepoint, not the data business.

## What we intentionally postpone

- Phone-number data (hard, legally sensitive, quality-risky — partner/waterfall for it instead of building).
- Intent data (bidstream/topic intent) — crowded and privacy-heavy.
- A self-serve prospecting UI — that is Truepoint's job, powered by this API.
