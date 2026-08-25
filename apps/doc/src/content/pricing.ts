// pricing.ts — the published credit costs and plans.
//
// earned-currency-ok: quotes the strategy pack's own sentence rejecting a points/bounty economy. Naming the
// rejected thing in order to reject it is not implying it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A credit here is a PURCHASED settlement unit and nothing else. It is bought, it is spent on a successful
// call, and it expires per the rollover rule below. It is NOT something a contribution can earn.
//
// That is a hard product rule, not a copy preference. CLAUDE.md rule 7 and docs/strategy/07-data-flywheel.md
// §Access model both state it in one line — "no credit, points, or bounty currency anywhere in the system" —
// and docs/strategy/decisions.md records the MONETIZATION PIVOT that deleted exactly such a currency, because
// anything farmable turns A-03 from data-quality fraud into economic fraud and creates a clawback problem
// (C-06) nobody wants to litigate. The source brief for this portal (DocappPlan/02 §6, 04 §Source B, 05 §3,
// 06 §4) proposes reviving it. That conflict is recorded in ADR-0048 §C1 and is the operator's to resolve.
// Until it is: no earn rate, no reward, no "contribute for credits" claim appears on this site.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Everything below is a launch estimate, which is why each plan carries availability: "planned". The numbers
// are duplicated from the product's own plan templates by hand and dated; if the two ever disagree, the
// product is right and this file is corrected. Reconciling them in code would mean importing @leadwolf/config
// or @leadwolf/db here, which is the one thing ADR-0048 §D2 forbids.

import type { CreditAction, Plan } from "./types.ts";

/** The date the figures on this page were last reviewed. Rendered next to the tables — an unlabelled price
 *  table ages into a lie, and a reader deserves to see how old the number they are budgeting against is. */
export const PRICING_REVIEWED = "2026-08-21";

export const CREDIT_UNIT_NOTE =
  "One credit is $0.05 at the Starter rate. Larger plans lower the effective rate; the per-action cost in credits never changes.";

export const CREDIT_ACTIONS: readonly CreditAction[] = [
  {
    action: "Company identification / match",
    credits: "free",
    note: "Resolving a domain or name to a company id costs nothing. It is plumbing that gets called constantly, and metering it would distort every integration's cost model for no revenue worth having.",
  },
  {
    action: "Company enrichment (full record)",
    credits: 1,
    note: "Firmographics, locations, headcount and funding history for one company.",
  },
  {
    action: "Person search (per returned result)",
    credits: 1,
    note: "Charged per result actually returned, not per query. A query matching nothing is free.",
  },
  {
    action: "Person enrichment (full profile)",
    credits: 3,
    note: "Role, employment history and company linkage for one person.",
  },
  {
    action: "Verified business email",
    credits: 2,
    note: "Added on top of person enrichment when a deliverable work address is requested. Verification has a real per-address cost, so it is priced separately rather than hidden in the base rate.",
  },
];

export const ROLLOVER_NOTE =
  "Unused credits roll over for up to two months. Overage beyond a plan's included credits bills at that plan's rate — there is no penalty rate for going over.";

export const PLANS: readonly Plan[] = [
  {
    slug: "free",
    name: "Free",
    price: "$0",
    cadence: "no card required",
    credits: "100 credits to evaluate",
    audience: "Developers testing the contract against their own records.",
    includes: [
      "Every endpoint, at the same data quality as paid plans",
      "No match, no charge",
      "Community support",
    ],
    availability: "planned",
  },
  {
    slug: "starter",
    name: "Starter",
    price: "$99",
    cadence: "per month",
    credits: "2,000 credits ($0.050 each)",
    audience: "Indie builders and small teams putting data inside one product.",
    includes: ["Everything in Free", "Two-month credit rollover", "Email support"],
    availability: "planned",
  },
  {
    slug: "growth",
    name: "Growth",
    price: "$499",
    cadence: "per month",
    credits: "12,000 credits ($0.042 each)",
    audience: "Funded startups and small platforms with steady volume.",
    includes: ["Everything in Starter", "Shared support channel", "Usage alerts"],
    availability: "planned",
  },
  {
    slug: "scale",
    name: "Scale",
    price: "$1,999",
    cadence: "per month",
    credits: "60,000 credits ($0.033 each)",
    audience: "Platforms where our data is a load-bearing part of the product.",
    includes: [
      "Everything in Growth",
      "Volume rate on overage",
      "Annual prepay available at two months free",
    ],
    availability: "planned",
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    price: "Custom",
    cadence: "annual",
    credits: "Committed volume",
    audience: "Embedded and white-label deals with committed annual volume.",
    includes: [
      "Everything in Scale",
      "Data processing agreement and sub-processor list",
      "Negotiated rate against a committed volume",
    ],
    availability: "planned",
  },
];
