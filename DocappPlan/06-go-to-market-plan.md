# 06 — Go-To-Market Plan (How We Get Customers Cheaply)

We are a small team selling to developers and technical founders. Our GTM must be cheap, credible, and mostly self-serve. The good news: we already practice research-first cold outreach — that skill *is* the GTM engine here.

## 1. Who we sell to (ICP for the data business)

**Primary ICP (first 6 months):**
- Founders / founding engineers of **AI SDR, sales-automation, and outbound tools**
- Company size 2–30 people, seed to Series A, mostly US/EU/India
- Pain: they need data inside their product; ZoomInfo won't deal with them at their size; Apollo's API is a side feature; they are actively comparing Crustdata/PDL/Coresignal.
- Where they live: X (Twitter), YC network, Indie Hackers, r/SaaS, AI-agent Discords, MCP/agent tool directories, LinkedIn.

**Secondary ICP:** recruiting-tech builders; PE/VC deal-sourcing tools; RevOps engineers at funded startups who want data without an enterprise contract.

**Explicitly not our buyer:** individual sales reps wanting a UI (send them to Truepoint), and enterprises wanting on-prem deployments (too early for us).

## 2. Positioning (the words we use everywhere)

> **"Fresh B2B data by API. Pay per record, only when we return data. Published pricing. Built for AI agents — with the best India/APAC coverage available."**

Three proof points repeated everywhere:
1. **No-match-no-charge** billing.
2. **Published quality numbers** (match rate, bounce rate) + bounce-rate guarantee.
3. **Live pricing page** — no "book a demo" wall below enterprise.

## 3. Channels, in priority order

### Channel 1 — Research-first cold outreach (weeks 1+, our home turf)
- Build a list of 200–300 founders of AI sales/recruiting tools (we can literally use our own pipeline to build it — and say so in the email; that is the demo).
- Offer: **free credits to benchmark us against their current vendor on their own ICP.** ("Send us 200 of your records; we'll return our version; compare match rate and freshness yourself.")
- The benchmark offer works because it costs them nothing, produces a spreadsheet (developers trust spreadsheets), and every benchmark run seeds our cache.
- Target: 30–50 benchmark runs in the first 2 months → 10–15 paying conversions.

### Channel 2 — Content + public benchmarks (weeks 2+)
- Data-driven posts: "We tested 5 enrichment APIs on 1,000 records — match rates, freshness, cost." Honest methodology, our numbers included even where we lose. Credibility compounds.
- India/APAC data reports ("State of Indian SaaS hiring, from live job-post data") — showcases the wedge nobody else covers, earns links and press.
- SEO pages per use case ("enrichment API for AI SDR tools", "ZoomInfo API alternative", "B2B data API India"). This category is won heavily through comparison content — Crustdata's own blog is proof.

### Channel 3 — Agent-ecosystem distribution (month 2+)
- Ship the MCP server early and get listed in MCP/agent tool directories and marketplaces. Early = discoverable while lists are short.
- Publish integration recipes: "Give your Claude/GPT agent live B2B data in 5 minutes."
- Partner with 2–3 agent-framework communities for co-posts and mutual listings.

### Channel 4 — Community presence (ongoing, founder-led)
- Be genuinely useful in the niches: answer data questions on X, Reddit, Discords; publish teardown threads. No spam; expertise is the ad.

### Channel 5 — OEM/enterprise outbound (month 6+)
- Hand-picked list of 30 CRMs/ATSs/RevOps platforms that should embed enrichment. Founder-led, longer cycles, big contracts. Start conversations early; close after we have reference customers and SOC-2-ish answers.

## 4. The funnel and the free tier

```
See content/benchmark/directory  →  Free tier (100 credits) or benchmark run
  →  Integrate (docs + Slack support)  →  Starter/Growth plan
  →  Usage grows  →  Scale/Enterprise  →  Case study → more content
```

- Free tier exists to remove friction and feed the contributor network (contributions earn extra credits).
- **Slack support channel from day one.** Engineer-answered, fast. In this category, buyers repeatedly cite hands-on support as a reason they chose a small vendor over an incumbent. It is our enterprise-grade feature that costs us almost nothing.

## 5. Launch sequence

| When | Action |
|---|---|
| Week 1–2 | Landing page + pricing page live; first dataset page live; waitlist for API |
| Week 2–6 | Cold outreach wave 1 (benchmark offer); first flat-file sales |
| Month 2 | Public benchmark post #1; MCP server listed; API beta to 10 design partners |
| Month 3 | API general availability + "published pricing" launch post (the positioning story) |
| Month 4–6 | India/APAC data report #1; case study #1; outreach wave 2 |
| Month 6+ | OEM conversations; watchers launch content ("stop polling") |

## 6. GTM budget (lean)

- $0–500/mo: tooling (email infra, landing pages, analytics).
- Free credits given away: capped at a monthly credit budget; every benchmark seeds the cache, so much of this "cost" becomes an asset.
- No paid ads until content + outreach saturate (likely month 6+; test $500–1k/mo on high-intent search terms then).
- Main spend is founder time: ~40% of it on GTM in months 1–6. That allocation is the plan, not a distraction from it.

## 7. GTM metrics

| Metric | Target |
|---|---|
| Benchmark runs completed | 30–50 in first 2 months |
| Benchmark → paid conversion | >25% |
| Free → paid conversion | >8% |
| Reply rate on cold outreach | >8% (research-first bar) |
| Organic signups/month from content | 30+ by month 6 |
| Case studies published | 2 by month 6 |
