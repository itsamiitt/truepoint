# 04 — Data Supply Plan (Where the Data Comes From)

A data business lives or dies on supply. This file covers the four supply sources, the QC process that makes our data worth paying for, and the shift from "bought" to "owned" data.

## 1. The four supply sources

### Source A — Vendor waterfall (bootstrap fuel, months 0–12)

Our existing setup, formalized:

```
Query comes in
  → 1. Our own database (cache)          cost: ~$0.001   (storage + compute)
  → 2. Crustdata API                     cost: ~$0.03–0.10 per returned record
  → 3. Sales Navigator fallback service  cost: session/ops cost (see legal note)
  → 4. Other vendors (Apollo etc.)       cost: varies per credit
Every paid result is written back to the cache with a source tag + timestamp.
```

Rules:
- **Cache-first, always.** The cache hit rate is our single most important cost metric.
- **Waterfall stops at first confident match.** No double-paying vendors for one record.
- **Every record stores:** source, retrieved-at time, confidence score, verification status.

⚠️ **Important limits on Source A** (full detail in file 08):
- Most vendor terms **prohibit reselling their data**. Treat vendor data as bootstrap supply while owned supply ramps up, and get legal advice on our actual contracts before selling enriched records commercially.
- The Sales Navigator extraction service violates LinkedIn's terms and LinkedIn litigates aggressively. It is an internal stopgap at most, not a product foundation. Plan its retirement.

### Source B — Contributor network (the give-to-get moat)

The idea: people who use our free tools give us small pieces of verified data; we give them credits. Thousands of contributors = a living database nobody can buy.

**What contributors give:**
| Contribution | How it is captured | Value |
|---|---|---|
| Email signatures | Gmail signature extractor (opt-in) | Verified name, title, phone, company — fresh and real |
| Contact corrections | "This person changed jobs" flags in Truepoint / extension | Job-change signals — the most valuable event in B2B data |
| CRM-observed data | Opt-in sync of contact fields from their CRM | Volume + verification via agreement |
| Bounce/verification feedback | Automatic: which emails bounced for them | Free, continuous email verification at scale |

**What contributors get:**
- Credits on our API / Truepoint (e.g., 1 verified new contact contributed = N lookup credits).
- Higher rates for rare data (new companies, APAC contacts, job-change flags).
- A free tier that is genuinely useful, funded by their contributions.

**Trust rules (non-negotiable):**
- Explicit opt-in, clear consent language, per-source audit trail.
- Contributed personal data goes through the same privacy handling as everything else (file 08): opt-out honored globally, sensitive fields never collected.
- Anti-gaming: contributions only earn credits after verification (cross-source agreement or email verification passes). Fake data earns nothing and flags the account.

**Why this works:** Apollo and ZoomInfo both grew on exactly this mechanic (community/contributed data). It converts our free users from a cost into our supply chain.

### Source C — First-party crawling (the freshness engine)

We crawl public web sources ourselves. Build order by value-per-effort:

1. **Job boards + company career pages** → hiring signals. "Company X just posted 5 sales roles" is a buying signal customers pay premium for, it changes daily, and incumbents are slow at it.
2. **Company websites** (team/about/product pages) → firmographic refresh + leadership changes.
3. **Funding/press sources** → funding events, expansions, leadership announcements.
4. **India sources** → MCA (Ministry of Corporate Affairs) registry data, Indian job portals, Indian startup/business news. This is the APAC wedge: data US vendors barely touch, sitting next to us.

Crawling rules: respect robots.txt on general crawling, rate-limit politely, store source URLs for every fact (provenance = defensibility), and keep crawler infrastructure separate from API infrastructure.

### Source D — Public/structured datasets

Company registries, SEC filings (for US public companies), open datasets, official announcements. Cheap, legal, great for the company graph (less useful for contacts).

## 2. The QC pipeline (why anyone pays us instead of a cheap list broker)

Our existing funnel, upgraded into the product's core promise:

```
RAW (any source)
  → AUTOMATED CHECKS   format validation, dedup, email syntax+domain+SMTP checks,
                       cross-source agreement scoring
  → HUMAN QC (sampled) analysts verify a sample per batch; batches below the
                       quality bar are reprocessed, not shipped
  → QUALIFIED          record gets a confidence score (0–100) + verification badges
  → PACKAGED           released to API/files; refresh clock starts
```

- We already track packaging % monthly — that becomes a **published quality metric** (marketing asset).
- Human QC in India costs us a fraction of what it costs US vendors — this is the structural advantage. Clean data at dirty-data prices.
- **Email guarantee:** bounce rate above the promised threshold → automatic credit refund. Guarantees convert skeptics.

## 3. Data model (simple version)

Two core entities, one event stream:

- **Company**: ids (domain, registry ids), firmographics, locations, headcount history, funding history, tech hints, source+confidence per field.
- **Person**: ids (LinkedIn URL, email), current role, work history, education, contact fields, source+confidence per field.
- **Events**: job_change, new_funding, headcount_change, new_job_posting, leadership_change — each linked to entities, timestamped, with provenance. Events power Search filters, Signals, and Watchers.

Field-level provenance (which source said this, when) is what lets us mix four supply sources without turning the database into mud.

## 4. The ownership shift (the plan's core KPI)

Track monthly: **% of delivered records served from owned supply** (cache + contributed + crawled + public) vs paid vendor calls.

| Milestone | Owned-supply share | Effect |
|---|---|---|
| Month 3 | ~10–15% | Mostly cache hits |
| Month 6 | ~25–30% | Cache + first crawlers |
| Month 12 | **40%+** | Contributor network live |
| Month 18 | **60%+** | Real margins, real moat |

Every point of owned-supply share drops our cost per record and reduces vendor/legal dependence. This number goes on the wall.
