# 02 — Competitor Analysis

> Part of the **TruePoint Market Gap Analysis & PMF Audit**. Research date: **2026-06-01**.
> See the [Product Overview](00-product-overview.md) for the product baseline and [Market Research](01-market-research.md)
> for sizing/trends. This doc maps the competitive field; whitespace flows into [Market Gaps](03-market-gaps.md),
> [Product-Market Fit](04-product-market-fit.md), [Strategic Opportunities](06-strategic-opportunities.md), and the
> [SWOT](08-swot.md).
>
> **Stage caveat (carried through every section):** TruePoint is **pre-launch with zero code, zero users, and zero
> revenue**. Its pricing is **placeholder**, and every capability marked below as "has it" is a *planned* design-doc
> commitment, not a shipped feature. All comparison scores for TruePoint are therefore **PROJECTED**, not measured.
> Where a capability is MVP it is tagged **(M1–M5)**; where it is later roadmap it is tagged **(M7–M11)**.

---

## 1. How we segment the field

TruePoint's planned loop — **find → reveal verified email/phone → score → sequence → send**, inside a per-workspace,
compliance-gated, multi-tenant CRM — straddles three categories that the market normally buys separately
(see [Market Research §market structure](01-market-research.md)). We therefore split competitors into:

| Tier | Definition | Clusters covered |
|---|---|---|
| **Direct — data / intelligence** | Sell B2B contact/company data + reveal/enrichment; TruePoint's "find + reveal + verify" core | Apollo, ZoomInfo, Cognism, Lusha & Seamless.ai, RocketReach/UpLead/Lead411, Kaspr/Wiza/Hunter.io |
| **Direct — outreach / engagement** | Sequence and send outbound; TruePoint's "sequence + send" module (M9) | Outreach.io & Salesloft (enterprise SEPs); Instantly/Smartlead/Lemlist/Reply.io (cold-email) |
| **Indirect** | Adjacent platforms that *absorb* the loop or substitute for it | CRM-native (HubSpot/Salesforce/Pipedrive + Breeze/Clearbit); DIY (Sales Navigator + spreadsheets + VAs); AI-SDR agents (11x/Artisan/AiSDR/Qualified); GTM-orchestration (Clay) |

Apollo is the single most direct analogue (data **and** engagement in one self-serve seat). Cognism is the closest
**positioning** rival (compliance-first). Clay and the CRM incumbents are the biggest **absorption** threats. The DIY
stack is the true baseline most early buyers actually compare TruePoint against.

---

## 2. Direct competitors — data / intelligence

### 2.1 Apollo.io — the all-in-one PLG benchmark

- **Overview.** An all-in-one sales-intelligence + engagement platform (database, enrichment, sequences, dialer,
  light CRM, AI) sold self-serve, product-led. ~275M contacts / 60M companies; ~$150M ARR (May 2025), 3M+ users,
  $1.6B valuation. The closest functional analogue to TruePoint. [Apollo pricing](https://www.apollo.io/pricing) ·
  [UpLead overview](https://www.uplead.com/what-is-apollo-io/)
- **Key features.** 275M+ contacts, 65+ filters, 7-step email verification, multichannel sequences, US/intl dialer
  (gated by tier), AI email writer + AI Assistant + Scores & Signals, lightweight deals/pipeline CRM.
- **Pricing model.** Per-seat SaaS (Free / Basic $49 / Professional $79 / Organization $119 annual per user) **plus** a
  separate use-it-or-lose-it credit layer (email/mobile/export). Verified at these bands.
  [Apollo pricing](https://www.apollo.io/pricing) · [Warmly](https://www.warmly.ai/p/blog/apollo-pricing)
- **Strengths.** Unbeatable price-to-value vs ZoomInfo; true all-in-one in one seat; huge top-of-funnel DB;
  frictionless self-serve; strong US data; ~9,000 G2 reviews at 4.7–4.8 (G2 count verified ~9,344).
  [G2](https://www.g2.com/products/apollo-io/reviews) · [Apollo G2 Fall 2025](https://www.apollo.io/magazine/g2-fall-2025)
- **Weaknesses.** Data accuracy is the #1 complaint — claimed 91% email accuracy vs **reported** real-world ~65–80%,
  15–25% bounce; applying the "Verified Emails" filter collapses 275M → ~96M. *Verification note: these accuracy/bounce
  percentages are third-party/user-reported, not vendor-audited — treat as soft.* Weak international data; credit
  expiry; "predatory billing" reputation (auto-renew, chatbot-only cancellation). [Amplemarket](https://www.amplemarket.com/blog/what-does-apollo-really-do)
- **Review sentiment.** G2 4.7–4.8 (8,400–9,000+); Capterra 4.6; TrustRadius 8.3/10. Praise: value, breadth, DB size.
  Complaints (by volume): missing features, inaccurate data, learning curve, billing/auto-renewal.
  [BigIdeasDB](https://bigideasdb.com/complaints/apollo-complaints)
- **Positioning.** Classic PLG land-and-expand: cheap/free self-serve entry → seat expansion → "GTM system of record."
- **Missing vs TruePoint.** Transparently-verified data + bounce SLA; compliance-grade GDPR/CCPA posture; honest billing
  (no credit expiry, easy cancel); per-workspace isolation; built-in deliverability/warmup; lean UX (vs feature bloat).

### 2.2 ZoomInfo — the enterprise incumbent

- **Overview.** The dominant enterprise GTM data platform (NASDAQ: ZI). ~$1.2B FY2024 revenue (verified ~$1.26–1.28B
  guidance), ~1,900 customers at $100K+ ACV, 35,000+ companies. Sold top-down via opaque annual contracts; moving
  up-market. [Cleanlist pricing](https://www.cleanlist.ai/blog/2026-03-19-zoominfo-pricing-guide) ·
  [ZoomInfo 8-K](https://www.sec.gov/Archives/edgar/data/0001794515/000179451524000132/zi-8kex991x20240805.htm)
- **Key features.** One of the largest B2B DBs (direct dials, org charts, technographics), Bombora **account-level**
  intent, Copilot (AI), WebSight person-level de-anonymization, Engage (sequences/dialer), Chorus (conversation
  intelligence), GTM Workspace/Studio.
- **Pricing model.** Custom annual only, no self-serve. List bands ~$15K / ~$25–30K / ~$36–40K; **median actual
  ~$31,875/yr** across 1,313 verified purchases (Vendr); real-world commonly **$30K–60K/yr**. *Tier numbers are
  buyer-reported, not vendor-published.* [Vendr](https://www.vendr.com/marketplace/zoominfo) ·
  [ZoomInfo pricing](https://pipeline.zoominfo.com/sales/how-much-does-zoominfo-cost)
- **Strengths.** Best-in-class data depth; broadest integrated suite; strong AI momentum; enterprise credibility
  (Gartner ABM Customers' Choice 2025); deep Salesforce/HubSpot integration; public-company scale.
- **Weaknesses.** Very expensive; opaque pricing; the **notorious ~60–90-day auto-renewal trap** and 10–30% renewal
  hikes; a **"data-destroy" clause** forcing deletion of ZoomInfo-sourced + CRM-enriched records on cancellation;
  reported honeypot contacts / legal-threat retention tactics; inconsistent non-US accuracy; growth stalled (Q4 2024
  −2% YoY). [G2 auto-renewal thread](https://www.g2.com/discussions/sneaky-auto-renewal-clause-in-zoominfo-contract) ·
  [LinkedIn data-destroy PSA](https://www.linkedin.com/posts/blaineaberdeen_if-you-are-using-zoominfo-you-have-been-activity-7128496119961026560-PJJ9)
- **Review sentiment.** G2 ~4.5 (verified-practitioner skew); **Trustpilot 1.6/5** (burned SMB buyers); Capterra ~4.1.
  Contract/billing/support anger dominates 1-star reviews. [Trustpilot](https://www.trustpilot.com/review/zoominfo.com)
- **Compliance overhang.** **~$29.5M right-of-publicity class-action settlement** (CA/IL/IN/NV; exact
  $29,557,612.50), preliminarily approved June 2024 — *verified.* [Class Action Connect](https://www.classactconnect.com/cases/zoominfo-right-of-publicity-30-million-2024)
- **Positioning.** Premium "complete GTM platform," analyst-validated, AI-defended.
- **Missing vs TruePoint.** Transparent/self-serve/monthly pricing; no-lock-in contracts; SMB/prosumer tier;
  contact-level (not account-only) intent; a trust-forward consent-clean posture.

### 2.3 Cognism — the compliance-first, EU-strong rival

- **Overview.** London-based; the **compliance-by-design, EU-strong** alternative to ZoomInfo and **TruePoint's
  closest positioning rival**. ~440M contacts (~200M European), Diamond Data phone-verified mobiles (~98% on the
  ~10M Diamond subset). Annual quote-based, no free plan. New CEO Sept 2025.
  [Cognism compliance](https://www.cognism.com/compliance) · [Diamond Data](https://www.cognism.com/diamond-data)
- **Key features.** Diamond Data + Diamonds-on-Demand; registered CA data broker; **ISO 27001 + ISO 27701 + SOC 2
  Type II**; documented legitimate-interest/DPIA; DNC/TPS scrubbing across 13+ countries; deep EMEA coverage;
  Bombora intent; CRM + Chrome integrations.
- **Pricing model.** Annual, quote-based: a fixed platform fee **plus** per-seat. Third-party estimates ~$15K (Grow)
  / ~$25K (Elevate) platform + ~$1.5K/$2.5K per seat. *Verification note: Cognism's live page now names the tiers
  **"Standard" and "Pro"**, not Grow/Elevate or Platinum/Diamond — the dollar ranges are directional reseller
  estimates, the tier names in older write-ups are stale.* [Cognism pricing](https://www.cognism.com/pricing) ·
  [Salesmotion](https://salesmotion.io/blog/cognism-pricing)
- **Strengths.** Strongest compliance posture in the category (the dataset EU legal teams will sign off on);
  best-in-class EU/EMEA coverage; phone-verified Diamond mobiles with a real 2–3x connect lift; "unrestricted"
  fair-use model reduces credit anxiety; G2 ~4.5–4.6 (~1,100–1,200). [G2](https://www.g2.com/products/cognism/reviews)
- **Weaknesses.** Expensive/opaque, no free plan/trial; **weak North America / APAC** coverage (a test found ~62.5%
  of mobiles/dials incomplete; the 98% claim is the Diamond subset only, ~2.3% of the DB); rigid annual terms with
  60-day cancellation and 10–15% annual hikes; **it does not send** — a pure data/intelligence vendor, so customers
  still buy a separate sequencer. [Amplemarket](https://www.amplemarket.com/blog/what-does-cognism-really-do)
- **Review sentiment.** G2 4.5–4.6. Praise: EMEA data, Diamond connect rates, GDPR posture, support. Complaints:
  price/upsells, NA/APAC gaps, rigid contracts, slow Diamonds-on-Demand feedback.
- **Positioning.** "The compliant, EU-first ZoomInfo alternative" — premium, high-touch, annual.
- **Missing vs TruePoint — the load-bearing distinction.** Cognism's compliance is about **the lawfulness of its own
  data sourcing**. TruePoint's planned compliance **(M5)** is about **governing the customer's USE end-to-end**:
  in-transaction suppression that gates **both reveal and outbound send**, DSAR access/delete **fan-out across
  per-workspace copies**, append-only audit, CAN-SPAM footer enforcement, bounce/complaint→auto-suppression — none
  of which Cognism offers **because it does not send**. *Caveat: Cognism actually holds the data, certs, and broker
  registration **today**; TruePoint has none of this at MVP (US-only, certs are open questions, no proprietary
  dataset). To beat Cognism on compliance, TruePoint must first earn the certs/registrations and prove EU residency —
  see [Risk Assessment](07-risk-assessment.md).*

### 2.4 Lusha & Seamless.ai — the affordable extension-led tier

- **Overview.** Two self-serve, extension-led, credit-priced data tools below ZoomInfo/Apollo. **Lusha** (~150M→280M
  claimed contacts) markets accuracy + compliance + transparent pricing. **Seamless.ai** (claims 1.7B contacts) is a
  real-time "AI search engine," sales-led and opaque, defined in-market by its **contract/billing reputation**.
  [Lusha pricing](https://www.lusha.com/pricing/) · [Cognism on Seamless](https://www.cognism.com/blog/seamless-ai-pricing)
- **Key features.** Both: Chrome/LinkedIn reveal, CRM enrichment, intent, API, credit metering. Lusha: 1 credit/email,
  **10 credits/phone** (doubled from 5). Seamless: live research, Autopilot list-building; **charges a credit even
  when data is bad/unfindable**.
- **Pricing model.** Lusha publishes transparent monthly tiers (Free / Starter ~$49.90 / Professional ~$69.90 /
  Premium ~$399.90 mo) with credit roll-up to 2× — *verified.* Seamless is opaque/sales-led above a ~$147/mo Basic
  (250 credits), 5-seat Pro minimum, annual upfront, no rollover — *Pro/Enterprise figures unpublished/unverified.*
- **Strengths.** Lusha: transparent pricing (rare), great extension UX, GDPR-marketed, credit roll-up. Seamless: very
  large claimed DB, real-time research, high G2 volume (4.4, 5,000+).
- **Weaknesses.** Lusha: real accuracy lags marketing (reviewers report up to ~40% inaccuracy); 10-credit phones burn
  fast; weak EU/CEE; **Trustpilot ~1.4/5**. Seamless: **the worst contract/billing reputation in the category** —
  ~30–60-day auto-renewal trap, surprise charges (a 2025 BBB case cites a ~$3,408 charge after declining renewal),
  not BBB-accredited, **LinkedIn removed its company page in early 2025 over scraping-policy violations**; credits
  burned on bad data; 20–30% bounce despite ~98% marketing. [Lusha review](https://www.marketbetter.ai/blog/lusha-review-2026/) ·
  [Seamless BBB](https://www.bbb.org/us/oh/columbus/profile/sales-lead-generation/seamlessai-0302-70104676/complaints)
- **Review sentiment.** Lusha: G2 ~4.3, Capterra ~4.0, Trustpilot ~1.4. Seamless: G2 ~4.4, Capterra ~4.4, with
  auto-renewal/cancellation the #1 complaint everywhere.
- **Positioning.** The affordable, extension-first prospecting tier — Lusha "trustworthy/EU-friendly," Seamless
  "find anyone, build big lists fast."
- **Missing vs TruePoint.** Neither is a full GTM/CRM (no native sequencing/dialer); both have an accuracy-vs-marketing
  credibility gap and no credit-back-on-bad-data guarantee; Seamless has a weak compliance/governance story.

### 2.5 RocketReach / UpLead / Lead411 — the self-serve mid-tier

- **Overview.** A cluster of affordable, self-serve data vendors below ZoomInfo/Apollo. **RocketReach** = breadth
  (700M+ profiles, freelancer-friendly); **UpLead** = accuracy (95–97% claim, real-time verification + **credit
  refund on bad data**); **Lead411** = US outbound + bundled Bombora intent at a low price.
  [RocketReach](https://rocketreach.co/pricing) · [UpLead](https://www.uplead.com/pricing/) · [Lead411](https://www.lead411.com/pricing/)
- **Key features.** Credit/export-metered DB access, Chrome extensions, CRM sync; RocketReach adds basic "Autopilot"
  outreach; Lead411 adds intent + sales triggers.
- **Pricing model.** Self-serve, monthly or annual. RocketReach Essentials $69 / Pro $119 / Ultimate $209 mo — verified.
  UpLead Essentials $74 / Plus $149 annual — verified. Lead411 Spark ~$49/mo & Blaze custom — *but Ignite now starts
  ~$3,000/yr, higher than older ~$1,500/yr quotes (verification flag).*
- **Strengths.** Dramatic price undercut of ZoomInfo with no sales call; differentiated angles (breadth / accuracy+refund
  / intent-bundling). UpLead rated #1 G2 "Easiest to Use" / "Best ROI."
- **Weaknesses.** Inconsistent, credit-limited data; **narrow scope — data sources, not platforms** (no real
  sequencing/CRM); Lead411 has the weakest freshness (90-day refresh, ~80% email accuracy, 5–10% bounce); UpLead has
  no-refund/auto-renew billing friction; thin SMB/international coverage.
- **Review sentiment.** RocketReach G2 ~4.5; UpLead G2 ~4.7 (best in cluster); Lead411 G2 ~4.5. Common complaints:
  stale/incomplete data, credit caps, billing trust, weak non-US coverage.
- **Positioning.** The affordable, self-serve mid-tier — explicitly "cheaper, simpler than ZoomInfo/Apollo/Cognism."
- **Missing vs TruePoint.** No native sequencing/send; not a CRM; no AI orchestration/scoring; thin compliance
  governance; data-freshness lags.

### 2.6 Kaspr / Wiza / Hunter.io — single-step point tools

- **Overview.** Three lightweight point tools that each attack **one** slice of TruePoint's loop. **Kaspr** (Cognism-owned)
  = LinkedIn/Sales-Nav phone+email reveal, EU-strong. **Wiza** = Sales Navigator list-to-CSV/CRM exporter with live
  SMTP verification. **Hunter.io** = the domain email finder/verifier (6M+ users), **email-only, zero phone**.
  [Kaspr](https://www.kaspr.io/pricing) · [Wiza](https://wiza.co/pricing) · [Hunter](https://hunter.io/pricing)
- **Pricing model.** All freemium + credit-metered, SMB-priced. Hunter Starter $34 / Growth $104 / Scale $209 annual —
  verified. Kaspr Free / Starter €45 / Business €79 annual — verified. Wiza Email $99 / Email+Phone $199 mo (annual
  "unlimited" capped ~30K exports/yr) — verified. **Wiza requires the user's own Sales Navigator seat (+$79–139/mo).**
- **Strengths.** Kaspr: best EU mobile coverage in the cluster, "unlimited" B2B emails even on Free. Wiza: fastest
  Sales-Nav-list-to-CSV with live verification, low bounce. Hunter: trusted incumbent, strong verifier (~97%),
  generous free tier, unlimited team members.
- **Weaknesses.** **Kaspr: CNIL fined it €240,000 in Dec 2024** for GDPR violations (scraping restricted profiles,
  excessive retention) — a live trust wound; accuracy drops sharply outside Europe (a Reddit benchmark found ~66% phone
  match on FR leads). Wiza: economically dependent on a Sales Nav seat it doesn't include; LinkedIn ToS/account risk.
  Hunter: **no phone data at all**; thin SMB coverage; outdated-email complaints.
  [Kaspr review](https://prospeo.io/s/kaspr-reviews) · [Wiza review](https://prospeo.io/s/wiza-reviews)
- **Review sentiment.** Kaspr G2 4.4 / Trustpilot 1.5; Wiza G2 4.5; Hunter G2 4.4 / Capterra 4.6 (most consistently
  liked).
- **Positioning.** Single-purpose substitutes for one step of the loop — not the loop.
- **Missing vs TruePoint.** No multi-tenant per-workspace ownership; no end-to-end loop (no scoring, no send except
  Hunter's light campaigns); **no compliance-as-a-feature** (Kaspr's CNIL fine underlines the gap); no tenant credit
  pool; Hunter has no phone, Wiza/Kaspr depend on a LinkedIn license they don't provide.

---

## 3. Direct competitors — outreach / engagement

### 3.1 Outreach.io & Salesloft — enterprise sales-engagement platforms

- **Overview.** The two dominant enterprise SEPs ("AI revenue execution / orchestration"), sitting **on top of a CRM**
  to orchestrate human-led multichannel sequences + dialer + conversation intelligence + forecasting. **They are NOT
  data providers** and don't run cold email at scale. Outreach last valued ~$3.3B; Salesloft taken private by Vista at
  ~$2.3B (2021), bought Drift (2024). [Outreach pricing](https://www.outreach.ai/pricing) ·
  [Salesloft pricing](https://www.salesloft.com/pricing)
- **Pricing model.** Opaque, demo-gated, per-seat annual, seat minimums + AI-credit consumption + $5K–25K implementation.
  Outreach ~$100–175+/seat/mo; Salesloft ~$75–165+/seat/mo. *All reseller estimates — neither publishes list.*
  [MarketBetter Salesloft](https://marketbetter.ai/blog/salesloft-pricing-breakdown-2026/)
- **Strengths.** Category-defining brand/enterprise trust; best-in-class sequence engine; full-stack consolidation;
  aggressive agentic-AI roadmaps; high G2 (Salesloft 4.5, Outreach 4.3). [G2 compare](https://www.g2.com/compare/outreach-vs-salesloft)
- **Weaknesses.** Opaque/high pricing (#1 complaint); 2–4-week ramp + dedicated-admin complexity ("bloated"); rigid
  annual/multi-year + seat minimums; **weak dialers**; weaker HubSpot integration; and the **Aug 2025 Salesloft Drift
  OAuth supply-chain breach** (UNC6395) that hit 700+ Salesforce orgs and forced Drift offline — a live trust liability.
  [Mandiant breach](https://cloud.google.com/blog/topics/threat-intelligence/data-theft-salesforce-instances-via-salesloft-drift)
- **Review sentiment.** Outreach 4.3 (~3,500); Salesloft 4.5 (~4,260 product reviews; far more across all listings).
  *Verification note: "3,400–3,900 reviews each" understates Salesloft's true total.*
- **Positioning.** Premium top-of-stack execution layer for 15–500+ rep teams; explicitly **not** SMB/startup/agency.
- **Missing vs TruePoint.** No built-in data/lead source (need a separate vendor); no cold-send/inbox-rotation/warmup
  infrastructure; weak dialer; no transparent self-serve SMB entry; CRM-dependent.

### 3.2 Instantly / Smartlead / Lemlist / Reply.io — the cold-email cluster

- **Overview.** Four high-velocity cold-email tools built to send at scale and land in the inbox: connect many
  mailboxes, rotate, warm up, sequence, unified reply inbox. Instantly/Smartlead are deliverability-first
  ("infrastructure"); Lemlist/Reply.io are personalization + multichannel. The defining 2024–26 trend: all but
  Smartlead bolted on their own **450–650M B2B databases**, collapsing "buy data then send" into one tool — directly
  validating TruePoint's find+send bet. [UnifyGTM](https://www.unifygtm.com/explore/best-cold-email-software-2026)
- **Pricing model.** Cheap working tier $37–100+/mo. Instantly Growth $37 / Hypergrowth $97 / Light Speed $358
  (+ a separate stacking Credits DB subscription) — verified. Smartlead Base $39 → Unlimited Prime $379 — verified.
  Lemlist Email $39 / Multichannel $109 — verified. Reply.io Email Volume from ~$49 / Multichannel ~$89–99 / Jason AI
  SDR from ~$500/mo — *Multichannel base ~$89 and Jason AI floor ~$500 corrected from older quotes.*
  [Instantly](https://instantly.ai/pricing) · [Smartlead](https://www.smartlead.ai/pricing) ·
  [Lemlist](https://www.lemlist.com/pricing) · [Reply.io cost](https://www.amplemarket.com/blog/how-much-does-reply-io-really-cost)
- **Strengths.** Instantly: highest-rated/most-reviewed (G2 4.8, 3,400+), unlimited mailboxes + 450M DB. Smartlead:
  best deliverability tooling (placement testing, dedicated IPs). Lemlist: strongest personalization + native
  multichannel, 450–650M DB on all plans. Reply.io: most mature engagement feature set + packaged AI SDR (Jason AI).
- **Weaknesses.** Instantly: deliverability complaints, 2025 credits-model confusion, DFY-domain **lock-in** (retained
  by Instantly). Smartlead: expensive client/workspace charges, **no native DB**. Lemlist: **worst deliverability
  complaints** (reviewers report ~62% inbox placement vs 78–85% alternatives), per-seat scaling pain. Reply.io: price
  stacks with channel add-ons; LinkedIn automation risks account blocks.
- **Review sentiment.** Instantly G2 4.8 / Trustpilot ~4.0 (deliverability + lock-in gripes); Smartlead ~4.6;
  Lemlist 4.4–4.6; Reply.io 4.6. Classic G2-positive vs Trustpilot/Reddit-critical split.
- **Positioning.** Two camps — deliverability/infra (Instantly, Smartlead) vs personalization/multichannel
  (Lemlist, Reply.io); all but Smartlead repositioning as "find + send in one tool."
- **Missing vs TruePoint.** No deep multi-tenant prospecting CRM with hard RLS per-workspace ownership; **weak
  compliance-as-a-feature** (the opposite of TruePoint's "we are not a spam tool" stance); no reveal-credit model with
  per-workspace first-reveal ownership; no distinct versioned lead-scoring layer.

---

## 4. Indirect competitors

### 4.1 HubSpot / Salesforce / Pipedrive — the CRM-native "your CRM already does this" threat

- **Overview.** The three incumbent CRMs, each absorbing prospecting + enrichment + sequencing + AI-SDR as **up-sell
  add-ons**. HubSpot (Breeze AI: Prospecting Agent + Breeze Intelligence/ex-Clearbit), Salesforce (Einstein +
  **Agentforce** agentic SDRs + Data Cloud), Pipedrive (Pulse + LeadBooster/Prospector). This is TruePoint's most
  existential absorption threat: they own the data gravity. [HubSpot](https://www.hubspot.com/pricing/sales) ·
  [Salesforce Agentforce](https://www.salesforce.com/agentforce/pricing/) · [Pipedrive](https://www.pipedrive.com/en/features/lead-generation-software)
- **Pricing model.** Cheap-looking per-seat CRM core, then expensive gated add-ons + consumption/credit/outcome billing.
  *Verification flags: HubSpot Sales seats are now ~$20 (Starter) / ~$100 (Pro) / ~$150 (Enterprise) — older $9/$90
  quotes are low; Salesforce Enterprise list is ~$165 (not $175), Unlimited ~$330, Agentforce 1 Sales $550; Pipedrive
  rebrand was **Nov 2025** (Lite ~$14 / Growth ~$24–39 / Premium ~$49 / Ultimate ~$69–79).* Real prospecting stacks run
  **$1.5K–5K+/mo** once add-ons stack. [MarketBetter Salesforce](https://marketbetter.ai/blog/salesforce-sales-cloud-pricing-breakdown-2026/) ·
  [Pipedrive plans](https://support.pipedrive.com/en/article/new-pipedrive-plans)
- **Strengths.** Incumbency/data gravity; all-in-one consolidation; deep ecosystems; bundled AI removes a buying
  decision; HubSpot ease-of-use, Salesforce enterprise depth (Agentforce + Data Cloud moat), Pipedrive cheap fast UX.
- **Weaknesses.** Steep all-in cost once add-ons stack; **native enrichment is single-/few-source and shallow** vs
  dedicated tools; AI agents are only as good as the data already in the CRM; credit/outcome billing is unpredictable
  (the $2/conversation Agentforce backlash); each platform's AI is **locked to its own ecosystem**.
- **Review sentiment.** HubSpot ~4.4–4.5; Salesforce 4.4 (G2 #1 Product 2025, but small SDR teams skew mixed);
  Pipedrive Capterra 4.5 / G2 4.3 (weak support, thin automation/reporting).
- **Positioning.** "Your CRM already does prospecting + enrichment + AI — natively. Toggle on the AI SDR."
- **Missing vs TruePoint.** Best-in-class multi-source/waterfall data; outbound deliverability tooling
  (rotation/warmup); affordable predictable outbound-first pricing; **CRM-neutral** prospecting that feeds *any* CRM;
  fast time-to-value for a pure prospecting workflow.

### 4.2 Clearbit → HubSpot Breeze Intelligence — the cautionary "enrichment goes CRM-native" tale

- **Overview.** Clearbit, the leading standalone enrichment + visitor-reveal vendor, was acquired by HubSpot (Dec 2023)
  and folded into "Breeze Intelligence" — **HubSpot-only**, no standalone, free tools and APIs sunset through 2025.
  The canonical proof that enrichment is becoming a CRM-native, credit-metered commodity.
  [HubSpot acquisition](https://www.hubspot.com/company-news/hubspot-completes-acquisition-of-b2b-intelligence-leader-clearbit) ·
  [eesel deep dive](https://www.eesel.ai/blog/breeze-intelligence-data-enrichment)
- **Pricing model.** Credit-based add-on inside HubSpot; *post-June-2025 it runs on unified HubSpot Credits with a
  ~$45/mo floor (100 credits) and ~$10/1,000-credit packs — older "$30 premium / $50 Starter" tiering is outdated
  (verification flag).* Migrating teams report 30–60% cost increases vs old Clearbit.
- **Strengths.** Best-in-class native HubSpot integration; strong US firmographic data; large foundation (200M+);
  form-shortening lifts conversion; instant distribution to HubSpot's base.
- **Weaknesses.** **Total HubSpot lock-in** (no standalone/API, no Salesforce); inconsistent contact-level accuracy
  (G2's #1 con is "Inaccurate Data"); company-level (not person-level) visitor reveal; rising credit costs; sunset of
  beloved free tools alienated the developer base. Reddit sentiment toward the transition is "brutal."
- **Review sentiment.** Legacy Clearbit G2 ~4.4; firmographic data rated high (~9.3/10 TrustRadius) but contact-level
  accuracy is the recurring complaint.
- **Positioning.** "The native enrichment + intelligence layer of HubSpot."
- **Missing vs TruePoint.** CRM-agnostic/open-API; verified net-new contact data (emails+dials); person-level
  de-anonymization; strong international coverage; transparent non-expiring pricing; the orphaned ex-Clearbit
  free-tool/developer audience.

### 4.3 Clay — the GTM-orchestration bellwether (validation **and** threat)

- **Overview.** The category-defining "GTM engineering" / data-orchestration platform: a table-native workspace whose
  core mechanic is **waterfall enrichment** across 100+/150+ providers (pay-per-hit, ~80%+ match vs 40–50%
  single-source), plus Claygent AI research agents. **$100M Series C at a $3.1B valuation (Aug 2025, CapitalG),
  ~$100M ARR, 10,000+ customers** (OpenAI, Anthropic, Canva, Rippling) — *verified.* [Clay pricing](https://www.clay.com/pricing) ·
  [TechCrunch](https://techcrunch.com/2025/08/05/clay-confirms-it-closed-100m-round-at-3-1b-valuation/)
- **Pricing model.** Unlimited seats + two usage meters (Data Credits + Actions). *Verification flag: Clay restructured
  (~Mar 2026) to Free / Launch (~$185/mo annual) / Growth ($495 mo, ~$446 annual) / Enterprise (from ~$30K/yr) and
  cut data-credit unit costs sharply; the older Starter $149 / Explorer $349 / Pro $720 tiers are legacy-only.*
- **Strengths.** Best-in-class coverage via waterfall; extreme programmable flexibility; Claygent/Sculptor AI moat;
  unlimited seats; enormous momentum + an agency/"GTM engineer" ecosystem; power-user G2 ~4.7–4.8.
- **Weaknesses.** **Steep learning curve** (the #1 complaint — a "workflow IDE," often needs a RevOps operator or paid
  agency); **unpredictable, escalating cost** (the two-meter model "burns fast"); **not an execution platform** (no
  dialer, weak/secondary native sequencing, no CRM of record, limited verification); polarized sentiment (power users
  love it, solo operators churn). [Clay pros/cons](https://www.g2.com/products/clay-com-clay/reviews?qs=pros-and-cons)
- **Positioning.** The AI-native orchestration layer **on top of** data vendors + execution tools — deliberately
  **not** all-in-one; interoperability is the value.
- **Missing vs TruePoint.** Turnkey opinionated find→reveal→score→sequence→send for non-technical reps;
  **compliance-as-a-feature** (suppression/consent/DSAR/DNC gating reveal *and* send — a surface Clay essentially
  ignores); simple predictable tenant credits; native dialer/CRM-of-record. *Threat to respect: Clay keeps moving
  down-stack (already added a Sequencer + signals), and its waterfall structurally beats TruePoint's planned 3-source
  enrichment on raw coverage — TruePoint must NOT compete on data breadth.*

### 4.4 AI-SDR agents (11x / Artisan / AiSDR / Qualified) — the discrediting forward threat

- **Overview.** Venture-backed "autonomous AI SDR / digital worker" startups (11x's Alice, Artisan's Ava, AiSDR,
  Qualified's Piper). The category rode a loud "replace your SDR" narrative through 2024–25, then cooled hard: documented
  **50–70% churn within 90 days**, deliverability collapse, "AI slop" rejection, an **11x credibility scandal**, and a
  pivot to hybrid "1 human + 2–4 AI" pods. **Salesforce agreed to acquire Qualified (Dec 2025)** — consolidation.
  [Prospeo AI-SDRs](https://prospeo.io/s/ai-sdrs) · [Leadgen Economy](https://www.leadgen-economy.com/blog/ai-sdr-cancellation-wave-failure-forensics/)
- **The 11x cautionary tale (verified, with one correction).** 11x claimed **~$10M ARR** (older write-ups say $14M;
  *TechCrunch reporting says "approached $10M"* — verification correction) while only **~$3M was real**, with 70–80%
  early churn and **unauthorized customer logos** (ZoomInfo — a one-month trial it kept listing ~12 months — and
  Airtable). Funded $24M (Benchmark) + $50M (a16z) at ~$350M. Founder stepped aside May 2025.
  [TechCrunch](https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have/)
- **Pricing model.** Mostly sales-led/quote-based "digital labor": AiSDR $900/mo (Explore) → **$2,500/mo (Grow,
  ~4,500 msgs — corrected upward from older $2,000/3,600 quotes)**; Artisan ~$2K→$5K+/mo (*third-party est.*); 11x
  ~$40–60K/yr (*est.*); Qualified ~$40–68K/yr + a required ~$30–60K Salesforce stack ≈ **$95–165K/yr all-in** (*est.*).
  Benchmark: a human SDR loaded cost is ~$75–100K/yr. [AiSDR pricing](https://aisdr.com/pricing/)
- **Strengths.** Heavy VC funding/brand momentum; genuine 24/7 autonomy at marginal cost; Qualified has real enterprise
  traction (now Salesforce); strong category tailwind (AI-SDR market $4.12B 2025 → $15.01B 2030 at 29.5% CAGR — *verified*).
- **Weaknesses.** Severe churn (50–70% in 90 days vs 5–10% SaaS norm); deliverability collapse caps ~47% of deployments;
  "AI slop" instantly archived/spam-flagged; CRM contamination; pure-AI pods underperform hybrid pods on closed-won by
  22 points; thin review validation; high oversight burden (15–20 hrs/week) contradicting the "autonomous" pitch.
  *Caveat: churn/deployment figures are trade-press estimates, not audited.*
- **Positioning.** Originally "AI employees that replace your SDR team"; softening to augmentation by 2026.
- **Missing vs TruePoint.** Deliverability/sender-reputation discipline; mandatory human-in-the-loop approval gates;
  rigorous data verification/hygiene; compliance posture (consent/suppression); honest, auditable metrics (the 11x
  scandal is a trust wound). This is TruePoint's clearest "augmented human, not autonomous slop" wedge.

### 4.5 DIY — Sales Navigator + spreadsheets + VAs + bought lists (the true baseline)

- **Overview.** Not a product but the cluster of do-it-yourself substitutes most early/SMB buyers actually compare
  TruePoint against: (1) Sales Navigator + manual copy-paste into Sheets; (2) offshore VAs/freelance list-builders;
  (3) bought broker lists; (4) stitched free tiers (Apollo/Hunter/LinkedIn free). The "build vs buy / good-enough free"
  objection. [Sales Nav price](https://www.topo.io/blog/linkedin-sales-navigator-price) ·
  [PhantomBuster export](https://phantombuster.com/blog/sales-prospecting/linkedin-sales-navigator-export-leads/)
- **Pricing model.** Mixed: Sales Nav per-seat (*current list raised to ~$119.99 Core / ~$159.99 Advanced monthly —
  verification flag*); VAs ~$13–45/hr or ~$900–2,720/mo dedicated; broker lists ~$300–1,000+/1,000 records;
  free tiers $0 cash but capped (Apollo free's ~10 export credits/mo is the binding wall). *VA/broker rate figures are
  directional, not primary-source-verified.*
- **Strengths.** Zero procurement friction; Sales Nav genuinely has the deepest, freshest B2B search filters; VAs are
  infinitely flexible; bought lists give instant scale; free tiers cost nothing to test a market.
- **Weaknesses.** Manual and non-repeatable (Sales Nav has **no native bulk export and no emails** — copy-paste or risky
  scraper bans); data decays ~2.1%/mo (~30%/yr); **bought lists carry severe compliance exposure** — CAN-SPAM up to
  **$53,088/email** (eff. Jan 2025, *verified*), GDPR up to €20M/4%, CASL up to CA$10M, and the **sender carries
  liability regardless of broker**; VA quality is a lottery; no verification/enrichment/CRM-sync layer.
  [CAN-SPAM/GDPR](https://instantly.ai/blog/b2b-email-list-compliance-gdpr-canspam/)
- **Positioning.** The "do-nothing-different" inertia baseline; "good enough until it isn't."
- **Missing vs TruePoint.** Verified deliverability-safe data out of the box; one-click export + CRM sync; automatic
  re-verification; a single search→verify→export→sequence workflow; **compliance guardrails** (suppression/consent)
  that bought lists and VA sheets entirely lack; repeatability + audit trail.

---

## 5. Comparison tables

### 5.1 Feature matrix — competitors vs TruePoint

Legend: ● = strong/native · ◐ = partial / gated / add-on · ○ = absent. **TruePoint cells are PROJECTED from the plan,
not measured**; MVP capabilities tagged **(M1–M5)**, later roadmap **(M7–M11)**.

| Capability | TruePoint (projected) | Apollo | ZoomInfo | Cognism | Lusha/Seamless | RocketReach/UpLead/Lead411 | Clay | Outreach/Salesloft | Instantly cluster | HubSpot/SFDC/Pipedrive | AI-SDR agents |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **End-to-end loop** (find→reveal→score→sequence→send in one app) | ● *find/reveal/score MVP; send M9* | ● | ◐ (Engage add-on) | ○ (data only) | ○ | ○ | ◐ (orchestrate, bolt-on send) | ◐ (send only, no data) | ◐ (send + DB, no CRM) | ◐ (autonomous, narrow) | 
| **Verified email/phone on reveal** | ● **(M4)** | ◐ (claim 91% / real ~65–80%) | ◐ (inconsistent non-US) | ● (Diamond phone) | ◐ (accuracy gap) | ◐ (UpLead best) | ◐ (waterfall, no native verify) | ○ | ◐ | ◐ (shallow) | ◐ |
| **Compliance / DSAR** (suppression gates reveal **and** send; consent; DSAR fan-out; audit) | ● **(M5)** | ○ | ◐ (policy, +legal overhang) | ◐ (own-data sourcing only) | ○ (Seamless weak) | ○ | ○ | ◐ (policy) | ○ | ◐ (CRM-level) | ○ |
| **Per-workspace data isolation** (own copies, hard RLS) | ● **(M2)** | ○ (shared DB) | ○ | ○ (org-wide) | ○ | ○ | ◐ (workspaces, shared data) | ◐ (CRM-scoped) | ◐ (client workspaces) | ○ | ○ |
| **Built-in send** (sequences + deliverability) | ◐ **(M9, post-MVP)** | ● | ◐ (Engage) | ○ | ○ | ◐ (RocketReach Autopilot) | ◐ (newer Sequencer) | ● | ● (best) | ◐ (gated add-on) | ● |
| **AI** (drafting / research / scoring) | ◐ *scoring MVP; drafting M9* | ● | ● (Copilot) | ◐ | ◐ | ○ | ● (Claygent moat) | ● (agentic) | ◐ | ● (Agentforce/Breeze) | ● (core) |
| **CRM** (pipeline / deals) | ◐ *light, prospecting-CRM* | ◐ (lightweight) | ◐ (via Engage) | ○ | ○ | ○ | ○ (syncs out) | ◐ (deal mgmt) | ○ | ● (the CRM) | ○ |
| **Public API** | ◐ **(M10, post-MVP)** | ● | ● | ◐ | ◐ | ◐ | ● | ● | ◐ | ● | ◐ |
| **Transparent self-serve pricing** | ● *(planned)* | ● | ○ (opaque) | ○ (quote) | ◐ (Lusha ●, Seamless ○) | ● | ◐ (two-meter) | ○ (demo-gated) | ● | ◐ (gated add-ons) | ○ (quote) |

**Reading the matrix.** No incumbent is strong across **end-to-end loop + verified-on-reveal + compliance/DSAR +
per-workspace isolation** simultaneously — that intersection is TruePoint's projected white space. The columns where
TruePoint is weakest (built-in send, AI breadth, raw data coverage, public API) are precisely the areas it consciously
defers to post-MVP or declines to fight on (see [Market Gaps](03-market-gaps.md)).

### 5.2 Pricing-model comparison

| Competitor / cluster | Model | Entry / working price | Contract & friction | Notable trap |
|---|---|---|---|---|
| **Apollo** | Per-seat + use-it-or-lose-it credits | $49–119/seat/mo (annual) | Monthly available; auto-renew | Credit expiry; chatbot-only cancellation |
| **ZoomInfo** | Opaque custom annual | ~$15K list → **median ~$31,875/yr**, real $30–60K | Annual; ~60–90-day cancel notice | Auto-renew + **data-destroy clause** + renewal hikes |
| **Cognism** | Platform fee + per-seat, quote-based | ~$15K–25K platform + ~$1.5–2.5K/seat (*est.*) | Annual upfront; 60-day cancel; 10–15% hikes | No free plan/trial; NA/APAC gaps |
| **Lusha** | Self-serve seat + credits (transparent) | $0 / $49.90 / $69.90 / $399.90 mo | Monthly; credit roll-up to 2× | 10 credits/phone |
| **Seamless.ai** | Sales-led, opaque, annual | ~$147/mo Basic (250 credits) | Annual upfront; 5-seat Pro min | **~30–60-day auto-renewal trap**; charges for bad data |
| **RocketReach/UpLead/Lead411** | Self-serve seat + export credits | $49–119/mo | Monthly/annual | UpLead no-refund/auto-renew; Lead411 stale data |
| **Kaspr/Wiza/Hunter** | Freemium + credits | €45 / $99 / $34 mo | Monthly/annual | Wiza needs own Sales Nav; Hunter no phone |
| **Clay** | Unlimited seats + 2 usage meters | Launch ~$185/mo → Enterprise ~$30K/yr | Annual at scale | Opaque dual-meter "burns fast" |
| **Outreach/Salesloft** | Opaque per-seat annual + AI credits | ~$75–175+/seat/mo (*est.*) | Annual/multi-year; seat minimums; $5–25K implementation | Demo-gated; admin overhead |
| **Instantly cluster** | Flat send-volume tiers (or per-seat) + DB credits | $37–109/mo working tier | Monthly; annual ~17–20% off | Instantly DFY-domain lock-in; add-on creep |
| **HubSpot/SFDC/Pipedrive** | Cheap per-seat core + gated add-ons + consumption | $14–175/seat; **real stack $1.5–5K+/mo** | Annual; onboarding fees | $2/conversation backlash; ecosystem lock-in |
| **AI-SDR agents** | "Digital labor" quote-based / outcome | $900–5,000/mo; Qualified $95–165K/yr | Annual; quarterly billing | Opaque; 90-day kill-curve |
| **DIY** | Mixed labor/CPM/seats | Sales Nav ~$120/mo; VA ~$900–2,700/mo; lists ~$300–1K/M | None (inertia) | Compliance liability; ~30%/yr decay |
| **TruePoint (PLACEHOLDER)** | Per-reveal tenant credits + Free/Pro/Team/Enterprise tiers | **Not final** (signup bonus ~25 credits; packs 100/500/2K/10K) | *Planned transparent/self-serve, no auto-renew trap* | *None by design — pricing is placeholder* |

> **TruePoint pricing is entirely placeholder.** The competitive *intent* — transparent, self-serve, no auto-renewal
> trap, no data-destroy clause, fair credit economics (no charge on bad data, rollover) — is a design stance, not a
> committed price sheet. See [Product-Market Fit](04-product-market-fit.md) for the structural price assessment.

### 5.3 Positioning map

Two axes that matter for TruePoint: **scope** (single point tool ↔ full end-to-end loop) and **price/access**
(self-serve/affordable ↔ enterprise/opaque).

| | **Self-serve / affordable** | **Enterprise / opaque** |
|---|---|---|
| **Full loop (find → … → send)** | **Apollo** · *Instantly/Lemlist cluster (find+send, no CRM)* · **← TruePoint targets here (projected)** | **ZoomInfo** (data+Engage+Chorus) · **Salesforce** (Agentforce+Data Cloud) |
| **Orchestration / platform** | *(Clay Launch tier)* | **Clay** (GTM engineering) · **HubSpot** (Breeze) |
| **Single point tool** | Lusha · RocketReach · UpLead · Lead411 · Kaspr · Wiza · Hunter · **DIY/Sales Nav** | **Cognism** (data only, premium) · Outreach/Salesloft (send only) · AI-SDR agents (narrow autonomy) |

**Where TruePoint plants its flag:** the **self-serve/affordable × full-loop** quadrant, currently owned almost solely
by Apollo — but differentiated from Apollo on **compliance-as-a-feature, per-workspace isolation, verified-on-reveal
data trust, and honest billing**, the four things Apollo is weakest on. Cognism owns "compliant + premium + data-only";
TruePoint's bet is "compliant + affordable + full-loop."

---

## 6. Where competitors are weak / whitespace

Synthesized from the profiles above; each maps forward into [Market Gaps](03-market-gaps.md) and
[Strategic Opportunities](06-strategic-opportunities.md).

1. **Compliance that governs the customer's USE, end-to-end.** Every direct competitor stops at *their own* data
   sourcing (Cognism) or ignores compliance entirely (Apollo, Clay, the cold-email cluster, AI-SDR agents). **Nobody
   gates BOTH reveal AND send with unbypassable in-transaction suppression, DSAR fan-out across owned copies, and an
   append-only audit log.** With the regulatory wall hardening — California DROP live Jan 2026, GM's $12.75M CCPA fine,
   ZoomInfo's ~$29.5M settlement, Kaspr's €240K CNIL fine — this is TruePoint's sharpest **(M5)** wedge. *Caveat:
   TruePoint must still earn the certs/registrations Cognism already holds.*

2. **Data trust / verified-on-reveal with honest economics.** The universal #1 complaint is the accuracy-vs-marketing
   gap (Apollo ~65–80% real vs 91% claimed; Lusha up to ~40% inaccurate; Lead411 ~80%; Seamless charges for bad data).
   **No incumbent offers a transparent bounce SLA or credit-back-on-bad-data.** TruePoint's verified-on-reveal **(M4)**
   plus fair-credit design directly answers this — *provided it does not try to out-database Apollo/Clay on volume.*

3. **Honest, predictable billing.** The most emotionally charged pain in the category is contract abuse: ZoomInfo's
   auto-renewal + data-destroy lock-in, Seamless's cancellation traps, Apollo's chatbot-only cancellation, Clay's
   opaque dual-meter, CRM add-on/consumption creep. **Transparent, self-serve, no-lock-in pricing is wide-open
   whitespace** at the SMB/mid-market end ZoomInfo and Cognism abandoned.

4. **Per-workspace isolation for agencies / multi-brand / multi-client teams.** Apollo, ZoomInfo, Cognism, and the
   data tier all run a shared org-wide model. **Hard RLS per-workspace ownership with separate ICPs/scores/outreach
   state** is a granular, demonstrable data-governance story none of them tell **(M2)**.

5. **Turnkey full loop for non-technical reps.** Clay is powerful but an IDE (weeks to learn, needs a GTM engineer);
   the CRMs gate prospecting behind Enterprise tiers + onboarding fees; Outreach/Salesloft need a dedicated admin.
   **An opinionated, lean, single-page find→reveal→score→sequence→send flow** answers the "tool sprawl / 2–4-week
   ramp / 70% overwhelmed by tech" pain ([Market Research](01-market-research.md)).

6. **"Augmented human, not autonomous slop."** The AI-SDR wave is actively discrediting itself (50–70% 90-day churn,
   deliverability collapse, the 11x scandal); 2026 evidence favors hybrid human-in-the-loop pods. TruePoint's
   compliance-first, deliverability-disciplined, human-approval stance **(M9)** is a credible wedge against buyers
   burned by an 11x/Artisan deployment — *if* its drafting/scale match the autonomous players so "human-in-the-loop"
   doesn't read as "slow."

7. **The DIY baseline is beatable on every axis.** Sales Nav can't export verified emails; bought lists carry sender
   liability; VAs are a quality lottery; free tiers cap exports. A genuinely usable entry tier that collapses the DIY
   stack into one repeatable, compliant workflow is the real low-end opportunity — most early buyers aren't choosing
   between TruePoint and a named competitor, they're choosing between TruePoint and "Sales Nav + a VA + a spreadsheet."

**What TruePoint must NOT fight on (incumbent moats to respect):** raw database volume (Apollo 275M, RocketReach 700M,
ZoomInfo, Clay's 100+-source waterfall), conversation intelligence / enterprise forecasting (Outreach/Salesloft, Gong),
CRM data gravity and agentic depth (Salesforce Agentforce + Data Cloud), and the certs/proprietary data Cognism holds
today. TruePoint's defensibility is the **integrated, compliant, simple, isolated full loop** — not any single feature.
Carried into the [SWOT](08-swot.md), [Risk Assessment](07-risk-assessment.md), and [Executive Report](09-executive-report.md).

---

*Sources: the TruePoint competitor dossier (inline-linked above) and the adversarial verification block. Figures flagged
"unverified," "estimate," or "contested" in verification are caveated inline. TruePoint remains **pre-launch with zero
code/users**; all TruePoint capability and fit assessments are **projected from `docs/planning/`**, not measured.*
