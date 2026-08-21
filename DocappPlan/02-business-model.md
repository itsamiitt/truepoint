# 02 — Business Model

## 1. The model in simple words

We collect and clean data about companies and people. We sell access to that data. Customers pay **credits** — small units they spend each time they pull data. They buy credits monthly. If they use more, they pay more. If our data helps their product succeed, their usage grows and our revenue grows automatically.

We do **not** sell software seats. We do **not** build a prospecting UI as the main product. We are the **data layer under other people's products**.

## 2. What we sell (4 products)

### Product 1 — Flat file datasets (launch first)
A cleaned, verified dataset delivered as CSV/JSON, refreshed monthly.
- Example: "All US CPA firms, 10–200 employees, with verified partner/owner contacts."
- Customer downloads it. No integration needed. No engineering needed on our side beyond our existing pipeline.
- **Why first:** fastest to sell, proves willingness to pay, uses what we already produce.

### Product 2 — Enrichment API
Customer sends us a partial record (name + company, or an email, or a LinkedIn URL). We return the full record: role, work history, verified business email, company details, and so on.
- Charged per successful match ("no data returned = no charge" — an important trust signal in this market).

### Product 3 — Search API
Customer sends filters ("US software companies, 50+ people, raised money in the last 12 months, hiring for sales"). We return matching companies/people.
- This powers list-building inside our customers' products.

### Product 4 — Signals & Watchers (the premium layer)
Customer subscribes to changes: "Tell me when anyone in this list changes jobs" or "Alert me when a company posts its first sales-hire job."
- Delivered by webhook (we push the update to them; they never poll).
- **Why premium:** this is recurring, sticky, and hard to rip out. It is Crustdata's most-praised feature and creates lock-in for us too.

## 3. Who pays (customer segments)

| Segment | What they buy | Deal size |
|---|---|---|
| AI SDR / sales-automation startups | Enrichment + Search + Watchers via API | $500–$5,000/mo |
| Recruiting-tech products | People enrichment + job-change watchers | $500–$3,000/mo |
| PE/VC deal-sourcing tools | Company signals + flat files | $1,000–$10,000/mo |
| CRM / RevOps products (OEM) | Embedded enrichment, white-label | $2,000–$20,000/mo, annual |
| Startups & growth engineers | Starter API plan, flat files | $99–$500/mo |

**OEM** means another product embeds our data inside their product and pays us for the volume their users consume. One good OEM deal equals fifty starter customers — but starter customers come first because they close in days, not months.

## 4. How the money flows (revenue streams)

1. **Monthly credit subscriptions** (Starter/Growth plans) — predictable base revenue.
2. **Usage overage** — customers who exceed their plan buy more credits. This is where usage pricing shines: successful customers pay more without a sales conversation.
3. **Annual enterprise/OEM contracts** — committed volume at a discount, paid up front or quarterly. Improves cash flow.
4. **Flat file subscriptions** — fixed monthly price per dataset per customer.
5. **(Later) Marketplace/partner revenue** — our data listed in agent tool directories and integration marketplaces.

## 5. Why this is profitable early (the four engines)

1. **Usage pricing scales revenue without scaling headcount.** More API calls do not require more employees.
2. **Self-serve customers.** Developers read docs and integrate themselves. Our sales cost per customer is close to zero for the Starter/Growth tiers. Support runs through a shared Slack channel (this is also a loved feature, not a cost-cutting trick — Crustdata does exactly this).
3. **Near-zero marginal cost once data is owned.** Serving a cached or self-crawled record costs fractions of a cent. The gap between that cost and the credit price is our gross margin.
4. **India cost base.** Our QC analysts and engineers cost 4–8x less than US equivalents. QC is the exact thing that makes data valuable and the exact thing US vendors cannot afford to do thoroughly.

## 6. The moat (why we get harder to kill over time)

- **The cache flywheel:** every record we buy once from an upstream vendor is stored, refreshed, and resold many times. Our cost per record falls every month while price stays the same.
- **The contributor network:** users of Truepoint and our Chrome extension contribute verified data (give-to-get) and receive credits. Contributed data is proprietary — nobody else has it. (Full design in file 04.)
- **First-party crawling:** our own crawlers on company sites, job boards, funding news, and Indian registries (MCA) create data that does not exist in any vendor's catalog.
- **Watcher lock-in:** once a customer wires our webhooks into their pipeline, switching vendors means re-engineering their product.
- **Published pricing + India/APAC coverage:** positioning advantages competitors would have to restructure to copy.

## 7. What we deliberately do NOT do

- No sales-engagement features (sequencing, dialing, inbox tools). That is our customers' business; competing with customers kills an infrastructure company.
- No per-seat pricing, ever.
- No enterprise-only "book a demo" wall for small plans.
- No long-term dependence on reselling vendor data (see file 08 for why this is a legal and business risk, and file 04 for the replacement plan).

## 8. Relationship to our existing projects

- **Truepoint** = a customer and a showcase. Truepoint's Search page runs on our own API — proof it works, and its users feed the contributor network.
- **Enrichment waterfall + QC pipeline** = the factory. It already exists.
- **Sales Nav extraction service** = a bootstrap source only, with real legal caveats (file 08).
- **Chrome extension + Gmail signature extractor** = contributor-network ingestion tools.
- **Cold outreach practice** = our go-to-market engine (file 06).
