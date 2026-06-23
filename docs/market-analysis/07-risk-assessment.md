# 07 — Risk Assessment

> Part of the **TruePoint Market Gap Analysis & PMF Audit**. Research date: **2026-06-01**.
> See the [README](README.md) for index, method, and assumptions. Evidence base: [Product Overview](00-product-overview.md),
> [Market Research](01-market-research.md), [Competitor Analysis](02-competitor-analysis.md), [Market Gaps](03-market-gaps.md),
> [Product-Market Fit](04-product-market-fit.md), and [Pain-Point Mapping](05-pain-point-mapping.md).
> **Stage caveat (load-bearing — read first).** TruePoint is **pre-launch with ZERO code, ZERO users, and ZERO revenue.** All
> pricing is **placeholder** (signup bonus ~25 credits; packs 100/500/2k/10k — none final). Every mitigation below is a **design
> intention from the planning corpus, not a shipped or measured control**, and every likelihood/impact rating is **projected
> analyst judgement, not a measured probability.**

---

## At a glance

The honest headline: **TruePoint is a pre-launch, single-region, zero-asset entrant into one of the most crowded, well-funded,
and rapidly-consolidating categories in B2B software.** Its core market (sales intelligence) is a healthy but *not* explosive
~$3.3–4.5B at ~10–13% CAGR ([Precedence](https://www.precedenceresearch.com/sales-intelligence-market),
[Mordor](https://www.mordorintelligence.com/industry-reports/sales-intelligence-market)), and it is surrounded by competitors
who own what TruePoint does not: hundreds of millions of proprietary records, $1.6B–$3.1B war chests
([Apollo](https://news.crunchbase.com/sales-marketing/apollo-io-funding-sales-tech-unicorn/),
[Clay](https://techcrunch.com/2025/08/05/clay-confirms-it-closed-100m-round-at-3-1b-valuation/)), CRM data gravity
(HubSpot/Salesforce), and the certifications/registrations a compliance pitch requires (Cognism).

Three risks rise to **Critical / High-Critical** for an entrant at this stage:

1. **Competitive absorption (Critical).** TruePoint's three differentiators are all *features*, not *moats*. CRM incumbents
   (Salesforce Agentforce, HubSpot Breeze) and data incumbents (ZoomInfo GTM Studio) are folding find→enrich→score→sequence→send
   into the system of record buyers already own — the exact "stitched-tool" pain TruePoint attacks, neutralized by bundling.
2. **No proprietary data asset (High→Critical).** The market's #1 complaint is data accuracy, yet TruePoint owns no dataset — it
   resells/verifies Apollo/ZoomInfo/Clearbit. Its accuracy is capped by its suppliers, and those suppliers are also its rivals.
3. **The compliance wedge is unproven and partly deferred (High).** "Compliance as a feature" is TruePoint's sharpest
   differentiator, but the certs (SOC 2/ISO), broker registrations, EU residency, and the send-gating half of the story are all
   **post-MVP or open** — and the very act of being a B2B contact-data vendor now triggers data-broker registration in 4 US states.

The encouraging counter-signal: the two loudest *behavioural* trends — buyer revolt against irrelevant outbound and the collapse
of the "autonomous AI-SDR replaces your team" thesis — actually favour a compliant, human-in-the-loop, deliverability-disciplined
product. **Timing is a tailwind on positioning and a headwind on competition.** This document scores fifteen risks across the
eight requested dimensions and proposes mitigations for each.

---

## 1. How risks were rated

Each risk carries a **Likelihood** (will it materialise within ~24 months of launch?), an **Impact** (how badly does it hurt the
business if it does?), and a composite **Rating**. The composite is a judgement blend, not a strict matrix product — a
low-likelihood / catastrophic-impact risk can still rate High.

| Rating | Meaning |
|---|---|
| **Critical** | Existential or near-existential. Could prevent product-market fit or kill the company if unmanaged. |
| **High** | Major. Materially caps growth, margin, or trust; demands an explicit, funded mitigation. |
| **Medium** | Real and manageable. Erodes a metric or a quarter; mitigable with normal product/ops discipline. |
| **Low** | Minor / contained. Worth tracking; unlikely to move the trajectory. |

> Likelihood/Impact are **projected analyst judgement** grounded in the dossier — TruePoint has **no measured base rates** (zero
> users). Ratings are deliberately elevated wherever the relevant capability is **post-MVP (M7–M11)** or depends on an asset
> (proprietary data, certs, brand, capital) TruePoint does not hold at launch.

---

## 2. Risk register

The full register, grouped by dimension. Detailed treatment of the highest-rated risks follows in §3.

### 2.1 Market saturation

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R1 — Crowded, fragmented field; TruePoint is undifferentiated noise** | The dossier profiles **20+ direct rivals** across data (ZoomInfo, Apollo, Cognism, Lusha, Seamless, RocketReach, UpLead, Lead411, Kaspr, Wiza, Hunter), outreach (Outreach, Salesloft, Instantly, Smartlead, Lemlist, Reply), platform (Clay), CRM-native (HubSpot, Salesforce, Pipedrive, Breeze) and AI-SDR (11x, Artisan, AiSDR, Qualified). Buyers are already consolidating from ~10–15 tools to 4–6 ([Salesforce](https://www.salesforce.com/sales/state-of-sales/sales-statistics/)). A new name struggles for attention. | High | High | **High** | Refuse to compete on breadth; win a narrow wedge (compliant, transparent-billing, turnkey loop for SMB/agency) per [Strategic Opportunities](06-strategic-opportunities.md). Lead with the *anti-incumbent* pains (billing traps, lock-in) competitors can't easily fix. |
| **R2 — Core market is steady, not explosive** | Sales intelligence is ~$3.3–4.5B at ~10–13% CAGR — solid but not hypergrowth ([Precedence](https://www.precedenceresearch.com/sales-intelligence-market), [Mordor](https://www.mordorintelligence.com/industry-reports/sales-intelligence-market)). The MRF $7.5B (2024) figure is a verified **~2x outlier** — do not plan against it ([MRF](https://www.marketresearchfuture.com/reports/sales-intelligence-market-29273)). | Medium | Medium | **Medium** | Treat the steady core as a beachhead, not the prize; design to ride the faster AI-SDR overlap (~29.5% CAGR, see R7) and SaaS-CRM adjacency as expansion, not bet the model on category hypergrowth. |
| **R3 — SMB/self-serve segment is the most contested entry point** | TruePoint's natural wedge (affordable, self-serve, SMB/agency) is exactly where Apollo's PLG machine, the cheap data cluster (Lusha/RocketReach/UpLead at $49–99/mo), and the cold-email cluster (Instantly/Smartlead at $37–94/mo) all already live and undercut on price. | High | Medium | **High** | Don't out-price; out-*trust* and out-*integrate*. Bundle data+reveal+score+send in one fair-billing seat so the comparison is "one honest tool" vs. "four cheap point tools," not raw $/seat. |

### 2.2 Competitive threats

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R4 — Incumbent feature absorption (the core existential threat)** | VCs' explicit thesis against standalone players: Salesforce/HubSpot/ZoomInfo "fold these capabilities in as features," commoditizing them ([TechCrunch](https://techcrunch.com/2024/12/26/ai-sdr-startups-are-booming-so-why-are-vcs-wary/)). It is **visibly playing out**: ZoomInfo shipped GTM Workspace/Studio + Copilot and integrated into Salesforce Agentforce ([ZoomInfo 8-K](https://www.sec.gov/Archives/edgar/data/0001794515/000179451524000132/zi-8kex991x20240805.htm)); HubSpot bundles Breeze Agents + Breeze Intelligence; Salesforce ships Agentforce + Data Cloud. TruePoint's "end-to-end in one app" is precisely what they now offer inside the system of record. | High | Critical | **Critical** | Compete where incumbents *structurally* under-invest: transparent/predictable pricing vs. credit/outcome billing fatigue, CRM-neutral (multi-CRM) positioning, deliverability discipline, and compliance gating of the customer's own *sends* — features tied to CRM lock-in that they won't replicate. Stay deliberately *not* feature-for-feature. |
| **R5 — Better-funded direct rivals out-execute on data + AI** | Apollo: ~$150M ARR, $1.6B valuation, 275M+ contacts, 9,000+ G2 reviews ([Apollo/Sacra](https://sacra.com/research/apollo-io-at-134m-arr/), [Crunchbase](https://news.crunchbase.com/sales-marketing/apollo-io-funding-sales-tech-unicorn/)). Clay: $100M Series C at **$3.1B**, 10,000+ customers, 100+-provider waterfall, Claygent AI agents ([TechCrunch](https://techcrunch.com/2025/08/05/clay-confirms-it-closed-100m-round-at-3-1b-valuation/)). TruePoint cannot match war-chest, dataset, or AI velocity. | High | High | **High** | Explicitly do **not** compete on database breadth or AI horsepower (dossier guidance). Win on the integrated, *compliant*, *simple* full loop for the segment Clay (technical/RevOps) and Apollo (volume) under-serve: non-technical SDRs and compliance-sensitive teams. |
| **R6 — Dependence on competitors as data suppliers** | TruePoint enriches via **Apollo/ZoomInfo/Clearbit** — i.e., it pays its own rivals for the raw asset, who can raise prices, restrict API terms, or cut access. Clearbit is the cautionary tale: post-HubSpot acquisition it killed standalone/API access for non-HubSpot customers ([Salesmotion](https://salesmotion.io/blog/clearbit-alternatives-hubspot-acquisition)). | Medium | High | **High** | Multi-provider waterfall with cache-first cost control ([Enrichment Engine](../planning/06-enrichment-engine.md)) reduces single-supplier dependence; negotiate redundancy across providers; design the schema so a provider can be swapped without rework. Treat any one provider as replaceable. |

### 2.3 Technology disruption

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R7 — Category shifts from "data + sequencing" to AI orchestration / GTM engineering** | Capital and narrative moved up a layer to data-activation/orchestration (Clay's "GTM engineering," $3.1B) and agentic execution, not to standalone reveal-and-send. The AI-SDR overlap is the fastest-growing slice: **$4.12B (2025) → $15.01B (2030) at 29.5% CAGR** (verified, MarketsandMarkets) ([M&M](https://www.marketsandmarkets.com/Market-Reports/ai-sdr-market-83561460.html)). A reveal-credits + manual-sequence model can look dated. | Medium | High | **High** | Keep AI on the roadmap as augmentation (AI drafting M9; NL search later), but position *against* orchestration complexity: turnkey "finished workflow" vs. Clay's weeks-to-learn IDE. Match enough AI to not read as "slow/manual," not to out-Clay Clay. |
| **R8 — Architecture/scale assumptions unproven at 100M+ rows** | The stack (Aurora Serverless v2, Typesense CDC-fed, RLS multi-tenancy, KMS-masked PII, blind indexes) is designed for 100M+ rows but **never built or load-tested** — zero code exists. RLS-per-tenant + masked-until-reveal + waterfall enrichment is genuinely hard to make fast and cheap. | Medium | High | **High** | De-risk via milestone sequencing (M0 scaffold → M2 tenancy/search → M3 reveal); load-test search and RLS isolation early; cache-first enrichment to cap provider cost. See §2.8 (R14) for the scalability-specific treatment. |

### 2.4 AI disruption (autonomous AI-SDRs)

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R9 — Autonomous AI-SDRs make human-in-the-loop look obsolete** | Loud, well-funded entrants (11x, Artisan, AiSDR, Qualified-now-Salesforce) sell "AI replaces your SDR." If the thesis *had* held, TruePoint's human-gated send (M9) would look dated and slow. | Medium | High | **High** | This thesis is **collapsing** (see R10) — lean into it. Position "augmented human, not autonomous slop": verified data + sender-reputation guardrails + one-click human approval + honest metrics. Match AI drafting/research horsepower so HITL doesn't read as manual. |
| **R10 — The AI-SDR collapse splashes back on the whole outbound category (reputational contagion)** | The autonomous wave is discrediting itself: documented **~50–70% churn within 90 days** (trade-press *estimate*, not audited), ~47% of deployments killed by deliverability collapse, "AI slop" buyer rejection, and the **11x scandal** — claimed **~$10M ARR vs ~$3M real** (verification corrects the dossier's "$14M" down to ~$10M), 70–80% early churn, unauthorized ZoomInfo/Airtable logos ([TechCrunch](https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have/)). Buyers burned by AI-SDRs may distrust *all* "AI outbound." | Medium | Medium | **Medium** | Distance TruePoint from "autonomous outbound" branding; market deliverability protection, compliance, and *auditable, honest* metrics as the antidote. Target buyers burned by an 11x/Artisan deployment as a switch segment. |
| **R11 — Buyer revolt against outbound + inbox gatekeeping shrinks the channel** | **67% of B2B buyers prefer a rep-free experience** (verified, up from 61%) and 45% used AI in a purchase ([Gartner 2026](https://www.gartner.com/en/newsroom/press-releases/2026-03-09-gartner-sales-survey-finds-67-percent-of-b2b-buyers-prefer-a-rep-free-experience)). Google/Yahoo Feb-2024 bulk-sender rules (SPF+DKIM+DMARC, one-click unsubscribe, spam <0.3%) hardened to **permanent rejections in Nov 2025** ([Security Boulevard](https://securityboulevard.com/2025/11/google-and-yahoo-updated-email-authentication-requirements-for-2025/)). Volume cold outbound is structurally penalized. *(The "30–50% deliverability drop for non-compliant" figure is a trade-press **estimate**, not audited.)* | High | Medium | **High** | This *rewards* low-volume, verified, consent-aware sending — TruePoint's exact design. Build deliverability hygiene (auth, warmup, suppression) as first-class (M9); message relevance/verification over volume. The forcing function is a tailwind *if* the send engine ships well. |

### 2.5 Regulatory changes

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R12 — Data-broker registration & deletion regime now captures B2B contact vendors** | **4 US states** run data-broker registries (CA, VT, TX, OR); California's **Delete Act/DROP went live Jan 1 2026** ($6,000 fee, register by Jan 31, **$200/day** non-registration and **$200/request/day** deletion penalties from Aug 1 2026), enforced by a **Data Broker Strike Force** already issuing fines (~$42K–$62.6K) ([CPPA](https://cppa.ca.gov/data_brokers/), [Clark Hill](https://www.clarkhill.com/news-events/news/is-your-business-a-data-broker-californias-drop-goes-live-and-calprivacy-continues-to-enforce-delete-act/)). A vendor selling contact data of people it has no relationship with is **squarely** a data broker. | High | High | **High** | Treat broker registration as a launch gate, not an afterthought; build DROP/DSAR fan-out across per-workspace copies (planned) into MVP compliance (M5). The regime is a *moat* for a compliance-first design and a *killer* for a careless one — invest accordingly. |
| **R13 — Enforcement is real, rising, and aimed at the supply chain** | ZoomInfo paid **~$29.5M** (verification corrects "$26–29M") to settle right-of-publicity class actions ([SEC 10-Q](https://www.sec.gov/Archives/edgar/data/0001794515/000179451524000137/zi-20240630.htm)); GM drew the **largest-ever CCPA fine, $12.75M** (May 2026) for selling data to brokers ([IAPP](https://iapp.org/news/a/california-authorities-announce-largest-ccpa-fine-to-date)); FTC's record CAN-SPAM penalty is **Verkada $2.95M** ([FTC](https://www.ftc.gov/news-events/news/press-releases/2024/08/ftc-takes-action-against-security-camera-firm-verkada-over-charges-it-failed-secure-videos-other)); CAN-SPAM is now **$53,088/email**. Scraping carries contract/ToS liability (hiQ v. LinkedIn: public scraping not per-se CFAA, but hiQ still paid **$500K** + injunction). *(Clearview's "~$110M" total is **contested** — ~€90M base fines, exceeding €100M with penalties, largely unpaid.)* | Medium | High | **High** | Lawful-basis records (legitimate interest for corporate subscribers, validated by the Apr-2024 Experian Upper Tribunal win), DNC/suppression scrubbing, append-only audit log, and a current **GDPR Art. 28 DPA** (its absence auto-disqualifies in enterprise procurement). Never scrape against platform ToS. Pursue **SOC 2 Type II / ISO 27001** — these lag the plan today. |
| **R14 — Compliance differentiator outruns proof (the "designed-for" gap)** | Cognism, the closest positioning rival, *already has* CA broker registration, ISO 27001/27701 + SOC 2 Type II, documented legitimate-interest assessments, and 200M EU records ([Cognism](https://www.cognism.com/compliance)). TruePoint at MVP is **US-only, has no certs, no proprietary dataset, and defers EU residency** — so the compliance pitch is largely an intention. The send-gating half (suppression gating *sends*, DSAR fan-out SLA) lands at **M5/M9**, not day one. | High | High | **High** | Sequence credibility: ship in-transaction suppression gating reveal+send and DSAR fan-out at M5; pursue certs/registration on an explicit timeline; market only what is shipped. Until then, frame compliance as *architecture* (unbypassable, in-transaction) — a true structural claim — not as certifications it lacks. |

### 2.6 Customer adoption

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R15 — "Your CRM/Sales Nav + a VA already does this" (the do-nothing baseline)** | Most SMB prospects don't choose TruePoint vs. a named rival — they choose it vs. **Sales Nav + spreadsheet + VA**, or vs. their existing CRM's bundled AI. Incumbency/data gravity makes "why add another tool?" the default objection ([Pipedrive/Salesforce CRM cluster]). | High | High | **High** | Attack each DIY path's specific failure: one-click verified export + CRM sync (vs. Sales Nav's no-export), no management overhead (vs. VAs), fresh re-verified compliant data (vs. bought lists). Make switch triggers explicit: a deliverability scare, free-tier export caps, VA churn. |
| **R16 — Trust cold-start: a data/compliance product nobody has heard of** | The category runs on trust (verified data, honest billing) yet TruePoint has **zero reviews, zero track record, zero brand**. Buyers lean on G2 volume (Apollo 9,000+, Seamless 5,000+) and burned buyers fear another contract trap. A no-name asking for PII trust is a steep ask. | High | High | **High** | Lead with *demonstrable*, verifiable trust: published accuracy/bounce posture, no auto-renewal, one-click cancel, credit-back on bad data, transparent pricing — turning incumbents' loudest complaints (auto-renewal, data-destroy, surprise billing) into TruePoint's proof points. Seed reviews early; PLG free tier for low-risk trial. |
| **R17 — Onboarding/value-proof for a multi-step loop** | The promise is an end-to-end loop, but MVP delivers only find→reveal→score (send is M9). A buyer evaluating "the whole loop" sees a *partial* loop pre-M9, risking a "not finished" verdict — while the value story depends on the full loop. | Medium | Medium | **Medium** | Sequence go-to-market to the MVP's real strength (verified reveal + fair credits + compliance), not the unbuilt send engine; position MVP as "the trustworthy data+reveal core," expand messaging to full loop only as M9 ships. |

### 2.7 Pricing pressure

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R18 — Price floor is near zero at the low end** | Cheap data ($49–99/mo Lusha/RocketReach/UpLead), cheap cold-email ($37–94/mo Instantly/Smartlead), and **free tiers** (Apollo, Hunter, Kaspr) set a brutal anchor. Enrichment is being commoditized into CRMs (Breeze) — compressing pricing power for any standalone enrichment play ([Breeze](https://www.eesel.ai/blog/breeze-intelligence-data-enrichment)). | High | Medium | **High** | Don't sell enrichment alone (commodity); sell the *integrated, compliant loop* + fair economics. Compete on transparency/predictability vs. credit-burn and consumption-billing fatigue (the $2/conversation Agentforce backlash), not on being cheapest. |
| **R19 — Credit-economics model must beat the field on fairness *and* margin** | The market's loudest pricing pains — credits expiring use-it-or-lose-it (Apollo), charging a credit when no data is found (Seamless), 10-credit phone reveals (Lusha) — are exactly what TruePoint must avoid to differentiate ([Capterra](https://www.capterra.com/p/207295/Seamless-AI/reviews/)). But "don't charge for bad data + rollover + cheap reveals" squeezes unit economics on resold data TruePoint pays for. **All TruePoint pricing is placeholder.** | Medium | Medium | **Medium** | Model unit economics against real provider costs before finalizing packs; use first-reveal-wins + cache-first to protect margin; make fairness (no charge on miss, rollover) the visible differentiator while cache economics protect the spread. |
| **R20 — Margin compression from paying rivals for data** | Reselling Apollo/ZoomInfo/Clearbit data means TruePoint's COGS is set by competitors who can squeeze it (ties to R6). Thin margin + fair-billing promises + price-floor pressure is a hard triangle. | Medium | Medium | **Medium** | Cache-first reveal (re-reveal of an owned copy is free) and per-workspace first-reveal-wins limit repeat provider spend; tier expensive actions (phone, international) carefully; revisit provider mix as volume grows. |

### 2.8 Scalability

| Risk | Description / Evidence | Likelihood | Impact | Rating | Mitigation |
|---|---|---|---|---|---|
| **R21 — Technical scalability of multi-tenant, masked, 100M+-row design** | Designed for 100M+ rows with hard Postgres RLS isolation, Typesense CDC-fed search, KMS-masked PII, blind-index dedup, Redis/BullMQ workers — none built or tested. RLS + masked-until-reveal + waterfall enrichment at scale is non-trivial and can blow up latency/cost. | Medium | High | **High** | Load-test search + RLS early (post-M2); cache-first enrichment to cap provider cost/latency; keep ClickHouse analytics deferred until needed; treat 100M+ as a design target proven incrementally, not a launch requirement. |
| **R22 — Go-to-market & support scalability for a trust product** | Cross-vendor, the #2 emotional complaint after data is **post-sale support** ("non-existent," runarounds on cancellation) ([Datalane](https://www.datalane.com/post/zoominfo-customer-service)). A trust-led product that scales on PLG but neglects support recreates the exact pain it sells against — at a stage with no support headcount. | Medium | Medium | **Medium** | Make responsive support and self-serve cancellation an explicit product promise; instrument it; treat "we actually answer" as a differentiator. Scale via in-product self-service before headcount. |
| **R23 — Compliance operations scale (DSAR/deletion fan-out across per-workspace copies)** | Per-workspace ownership means each contact can exist in many isolated copies; a single DSAR/DROP deletion must **fan out across all of them** with a verification scan — and the dossier flags the DSAR-fan-out SLA as **unsolved**. At volume + Delete Act deadlines (45-day check / processing windows), manual handling fails. | Medium | High | **High** | Solve DSAR/deletion fan-out as core infrastructure at M5 (append-only audit, automated fan-out + verification scan); design for the Aug-2026 DROP cadence; do not let per-workspace ownership become a compliance-ops liability. |

---

## 3. The biggest existential risks (deep dive)

For a pre-launch entrant, three clusters deserve singling out because they can prevent product-market fit outright — not merely
dent a metric. They map to the three things TruePoint *does not own*: a moat, a dataset, and proof.

### 3.1 Competitive absorption — the differentiators are features, not moats (R4, R5)
TruePoint's whole thesis is "stop stitching five tools." But the dossier's strongest competitive signal is that the giants are
**eliminating the stitch from the other side** — bundling data + enrichment + scoring + sequencing + AI agents into the CRM
(Agentforce, Breeze) or the data platform (ZoomInfo GTM Studio) buyers *already* pay for
([ZoomInfo 8-K](https://www.sec.gov/Archives/edgar/data/0001794515/000179451524000132/zi-8kex991x20240805.htm)). "All-in-one"
is no longer a differentiator a startup can own; it's the incumbents' default. **The defensible ground is the narrow set of
things incumbents structurally won't build** because it conflicts with their lock-in: transparent, predictable, no-trap pricing;
CRM-neutrality; deliverability discipline; and compliance gating of the customer's *own sends*. TruePoint must accept it will
**lose** any breadth/AI-velocity contest with Apollo ($1.6B) and Clay ($3.1B) — and win, if at all, on focus, trust, and the
compliant full loop for the segment those two under-serve.

### 3.2 No proprietary data asset in a market whose #1 complaint is data (R6, R16, R20)
Data accuracy is the universal top complaint (real-world ~65–77% vs. 90%+ marketing — *figures flagged contested/soft in
verification*), and TruePoint's answer is **verification of other vendors' data, not its own**. This is a double bind: (a) its
accuracy ceiling is set by Apollo/ZoomInfo/Clearbit — its own competitors — who can raise prices, restrict APIs (Clearbit's
post-acquisition API shutdown is the precedent), or simply out-quality it; and (b) its margin is their COGS. TruePoint can make
data *trustworthy* (verify-on-reveal, no charge on miss, transparent bounce posture) even if it can't make it *bigger* — and that
is the right play, since the dossier is explicit TruePoint should **not** try to out-database anyone. But "we verify better" is a
thinner moat than "we own the data," and it must be paired relentlessly with the trust/billing/compliance wedge to matter.

### 3.3 The compliance wedge is real architecture but unproven, US-only, and partly deferred (R12, R13, R14, R23)
This is the sharpest differentiator *and* the riskiest claim. The **architecture** claim is genuinely strong and structural —
suppression gating both reveal **and** send, *inside the DB transaction*, unbypassable; DSAR fan-out across per-workspace copies;
append-only audit. No pure-data rival (Cognism doesn't send) and no cold-email tool (spam-adjacent reputation) can match the
"compliant data **and** compliant sending in one audited system" story. **But** the *proof* lags hard: the regulatory backdrop has
sharpened precisely around data brokers (Delete Act/DROP live, 4-state registries, $200/day penalties, GM's $12.75M CCPA fine),
which makes the bar a *moat for the prepared and a guillotine for the careless* — and at MVP TruePoint is US-only, holds **no SOC
2/ISO certs**, isn't broker-registered, defers EU residency, and lands the send-gating + DSAR-fan-out machinery at **M5/M9**.
Cognism already has the certs, registration, and EU data. So TruePoint must **earn** the compliance claim on a timeline: ship the
in-transaction gating and DSAR fan-out at M5, register as a data broker as a launch gate, pursue certs explicitly — and, until
then, market only the architecture it has actually built, never certifications it doesn't.

---

## 4. Rating summary

| # | Risk | Dimension | Likelihood | Impact | Rating |
|---|---|---|---|---|---|
| R1 | Crowded, undifferentiated field | Market saturation | High | High | **High** |
| R2 | Core market steady, not explosive | Market saturation | Medium | Medium | **Medium** |
| R3 | SMB/self-serve is most contested entry | Market saturation | High | Medium | **High** |
| R4 | Incumbent feature absorption | Competitive | High | Critical | **Critical** |
| R5 | Better-funded rivals out-execute on data/AI | Competitive | High | High | **High** |
| R6 | Dependence on competitors as data suppliers | Competitive | Medium | High | **High** |
| R7 | Shift to AI orchestration / GTM engineering | Tech disruption | Medium | High | **High** |
| R8 | Unproven architecture/scale | Tech disruption | Medium | High | **High** |
| R9 | Autonomous AI-SDRs make HITL look dated | AI disruption | Medium | High | **High** |
| R10 | AI-SDR collapse → category contagion | AI disruption | Medium | Medium | **Medium** |
| R11 | Buyer revolt + inbox gatekeeping shrink channel | AI disruption | High | Medium | **High** |
| R12 | Data-broker registration/deletion regime | Regulatory | High | High | **High** |
| R13 | Rising enforcement aimed at supply chain | Regulatory | Medium | High | **High** |
| R14 | Compliance pitch outruns proof | Regulatory | High | High | **High** |
| R15 | "CRM/Sales Nav + VA already does this" | Customer adoption | High | High | **High** |
| R16 | Trust cold-start (no brand/reviews) | Customer adoption | High | High | **High** |
| R17 | Partial-loop value proof pre-M9 | Customer adoption | Medium | Medium | **Medium** |
| R18 | Near-zero price floor at low end | Pricing pressure | High | Medium | **High** |
| R19 | Credit fairness vs. margin squeeze | Pricing pressure | Medium | Medium | **Medium** |
| R20 | Margin compression from paying rivals for data | Pricing pressure | Medium | Medium | **Medium** |
| R21 | Multi-tenant 100M+-row scalability | Scalability | Medium | High | **High** |
| R22 | GTM/support scalability for a trust product | Scalability | Medium | Medium | **Medium** |
| R23 | DSAR/deletion fan-out at scale | Scalability | Medium | High | **High** |

**Distribution:** 1 Critical · 14 High · 8 Medium · 0 Low. The concentration of **High** ratings is itself the finding: this is a
hard market for a pre-launch entrant, and almost none of the top risks are minor. The single **Critical** (R4, incumbent
absorption) is also the least mitigable by product alone — it is mitigated by *positioning discipline* (refuse the breadth contest;
own the trust/compliance/CRM-neutral wedge), which is why the strategic recommendation in
[Strategic Opportunities](06-strategic-opportunities.md) and the synthesis in [SWOT](08-swot.md) and the
[Executive Report](09-executive-report.md) all hinge on staying narrow rather than going broad.

---

## 5. Cross-cutting mitigation themes

Reading down the register, four mitigations recur and together form TruePoint's actual risk posture:

1. **Stay narrow on purpose.** Almost every High/Critical risk (R1, R3, R4, R5, R18) is mitigated by *not* competing on
   breadth/price/AI-velocity and instead owning the compliant, transparent-billing, CRM-neutral wedge incumbents won't touch.
2. **Earn the compliance claim on a timeline.** R12–R14 and R23 all resolve the same way: ship in-transaction gating + DSAR
   fan-out at **M5**, register as a broker as a launch gate, pursue SOC 2/ISO explicitly, and market only what's shipped.
3. **Turn incumbents' complaints into proof points.** R16 and R18–R19: auto-renewal traps, data-destroy clauses, surprise
   billing, charge-on-no-data are the loudest pains in the dossier — TruePoint's mitigation for the trust cold-start is to make
   the *opposite* of each a visible, verifiable promise.
4. **Ride the behavioural tailwinds, don't fight them.** R9–R11: the AI-SDR collapse and buyer/inbox revolt *favour* a compliant,
   human-in-the-loop, deliverability-disciplined product — provided the send engine (M9) actually ships well.

> **Final honesty check.** Every mitigation above is a **plan**, not a proven control — TruePoint has zero code and zero users.
> The ratings should be re-scored against measured data (bounce rates, churn, CAC, deliverability, DSAR throughput) once the MVP
> (M1–M5) is live; until then this register is a **pre-launch risk map**, not a performance assessment. Continue to
> [SWOT](08-swot.md) and the [Executive Report](09-executive-report.md).
