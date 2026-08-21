# 05 — Pricing & Unit Economics

All numbers here are launch estimates. We will adjust after the first 20 customer conversations. The *structure* matters more than the exact figures.

## 1. Pricing principles

1. **Credits, not seats.** Customers buy monthly credit bundles; software can spend credits without a human license.
2. **Charge only when data is returned.** No match = no charge. (Trust signal; also forces us to keep match rates high.)
3. **Publish the prices.** Self-serve up to the Growth tier. Only true enterprise/OEM is custom. Transparency is a stated market gap — it is free marketing.
4. **Make plumbing free.** Company identification/matching ≈ 0 credits. Developers call it constantly; charging for it makes our unit economics look bad in every customer's spreadsheet.
5. **Simple mental math.** 1 credit ≈ $0.05 at Starter tier. Easy to model = easy to buy.

## 2. Credit costs per action (launch table)

| Action | Credits | Effective price @ $0.05/credit | Why |
|---|---|---|---|
| Company identification / match | 0 | Free | Plumbing; drives volume |
| Company enrichment (full record) | 1 | $0.05 | Cheap to serve from cache/crawl |
| Person search (per returned result) | 1 | $0.05 | List building |
| Person enrichment (full profile) | 3 | $0.15 | Highest-cost upstream item |
| Verified business email | +2 | $0.10 | Verification has real cost |
| Watcher (per tracked entity per month) | 2/mo | $0.10/mo | Recurring, premium, sticky |
| Signal event delivered | 1 | $0.05 | Pay per useful event |

## 3. Plans

| Plan | Price/month | Credits | Effective $/credit | Who it is for |
|---|---|---|---|---|
| **Free** | $0 | 100 (one-time + small monthly trickle) | — | Developers testing; contributor-network members earn more |
| **Starter** | $99 | 2,000 | $0.050 | Indie builders, small startups |
| **Growth** | $499 | 12,000 | $0.042 | Funded startups, small platforms |
| **Scale** | $1,999 | 60,000 | $0.033 | Serious platforms |
| **Enterprise / OEM** | Custom annual | Committed volume | $0.02–0.03 | Embedded/white-label deals |

Rules: unused credits roll over up to 2 months (fair, and encourages upgrades rather than churn). Overage billed at the plan's credit rate. Annual prepay = 2 months free.

Flat file datasets are priced separately: **$500–$2,000/month per dataset** depending on row count, contact depth, and refresh frequency; one-time historical pulls at ~3x one month.

## 4. Cost per record (our side)

Estimated blended cost to deliver one person-enrichment record, by source:

| Source | Cost to us | Notes |
|---|---|---|
| Cache hit (our DB) | ~$0.001–0.005 | Compute + storage + refresh amortization |
| Contributed record | ~$0.005–0.02 | Credits granted to contributor (our cost = discounted service, not cash) |
| Own crawl | ~$0.005–0.02 | Crawler infra amortized |
| Crustdata (vendor) | ~$0.03–0.10 | Their credit price |
| Other vendors | ~$0.05–0.15 | Varies |

**The whole game in one line:** we sell person enrichment at ~$0.15 and drive the blended cost from ~$0.08 (mostly vendor, month 1) to under ~$0.03 (mostly owned, month 12+).

## 5. Margin math by owned-supply share

Assume person enrichment at $0.15 revenue, vendor cost $0.08, owned cost $0.01:

| Owned-supply share | Blended cost | Gross margin |
|---|---|---|
| 10% (month 1–3) | ~$0.073 | ~51% |
| 40% (month 12 target) | ~$0.052 | ~65% |
| 60% (month 18 target) | ~$0.038 | ~75% |
| 80% (mature) | ~$0.024 | ~84% |

(Gross margin = what is left from revenue after paying the direct cost of the data itself. Team salaries and marketing come after this — see file 09.)

This is why file 04's ownership-shift KPI is the plan's core number: **owned-supply share is the margin dial.**

## 6. Customer economics (why usage pricing compounds)

- A customer whose product succeeds consumes more credits automatically → revenue expansion without any sales effort.
- Target **NRR ≥ 110%** (net revenue retention: the same customers pay ≥10% more year over year through growth in usage).
- Watchers make revenue recurring even in months when a customer builds no lists (tracked entities bill monthly).

Worked example — a small AI SDR startup:
- Enriches 5,000 leads/mo: 5,000 × 3 credits = 15,000
- Verified emails for 4,000 of them: 4,000 × 2 = 8,000
- Watches 2,000 contacts: 2,000 × 2 = 4,000
- Total ≈ 27,000 credits → Scale-plan territory, ≈ **$900–1,300/month** from one small customer, growing with them.

## 7. Metrics dashboard (what we watch weekly)

| Metric | Target | Why |
|---|---|---|
| Cache hit rate | 30% by m6, 50% by m12 | COGS lever |
| Owned-supply share | 40% m12, 60% m18 | Margin + independence |
| Match rate (query → data returned) | >70% person, >90% company | Product quality; we only earn on matches |
| Email bounce rate (delivered records) | <5% | Quality promise; refunds above threshold |
| Gross margin | >70% by m12 | Business health |
| NRR | >110% | Compounding growth |
| MRR + logo count | per file 09 | Progress |

## 8. Pricing risks and answers

- **"You're pricier than Apollo's bulk credits."** Answer: freshness at query time, no-match-no-charge, published bounce-rate guarantee, watchers. We sell verified-fresh, not bulk-stale.
- **Price war from incumbents.** They cannot follow us down without breaking seat-revenue and US cost structures. Our floor is lower than their floor.
- **A whale customer distorts usage.** Volume tiers + committed contracts for anyone over ~$3k/mo; alerts on single-customer concentration >30% of revenue (file 08).
