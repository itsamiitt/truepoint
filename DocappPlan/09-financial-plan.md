# 09 — Financial Plan

**Everything here is an estimate built from stated assumptions.** Real numbers will differ; the point is to know what has to be true, what it costs to find out, and when money runs out if we're wrong. Currency: USD (₹ where useful, at ~₹84/$).

## 1. Starting costs (one-time, months 0–2)

| Item | Cost |
|---|---|
| Company/legal setup + initial lawyer review (data licensing + privacy) | $1,500–3,000 |
| Landing pages, docs site, billing setup | $200–500 (mostly time) |
| Initial vendor credit top-ups (Crustdata etc.) | $500–1,500 |
| Infra (first months) | $300–600 |
| **Total to first revenue** | **≈ $2,500–5,500** |

This is deliberately bootstrappable. No fundraise is required for Phases 1–2; revenue funds Phase 3. (If we later want to accelerate crawling/OEM, a small round is an option, not a need.)

## 2. Monthly operating costs by stage

| Cost line | M1–4 | M5–9 | M10–18 |
|---|---|---|---|
| Team (per file 07, India) | $1–2k | $3–5k | $6–10k |
| Infra + tools | $0.3–0.6k | $0.5–1k | $1–2.5k |
| Vendor data (COGS, scales with revenue) | $0.3–1k | $1–3k | $2–5k |
| GTM tooling + free-credit budget | $0.2–0.5k | $0.5–1k | $1–2k |
| Legal/accounting (ongoing) | $0.2k | $0.3k | $0.5k |
| **Total burn** | **≈ $2–4.5k** | **≈ $5.5–10k** | **≈ $10.5–20k** |

## 3. Revenue model assumptions

- Flat files: $500–2,000/mo per dataset customer.
- API ARPU (average revenue per customer per month): Starter-heavy early (~$150), blending upward to ~$400–600 as Growth/Scale customers land; OEM deals counted separately.
- Conversion: benchmark→paid >25%; free→paid >8% (file 06 targets).
- Gross margin: ~50% early → 70%+ by m12 as owned-supply share hits 40% (file 05 math).

## 4. Three scenarios (MRR at each milestone)

| Milestone | Conservative | Base | Optimistic |
|---|---|---|---|
| Month 4 (flat files) | $1.5k (3 datasets) | $4k (6–8 customers) | $8k |
| Month 8 (API live) | $5k (12 cust.) | $12k (~25 cust.) | $22k |
| Month 12 | $9k | $22k (~40 cust.) | $45k (incl. 1 OEM) |
| Month 18 | $15k | $32k (~55 cust. + 1–2 OEM) | $70k |

**Break-even (revenue ≥ total burn):**
- Base case: around **month 8–10**.
- Conservative: around month 12–14.
- Optimistic: month 6–7.

Because burn is small and mostly variable, even the conservative case survives on a few thousand dollars of buffer — the plan's downside is measured in time, not in large lost capital.

## 5. Cash rules

1. Keep **4 months of burn** as a floor in the bank; below that, cut GTM spend first, team last.
2. Annual-prepay discounts (2 months free) exist to pull cash forward — push them on every Growth+ deal.
3. Vendor spend is capped monthly and must track revenue (COGS budget ≤ 40% of MRR in m1–6, ≤ 30% after).
4. Any single hire only when the bottleneck it solves is already costing revenue (file 07 §7).

## 6. What we are really buying with the first $5k

Phase 1 is a **test with a product attached**. For roughly one month of a Mumbai salary we learn: will named buyers pay real money for our packaged data, at what price, and which vertical pulls hardest? That answer de-risks everything downstream before the API is even built.

## 7. 18-month picture (base case, rounded)

| | Revenue (cum.) | Costs (cum.) | Position |
|---|---|---|---|
| Months 1–6 | ~$25k | ~$28k | Slightly negative — investment period |
| Months 7–12 | ~$95k | ~$55k | Profitable, funding Phase 3 build |
| Months 13–18 | ~$170k | ~$85k | Profitable; owned supply pushing margins up |
| **Total 18 mo** | **≈ $290k** | **≈ $170k** | **≈ +$120k cumulative** |

Sensitivity: the model is most sensitive to (1) benchmark→paid conversion and (2) owned-supply share. Miss both and month-18 looks like the conservative column — still alive, still profitable, just slower. That resilience is the point of the design.
