# 08 — Risks & Legal

This file is deliberately blunt. A data business has real legal exposure, and pretending otherwise is how data companies die. **Nothing here is legal advice — before selling enriched personal data commercially, we engage a lawyer experienced in data licensing and privacy (India DPDP + GDPR + US state laws).** Budget for it (file 09).

## 1. The big four risks

### Risk 1 — Reselling vendor data (contract risk) — HIGH, near-term
Most data vendors' terms (Crustdata, Apollo, and peers) restrict or prohibit **reselling or redistributing** their data. Building revenue on resold vendor data means a single ToS enforcement email can break the product.

**Mitigations:**
- Treat vendor data as **bootstrap supply only**; the owned-supply KPI (file 04) exists precisely to retire this risk on a schedule (40% owned by m12, 60% by m18).
- Read our actual signed terms; where possible, ask vendors about redistribution-licensed tiers (some sell them at higher prices — that legitimizes the bridge period).
- Never market "powered by [vendor]" data; never pass vendor data through in bulk-export form.
- Lawyer review of our supply contracts before API general availability.

### Risk 2 — Sales Navigator scraping (litigation risk) — HIGH, immediate
The session-pool extraction service violates LinkedIn's User Agreement. LinkedIn actively litigates and bans; the legal landscape on scraping (even public data) remains unsettled, and *logged-in* scraping via user sessions is the clearly-worst-position variant.

**Mitigations:**
- Classify it as an **internal stopgap with a written retirement date**; it must never be a customer-facing feature or something we describe in marketing.
- Accelerate the replacements that make it unnecessary: contributor network job-change flags + our own crawling of public sources.
- Accept the possibility we must switch it off overnight — the waterfall must degrade gracefully without it.

### Risk 3 — Privacy law (regulatory risk) — MEDIUM, permanent
We process personal data (names, work emails, job history) of people worldwide. Relevant regimes: **GDPR** (EU), **India's DPDP Act**, US state laws (CCPA/CPRA and successors). B2B contact data generally has workable legal bases (e.g., legitimate interest for business contact data under GDPR), but only with real compliance work.

**Mitigations (build these in, from day one — cheaper than retrofitting):**
- A public **privacy policy + data-subject rights process**: anyone can see what we hold about them, correct it, or opt out; opt-outs propagate to all customers' future pulls.
- **Provenance on every field** (already in the file-04 data model) — lets us answer "where did you get this?" which is the first regulator question.
- Collect **business-contact data only**. Never: sensitive categories, personal-life data, or minors. Personal emails/phones only where lawfully sourced and clearly flagged — or simply excluded at launch (recommended: exclude; it removes most exposure).
- DPAs (data processing agreements) available for customers; standard contractual clauses for EU data if needed.
- Contributor network: explicit consent language, audit trail per contribution (file 04).

### Risk 4 — Concentration & platform dependence — MEDIUM
A few big customers or one upstream vendor dominating supply makes us fragile.

**Mitigations:** alert when one customer >30% of revenue (push them to committed contracts); minimum two vendors per waterfall stage until owned supply covers it; keep crawler infra independent of any single proxy/cloud provider.

## 2. Business risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Crustdata or another incumbent targets India/APAC | Medium | Medium | Speed + local depth (MCA, Indian job boards); they are structurally US-focused |
| Price war | Medium | Medium | Our cost floor is lower (file 05 §8); compete on freshness + guarantees, not price alone |
| Data quality incident (bad batch ships) | Medium | High | QC gate before ship, bounce-rate guarantee funds trust repair, incident postmortems published |
| Match rates too low early (thin cache) | High | Medium | Set expectations in benchmark framing; cache grows with every query; no-match-no-charge means customers don't pay for our gaps |
| Slow enterprise/OEM cycles starve cash | Medium | Medium | Self-serve tiers are the base; OEM is upside, not plan-of-record revenue until signed |
| Founder bandwidth (multiple ventures) | High | High | This plan assumes ~60–70% founder time at minimum through month 9; if that is not available, phases stretch — decide consciously |
| AI commoditizes basic enrichment | Medium | High | Move value up the stack: signals, watchers, verified freshness, APAC coverage — things raw LLM scraping can't reliably do |

## 3. Trust as a product feature

In this market, trust converts. We productize it:
- Published pricing, published match/bounce metrics, public status page, public changelog.
- No-match-no-charge billing.
- A one-page **data ethics & sourcing statement**: what we collect, what we never collect, how opt-out works. Enterprise buyers ask for this; having it ready shortens deals.

## 4. Decision rules (pre-commitments)

1. If a vendor objects to our usage → we stop that usage first, negotiate second. No revenue is worth the lawsuit.
2. If owned-supply share misses the m12 target (40%) by more than 10 points → freeze GTM spend, redirect everything to supply.
3. If LinkedIn-related risk materializes in any form → Sales Nav service off same day; waterfall reroutes.
4. Opt-out requests: honored within 7 days, always, no exceptions.
