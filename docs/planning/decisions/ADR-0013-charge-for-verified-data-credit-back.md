# ADR-0013 — Charge only for verified data + credit-back guarantee

- **Status:** Accepted
- **Date:** 2026-06-01
- **Context doc:** [07-billing-credits.md](../07-billing-credits.md), [06-enrichment-engine.md](../06-enrichment-engine.md), [03-database-design.md](../03-database-design.md)

## Context

Data **accuracy / bounce rate** is the #1 evidenced complaint about every data vendor in the market analysis
([market research](../../market-analysis/01-market-research.md) §7), and a specific,
widely-cited grievance is being **charged a credit when the tool returns nothing or bad data** (Seamless.ai).
Few vendors offer a credit-back guarantee (UpLead is the praised near-precedent). LeadWolf already **verifies
email/phone at reveal** ([06 §9](../06-enrichment-engine.md)), but *whether to charge for non-`valid` results*
was an **open question** ([07 §12.4](../07-billing-credits.md), [00 §8.1](../00-overview.md#8-open-questions-tracked-resolved-during-doc-review-or-early-milestones),
flagged in [07 §3](../07-billing-credits.md) as a placeholder). The remediation (recommendation R3, gap 2.1,
hidden opening #3) resolves it. LeadWolf has **no proprietary dataset** — it cannot win raw accuracy outright,
so it competes on **honest billing for third-party data**.

## Decision

The reveal charge is a **function of the verified result** (`email_status` / `phone_status`,
[06 §9](../06-enrichment-engine.md)), decided **inside the reveal transaction** ([07 §3](../07-billing-credits.md))
after verification:

| Verified result | Charge |
|---|---|
| email `valid` | full cost ([07 §1](../07-billing-credits.md)) |
| email `invalid` / `catch_all` / `unknown` / provider-miss (no data) | **0 credits** — the `contact_reveals` row is still written with `credits_consumed = 0` so the user sees the (empty/unusable) outcome |
| email `risky` | charged per policy but **flagged borderline-deliverable** (configurable; default: charge) |
| phone resolved (`direct`/`mobile`/`hq`/`valid`) | full cost |
| phone `invalid` / `unknown` | **0 credits** |

Plus a published **credit-back-on-bounce guarantee**: a charged `valid` email that **hard-bounces** (SES
SNS→SQS feedback, [08 §6](../08-compliance.md)) within the **guarantee window** is **automatically credited
back** — an audited counter increment on `tenants.reveal_credit_balance`. The window length is a **placeholder**
([07 §1](../07-billing-credits.md)).

This requires adding **`credit.adjust`** to the closed audit-action enum ([08 §5](../08-compliance.md)), which
also covers the existing admin credit grants/adjustments ([07 §6/§7](../07-billing-credits.md)) that previously
had no dedicated audit action. No new table: charge-by-status uses the existing
`contact_reveals.credits_consumed`; credit-back is the existing counter-adjustment path
([07 §7](../07-billing-credits.md)), now automatable on bounce and audited.

## Rationale

Turning the market's #1 complaint into a **conversion lever** ("you only pay for data that's actually valid;
if it bounces, you get the credit back") is a cheap, high-trust differentiator that fits the
no-lock-in stance ([ADR-0012](./ADR-0012-transparent-no-lock-in-commercial-policy.md)) and the verify-on-reveal
design already in the plan. It keeps the reveal transaction's idempotency and `FOR UPDATE`/`CHECK (>= 0)`
guarantees intact ([ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)).

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Charge by verified result + credit-back-on-bounce (this ADR) | Chosen | Directly answers the #1 complaint; cheap; reinforces the trust wedge |
| Charge a flat credit regardless of result | Rejected | This is exactly the practice buyers hate; erodes the trust positioning |
| Warn-only (charge always, just show status) | Rejected | Surfaces honesty but doesn't fix the *billing* pain |

## Consequences

- **Positive:** converts accuracy anxiety into a buying reason; UpLead precedent shows it markets well; pairs
  with the credit-anxiety UX work ([04 §5](../04-ui-ux-design.md)).
- **Negative:** revenue leakage on bad data; the automated bounce credit-back adds a **refund/adjustment path**
  the bare counter ([ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)) was noted as lacking —
  increasing the case for the ledger-revival trigger.
- **Mitigation:** a bounded guarantee window; every adjustment audited (`credit.adjust`); leakage tracked on the
  economics dashboard ([06 §10](../06-enrichment-engine.md)); a sustained refund rate is an explicit
  *Revisit if* trigger for the append-only ledger ([ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)).

## Revisit if

Credit-back leakage or abuse (e.g. gaming bounces) is material, or finance needs a full refund history — which
also triggers the ledger revival in [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md).
