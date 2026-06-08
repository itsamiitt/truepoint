# ADR-0012 — Transparent, no-lock-in commercial policy

- **Status:** Accepted
- **Date:** 2026-06-01
- **Context doc:** [07-billing-credits.md](../07-billing-credits.md), [00-overview.md](../00-overview.md)

## Context

The market-gap analysis ([gaps](../../market-analysis/03-market-gaps.md),
[executive report](../../market-analysis/09-executive-report.md)) found that the loudest,
angriest, best-evidenced buyer complaints about incumbents (ZoomInfo especially) are **commercial, not
technical**: opaque demo-gated pricing, annual lock-in, auto-renewal traps, double-digit renewal hikes, and
**"data-destroy on churn"** clauses. These were the **highest-ranked, lowest-difficulty** remediation
(recommendation R1) and the basis for two *hidden* openings: an anti-lock-in brand position (#2) and pricing a
single seat below the DIY/VA baseline (#6). LeadWolf's **per-workspace data ownership**
([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)) makes an anti-lock-in stance *structurally* true,
not just a promise. We need a committed commercial **policy**; the prices themselves remain placeholders
([07 §1](../07-billing-credits.md)).

## Decision

LeadWolf commits to a **transparent, no-lock-in commercial policy**:

1. **Transparent, self-serve pricing** — prices and pack sizes are public; no mandatory demo/sales gate to see
   pricing or to buy ([07 §1](../07-billing-credits.md), [§6 GTM](../07-billing-credits.md)).
2. **No auto-renewal traps** — month-to-month is the default; annual is optional; cancellation is self-serve and
   clearly stated; renewal terms (incl. any price change) are shown up front, with no punitive renewal hikes.
3. **No data-destroy on churn** — a cancelling/churning tenant can **export its revealed data** (CSV) and its
   data is handled per the published retention policy ([08 §7](../08-compliance.md)), never destroyed as
   commercial leverage. The account-closure flow offers a full export.
4. **Credits do not expire at MVP** (per the [07 §1](../07-billing-credits.md) placeholder); any future expiry
   is announced in advance.
5. **A single usable seat is priced to undercut the DIY baseline** (Sales Navigator + a VA + bought lists) — the
   true low-end competitor. The exact number is a placeholder ([07 §1](../07-billing-credits.md)).

This ADR sets **policy and commitments**; concrete prices, pack sizes, and the signup bonus remain **placeholders
pending the pricing decision** ([07 §1](../07-billing-credits.md), [00 §8](../00-overview.md#8-open-questions)).

## Rationale

The cheapest, fastest, most defensible wins in the analysis were commercial-trust moves, not features
([strategic opportunities](../../market-analysis/06-strategic-opportunities.md)). No
incumbent can credibly copy "own your data, leave anytime, we never destroy your book" without cannibalising the
lock-in revenue their model depends on — and per-workspace ownership makes it true for us at near-zero cost.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Transparent, no-lock-in policy (this ADR) | Chosen | Structurally true via per-workspace ownership; targets the market's angriest complaints; cheap at MVP |
| Match incumbents (annual lock-in, auto-renew, opaque pricing) | Rejected | Forfeits the clearest differentiation; alienates the burned SMB/mid-market buyer we target |
| Stay silent (decide later) | Rejected | Pricing posture is load-bearing for positioning and the account-closure/export flow; must be designed in, not retrofitted |

## Consequences

- **Positive:** a marketable wedge no incumbent can credibly claim; aligns with per-workspace ownership and the
  brand ([brand-identity.md](../brand-identity.md)); turns churn terms into a trust signal.
- **Negative:** forgoes lock-in revenue and makes churn easier; transparent pricing invites direct comparison.
- **Mitigation:** win on product + fair terms; export-on-exit is cheap given per-workspace copies; validate the
  actual prices in early access before GA.

## Revisit if

Enterprise deals require custom annual commitments, or transparent pricing proves exploitable by competitors —
in which case revisit the *defaults*, not the no-data-destroy commitment.
