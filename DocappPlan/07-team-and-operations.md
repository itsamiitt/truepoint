# 07 — Team & Operations

## 1. The staffing philosophy

Stay tiny. Crustdata reached profitability and 150+ customers with ~20 people; we can reach our 18-month targets with far fewer because we start with working pipeline assets and an India cost base. Every hire must map to a bottleneck we can name.

## 2. Team plan by stage

### Months 0–4 (Phase 1: flat files) — founder + existing help
| Role | Who | Focus |
|---|---|---|
| Founder | You | GTM (40%), product decisions, key data-pipeline work |
| QC analyst(s) | Existing/1 part-time hire | Run the QC funnel on packaged datasets |

### Months 3–9 (Phase 2: API) — first key hire
| Role | Count | Rough monthly cost (India) | Focus |
|---|---|---|---|
| Backend engineer | 1 | ₹1.2–2.5L (~$1.4–3k) | API, metering, billing, cache |
| QC analysts | 1–2 | ₹30–50k each (~$360–600) | Quality bar + verification sampling |
| Founder | — | — | GTM, design partners, waterfall logic |

### Months 9–18 (Phases 3–4: owned supply + agents)
| Role | Count | Focus |
|---|---|---|
| Data/crawling engineer | 1 | Crawlers, entity resolution, contributor ingestion |
| Backend engineer | 1 (existing) | Watchers, signals, scale |
| QC analysts | 2–3 | Growing volume; publish quality metrics |
| Support/DevRel (part-time or founder) | 0.5 | Slack support, docs, integration recipes |

Total headcount by month 18: **5–7 people.** US-equivalent teams for this scope run 15–25 people — this gap *is* the profitability plan.

## 3. The India cost advantage, quantified

| Function | India monthly cost | US-equivalent | Multiple |
|---|---|---|---|
| Backend engineer | $1.4–3k | $10–15k | ~5x |
| Data QC analyst | $360–600 | $3.5–5k | ~8x |
| Total 6-person team | ~$8–12k | ~$60–90k | ~7x |

QC is the function that makes data trustworthy, and it is the function incumbents ration because of cost. We can human-verify at a depth they cannot afford — and sell that as a feature ("human-sampled QC on every batch").

## 4. Infrastructure & tools (lean stack)

| Layer | Choice | Note |
|---|---|---|
| API | Hono/Bun (our perf work applies directly) | Latency is a selling point |
| Data store | Postgres (+ read replicas later) | Entities, events, provenance |
| Cache/rate-limit | Redis | Cache-first waterfall |
| Queue/jobs | Lightweight queue (BullMQ or similar) | Waterfall jobs, refresh, webhooks |
| Crawlers | Separate service + proxy budget | Isolated from API infra |
| Billing | Stripe (+ Razorpay for India customers) | Metered usage from day one |
| Docs | Static docs site with runnable examples | Docs are the sales team |
| Support | Shared Slack channels per customer | Loved, cheap, differentiating |
| Monitoring | Uptime + latency + match-rate dashboards | Publish a status page early |

Infra budget: ~$300–800/mo through month 9; $1–2.5k/mo by month 18 (crawling + storage growth). Vendor data spend scales with revenue and *falls per unit* as owned-supply share rises (files 04–05).

## 5. Operating rhythms

- **Weekly:** metrics review (the file-05 dashboard: cache hit rate, owned-supply share, match rate, bounce rate, MRR).
- **Per batch:** QC sign-off before any dataset ships; below-bar batches reprocess, never ship.
- **Monthly:** published changelog (builds trust with developer customers) + quality-metrics update.
- **Quarterly:** vendor dependence review — cost per source, contract terms, retirement progress on risky sources (Sales Nav first).

## 6. Ownership of the two products

Truepoint (the UI product) and the data API share the database but must not share a roadmap owner mentally: the API's customers are other products, and the API always ships features as API-first. Truepoint becomes the reference implementation and the contributor-network front door — a customer of the API like any other.

## 7. When to break the "stay tiny" rule

Only three triggers justify accelerating hiring:
1. Support/Slack response times slipping past a few hours during customer growth.
2. Crawling/QC backlog blocking the owned-supply KPI (file 04).
3. Two or more OEM contracts signed (dedicated integration support pays for itself).
