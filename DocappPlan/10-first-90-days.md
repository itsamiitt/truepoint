# 10 — The First 90 Days (Week-by-Week)

Rule for this file: **every week ends with something shipped or someone contacted.** No week is "research only."

## Weeks 1–2 — Decide, package, and get legal eyes on it

- [ ] Pick the first dataset: **US CPA/accounting firms** (ICP already defined) — confirm field list: firm, size band, location, website, 1–3 decision-makers with verified emails.
- [ ] Run the existing pipeline to produce v1 of the dataset; record the QC packaging % — it becomes the marketing number.
- [ ] Send our vendor terms (Crustdata, Apollo, others in use) to a data-licensing lawyer with one question: *what exactly can we resell, and under what conditions?* (file 08, Risk 1).
- [ ] Write the one-page data ethics & sourcing statement + basic privacy policy with an opt-out email address (file 08 §3).
- [ ] Name the product. Register domain.

**Ship by end of week 2:** dataset v1 exists; legal question is in a lawyer's inbox.

## Weeks 3–4 — First landing pages + first outreach list

- [ ] Landing page for dataset #1: field list, 25-row sample, price ($500–1,500/mo tiers), Stripe/Razorpay checkout, bounce-rate guarantee stated plainly.
- [ ] Pricing page for the future API (mark it "API — waitlist") with the full file-05 table. Publishing prices *before* launch is the positioning move.
- [ ] Build outreach list #1: 150 founders of AI SDR / outbound / recruiting-tech startups (use our own pipeline to build it — and say so in the email).
- [ ] Draft the benchmark cold email: research-first, one clear offer — *"send 200 records from your ICP; we return our version free; compare match rate & freshness yourself."*

**Ship by end of week 4:** two live pages; list of 150 with first 30 emails sent.

## Weeks 5–8 — Sell, benchmark, learn

- [ ] Outreach: 25–40 sends/week, personalized. Track reply rate (target >8%).
- [ ] Run every benchmark that comes back within 48 hours; deliver results as a clean comparison sheet. (Each run also seeds our cache.)
- [ ] Close first flat-file customers (target: 3 paying by end of week 8).
- [ ] Interview every prospect who says no — capture which vertical/fields/price they wanted; pick dataset #2 from this evidence, not from guesses.
- [ ] Start the public benchmark post ("we tested N enrichment sources on 1,000 records") using our accumulating benchmark data.
- [ ] Begin API spec: `/person/enrich`, `/company/enrich` (free matching), metering, no-match-no-charge billing logic. Reuse Hono/Bun perf architecture.

**Ship by end of week 8:** ≥3 paying customers OR ≥10 completed benchmarks; API spec frozen.

## Weeks 9–12 — API beta + the flywheel starts

- [ ] Build API beta: two enrichment endpoints + keys + metering + usage dashboard (minimal), cache-first waterfall behind it.
- [ ] Invite 5–10 design partners from the benchmark pipeline: free Growth-tier credits for 60 days in exchange for feedback + a logo/quote.
- [ ] Ship the MCP server (thin wrapper over the two endpoints) and submit to agent tool directories.
- [ ] Publish benchmark post #1 + the "our pricing is public, here's why" post.
- [ ] Contributor network groundwork: add the "flag a job change / correct a contact → earn credits" loop into Truepoint; wire the Gmail signature extractor's output (opt-in) into the ingestion path with consent language from week 1–2's policy.
- [ ] Set the metrics dashboard live (file 05 §7) and review it weekly from now on.

**Ship by end of week 12:** API in beta with ≥5 design partners; MCP listed; first contributor loop live.

## Day-90 scorecard (honest pass/fail)

| Question | Pass looks like |
|---|---|
| Will people pay? | ≥3 flat-file customers or ≥$2k MRR |
| Does our data hold up? | Benchmarks: match rate within 10 pts of incumbents, freshness wins |
| Is the API real? | 5+ design partners making live calls |
| Is supply shifting? | Cache hit rate >10% and rising; contributor loop shipping data |
| Is legal handled? | Lawyer's answer received; Sales Nav retirement date written down |

**If ≥4 pass:** proceed to full Phase 2 (file 03) with confidence.
**If ≤2 pass:** stop and diagnose — usually it's the vertical choice or the offer, not the model. Re-run weeks 3–8 on a different vertical before touching more engineering.

## Daily/weekly founder rhythm for these 90 days

- Daily: 60–90 minutes on outreach/replies (mornings — US time zones reply overnight for us in Mumbai, so mornings are harvest time).
- Weekly: metrics review (30 min), one shipped artifact, one learning written down.
- Never: a week spent only on infrastructure while zero customer conversations happen.
