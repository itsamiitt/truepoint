# Enterprise Reveal — Research Reference

How leading Sales-Intelligence platforms implement contact reveal, distilled into implementable patterns.
Platforms surveyed: Apollo, ZoomInfo, Cognism, Lusha, RocketReach, Seamless.AI, LinkedIn Sales Navigator,
UpLead, LeadIQ, Adapt.io, Kaspr, ContactOut.

## Market frame

Two camps: **enterprise/quote-gated/annual-lock** (ZoomInfo, Cognism, Sales Navigator Advanced+) and
**transparent/self-serve** (Apollo, Lusha, RocketReach, UpLead, LeadIQ, Kaspr, ContactOut). TruePoint is
deliberately transparent, so the transparent-camp patterns fit best (corroborated by
`docs/planning/plans-pricing-credits/01_Industry_Research.md`).

## Dimension-by-dimension reference

| # | Dimension | Prevailing pattern | Exemplars | TruePoint adoption |
|---|---|---|---|---|
| 1 | List/table reveal affordance | Per-row inline "Access email"/"Access mobile" in the results grid; browsing is free, only reveal spends | Apollo, ZoomInfo, Lusha, Kaspr | Per-row `RevealCell` (Phase 2) |
| 2 | Email vs phone vs both | Separate credit-costed actions; phone 8–10× email; Cognism premium "Diamond" mobile | Apollo (1 vs 8), Lusha (1 vs 10) | Per-type cost model (`revealCostFor`); phone priced higher |
| 3 | Credit deduction | **Charge-only-on-success + real-time verify + credit-back for bad/bounced**; anti-pattern = Seamless pay-for-misses | UpLead, RocketReach | ADR-0013 (already the model); Phase 0 hardened credit-back |
| 4 | "Already owned" | Distinct unlocked state; free re-access forever (Cognism until job-change; ZoomInfo "My Contacts") | Cognism, ZoomInfo | `revealedTypes` badge + free re-reveal (Phases 1–2); tie to freshness (ADR-0025) |
| 5 | Optimistic in-place update | Masked value flips to live value with a per-row spinner, no navigation; balance decrements | Apollo, Lusha, Kaspr, LeadIQ | `RevealStore` optimistic update (Phase 2) |
| 6 | Bulk reveal | Select-all-across-pages → estimate + confirm → async job → progress → partial success + retry → export | LeadIQ, Lusha, ZoomInfo/Cognism | Async `reveal_jobs` pipeline (Phase 3) |
| 7 | Loading/feedback | Skeletons, per-row spinners, toasts, live "N of M" | Apollo, Lusha, LeadIQ | Per-row spinner + toasts + progress bar (Phases 2–3) |
| 8 | Caching / previously-owned | Re-reveal free forever (or until decay); provider caching avoids re-paying vendors | Cognism, Apollo, ZoomInfo | First-reveal-wins → 0 credits; client `RevealStore`; server Redis cache (Phase 5) |
| 9 | Error / "no data — no charge" | Invalid/no-data = 0 credits, surfaced honestly; transient errors retriable, not charged | UpLead, RocketReach | `chargeFor` returns 0 for invalid/catch-all/unknown; 0-credit row recorded |
| 10 | Verification badges | Email valid/risky/catch-all/invalid; phone direct-dial/mobile vs HQ | Cognism (Diamond), Hunter, Lead411 | Color-coded email badge + phone line-type (Phases 1–2) |
| 11 | Copy / source / history | One-click copy; provider attribution; per-workspace usage log | ZoomInfo, Apollo, RocketReach | Copy buttons + `data_source` + reveal history in the drawer (Phase 1) |
| 12 | Keyboard / context menu / bulk toolbar | Multi-select + sticky bulk toolbar; right-click; keyboard | Apollo, LeadIQ, ZoomInfo | Sticky `BulkActionBar` exists; shortcuts/context-menu = Phase 5 |
| 13 | Rate limiting / fair-use | "Unlimited" is always a fair-use cap; per-seat/day throttles; new-account throttles | Apollo FUP, Cognism ~2k/user/mo | Reveal burst limiter (Phase 0); document the FUP |
| 14 | Realtime propagation | Reveal/credit changes propagate live across tabs/team | ZoomInfo/Cognism consoles | SSE over the outbox (Phase 4) |

## Sources (selected)

Apollo pricing/access: knowledge.apollo.io "Access a Prospect's Phone Number"; cotera.co / salesmotion.io
pricing guides. ZoomInfo credits: help.zoominfo.com "Overview of Credits". Cognism Diamond: cognism.com/
diamond-data. Lusha bulk-25 + billing FAQ: info.lusha.com. UpLead real-time verify/refund: uplead.com/
email-verifier. RocketReach only-successful lookups: rocketreach.co. LeadIQ async bulk: leadiq.com/compare.
Verification taxonomy: hunter.io/email-verifier; lead411.com direct-dial-vs-HQ guide.

**TruePoint differentiator to market explicitly:** *"you only pay for valid data; bounces are credited back"*
— the wedge against Seamless-style pay-for-misses.
