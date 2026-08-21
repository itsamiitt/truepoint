# 01 — Market Research

## 1. What market are we in?

We are in the **B2B data / sales intelligence** market: companies that collect, clean, and sell information about businesses and the people who work at them. Customers use this data to find buyers, recruit people, or research investments.

Inside this market there are two very different kinds of players:

| Type | What it is | Examples | Who uses it |
|---|---|---|---|
| **Platforms (tools)** | A website with search, filters, and export buttons. Built for humans. | ZoomInfo, Apollo.io, Cognism, Lusha | Sales reps, SDRs, recruiters |
| **Data infrastructure (APIs)** | Raw data delivered by API or file. Built for software. | Crustdata, People Data Labs, Coresignal, Bright Data | Developers, product teams, AI agents |

**We are building the second type.** It needs no big sales team, no fancy UI, and it grows when our customers' products grow.

## 2. How big is the market?

Different research firms measure it slightly differently, but they agree on the shape:

- The global sales intelligence market is valued at roughly **$4–5 billion in 2026** (Mordor Intelligence: $4.99B; The Business Research Company: $4.52B; MarkWide: $4.1B).
- Expected to reach **$8–12 billion by the early 2030s**, growing at **11–15% per year**.
- **North America holds 40–46%** of the market — that is where our customers' customers are.
- **Asia-Pacific is the fastest-growing region** (~14–15% yearly growth).
- **Pay-as-you-go pricing is the fastest-growing pricing model** (~18.5% yearly growth per Mordor Intelligence) — exactly the model we plan to use.

One honest note: one independent analysis (Knowlee, 2026) points out these headline numbers vary a lot by definition and puts the realistic range at $6–12B when adjacent segments are included. The exact number does not change our plan. What matters: the market is billions of dollars, growing double digits, and shifting toward usage pricing.

## 3. Why the market is changing right now (our opening)

**a) AI agents are becoming the buyers of data.**
Software (AI SDRs, AI recruiters, deal-sourcing agents) now consumes B2B data directly. An AI agent cannot "log in and click filters" — it needs an API. And seat pricing makes no sense for a program that runs 10,000 lookups a day. This is the single biggest shift in the market and the reason Crustdata grew so fast.

**b) Data goes stale extremely fast.**
B2B contact records decay at roughly **30% per year** (people change jobs about every 4 years on average). Buyers are tired of paying enterprise prices for stale databases refreshed monthly or quarterly. "Freshness" is now a top buying criterion.

**c) Buyers hate opaque pricing.**
ZoomInfo-style contracts run **$15,000–$50,000+ per year** with per-seat pricing and sales negotiations. Small teams and startups are locked out. Transparent, self-serve, credit-based pricing is a real differentiator — many vendors (including Crustdata) still hide their prices behind "book a demo."

## 4. Competitor snapshot

| Competitor | Model | Rough price | Strength | Weakness we can attack |
|---|---|---|---|---|
| **ZoomInfo** | Platform, per-seat, annual contracts | $15k–$50k+/yr | Biggest NA database, human-verified | Expensive, stale refresh cycles, hostile to small teams |
| **Apollo.io** | Platform + light API, seats + credits | Free tier to ~$99+/user/mo | Cheap, all-in-one | Data quality complaints, API is secondary |
| **Crustdata** | API-first, credits | ~$95–$200/mo start, custom enterprise | Real-time crawling, Watchers, MCP | Prices not fully public, weak outside US data, young phone-number data |
| **People Data Labs / Coresignal** | Bulk data + API | Custom | Huge historical datasets | Batch refresh, not real-time signals |
| **Bright Data** | Scraping infrastructure | Usage-based | Powerful crawling | You build everything yourself; not a clean B2B graph |

## 5. Gaps in the market (where we win)

1. **Transparent self-serve pricing.** Publish a real price list with a card-payment start plan. Almost nobody in this category does it well. It costs nothing and buyers repeatedly complain about its absence.
2. **India / APAC company data.** US vendors are weakest here: Indian companies, MCA registry data, Indian job boards, regional hiring signals. APAC is the fastest-growing region and largely unserved with fresh data. We are physically and culturally closest to this data.
3. **Signals over static records.** Hiring spikes, funding events, headcount moves, leadership changes. AI-agent customers pay a premium for "what changed today," and legacy vendors are structurally slow at it.
4. **Quality-controlled data at low cost.** Cheap data is dirty; clean data is expensive. Our existing human QC pipeline in India lets us sell clean data at cheap-data prices — a combination US competitors cannot copy without breaking their cost structure.
5. **Agent-native delivery.** MCP server, webhooks, structured JSON designed for LLM consumption. The vendors built for humans are retrofitting this; we build it in from day one.

## 6. Who our customers are (detailed in file 06)

- Founders/CTOs of **AI SDR and sales-automation startups**
- **Recruiting-tech** builders (AI recruiters, ATS add-ons)
- **PE/VC deal-sourcing** tools and analysts
- **CRM and RevOps products** that need enrichment inside their app
- Growth engineers at startups who want data without a ZoomInfo contract

## 7. Bottom line

A $4–5B market growing double digits, with its fastest-growing pricing model (usage-based) and fastest-growing region (APAC) both pointing directly at the business we are positioned to build. The incumbents' weaknesses — staleness, opaque pricing, seat-based economics, weak APAC coverage — are exactly our strengths.
