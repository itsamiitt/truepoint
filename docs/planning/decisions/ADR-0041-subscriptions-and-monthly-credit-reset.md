# ADR-0041 — Subscriptions + monthly credit reset (hybrid packs + subscriptions)

- **Status:** Accepted
- **Supersedes (in part):** [ADR-0012](./ADR-0012-transparent-no-lock-in-commercial-policy.md) — narrows its
  no-auto-renew and no-expiry *defaults* for the subscription allotment only. ADR-0012's anti-trap,
  self-serve-cancel, and no-data-destroy-on-churn commitments are **retained**.
- **Builds on:** [ADR-0007](./ADR-0007-per-workspace-reveal-and-tenant-counter.md) (per-workspace reveal + the
  tenant credit counter), [ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md) (M11 credit ledger).

## Context

The credit ledger (M11) is complete, unblocking real money features. The product owner has decided TruePoint
sells credits **both** as one-off packs **and** as monthly subscriptions. This requires amending ADR-0012, which
mandated month-to-month-only with no auto-renewal and no credit expiry.

## Decision

1. **Hybrid billing.** Offer monthly **subscriptions** (recurring credit grant + entitlements) **and** one-off
   **credit packs** (top-ups). Month-to-month remains the *default*; a subscription is an explicit opt-in, and
   auto-renew is **never defaulted-on** (the ADR-0012 anti-trap commitment is preserved — subscriptions now
   exist; renewal is not made a trap).
2. **The monthly subscription allotment RESETS each cycle** (use-it-or-lose-it). This narrows ADR-0012 §4
   ("credits do not expire at MVP") to: *the subscription allotment* resets; the reset is announced in advance
   (ADR-0012 §4's "future expiry announced" clause).
3. **Purchased pack credits NEVER expire.** Only the subscription allotment resets — credits a customer paid for
   as a pack persist until used. This is enforced by a two-bucket balance model (below).
4. **Cancellation stays self-serve; no data-destroy on churn** (ADR-0012 §3 retained). A `past_due` subscription
   is handled by **access-gating only** after a transparent grace window — never data deletion.

## The two-bucket balance model

`tenants.reveal_credit_balance` stays the **authoritative TOTAL** (every existing reader + the ledger invariant
`SUM(credit_ledger.delta) == reveal_credit_balance` + the `CHECK (>= 0)` guard are untouched). One new integer
sub-counter holds the perishable portion:

- `tenants.subscription_credit_balance` — the resetting allotment. `purchased = total − subscription` (derived).
- Invariant CHECK: `subscription_credit_balance >= 0 AND subscription_credit_balance <= reveal_credit_balance`.
- **Spend order = subscription-first** (burn the perishable bucket before the permanent one). The reveal spend
  posts ONE `spend` ledger entry (`delta = -cost`) with `metadata.{fromSubscription, fromPurchased}`.
- **Monthly reset (worker, one tx):** expire the unused subscription remainder (ledger `adjustment`,
  `reason='subscription_reset_expiry'`), grant the new month (`grant`), set `subscription_credit_balance =
  monthlyCreditGrant`. Purchased credits are never touched. Net ledger delta reconciles → recon stays green.

## Consequences

- New tables `subscriptions` + `billing_cycles` (tenant-scoped, ENABLE RLS like `purchases`); `stripe_price_id`
  on `plan_templates` (required for a recurring Price) and `credit_packs` (optional — packs fall back to inline
  `price_data`).
- The Stripe purchase path uses a hand-rolled `StripePort` (core) + REST adapter (integrations), mirroring the
  AiPort seam; the SDK-free inbound webhook (ADR-0012/07 §4) is unchanged. Everything ships **dark** behind
  `STRIPE_SECRET_KEY` + `BILLING_CHECKOUT_ENABLED` / `BILLING_SUBSCRIPTIONS_ENABLED`.
- Monthly-grant/reset + dunning run as dark, leader-locked workers (mirroring `billingReconSweep`); the webhook
  enqueues cycle state, the sweep executes the grant idempotently (a missed webhook self-heals).

## Open (decided per-phase, not here)

Annual term; proration on mid-cycle plan change; Stripe free trials (vs the existing signup-bonus credits);
who provisions Stripe Prices; the dunning grace-window length. USD is authoritative; multi-currency deferred.
