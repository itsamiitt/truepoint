# 07 — Billing & Credits

> LeadWolf sells data on a **credit** basis. A user spends credits to **reveal** a contact's verified
> email / phone / full profile. Credits are a **tenant-level counter**
> ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)); reveal is
> **per-workspace, first-reveal-wins**. The path must be **idempotent** (no double-charge),
> **gated by suppression** (no leaking a suppressed contact), and **fair** (re-revealing the same
> workspace copy is free). Implemented in `packages/billing`.

## 1. The credit model

- **Unit:** one **credit** = the spend for one **reveal**; cost varies by `reveal_type`
  (`email` / `phone` / `full_profile`). The per-type cost is a **placeholder** (below).
- **Authoritative balance:** the tenant counter `tenants.reveal_credit_balance` (`CHECK >= 0`),
  **shared across the tenant's workspaces** ([03 §8](./03-database-design.md#8-billing--compliance)).
  It is *not* an append-only ledger (see §2).
- **Per-workspace, first-reveal-wins:** the first `contact_reveals` row for a `(workspace_id,
  contact_id)` sets ownership on the contact (`is_revealed`, `revealed_by_user_id`, `revealed_at`)
  via an idempotent trigger. Re-revealing the **same workspace copy** is **0** credits, forever.
- **Same human, another workspace:** because each workspace owns its **own** contact copy
  ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md)), revealing the same person in
  a different workspace **charges again** — there is no cross-workspace free re-reveal.
- **Top-ups:** tenants buy credit packs via Stripe (one-time purchases at MVP; subscriptions later);
  grants land on the tenant counter (§4).
- **Entitlements vs credits:** entitlements are *plan capabilities/limits* (features, seat/workspace
  caps, optional monthly quota) held at tenant level; credits are *consumable spend*. They are checked
  independently — entitlement guard first, then credit check.
- **Pricing numbers are placeholders** pending your decision:

| Item | Placeholder | Decide |
|---|---|---|
| Cost per `email` reveal | 1 credit | final cost |
| Cost per `phone` reveal | 1 credit | final cost |
| Cost per `full_profile` reveal | 1 credit | final cost |
| Credit pack sizes | 100 / 500 / 2,000 / 10,000 | sizes + price |
| Price per credit | tiered (cheaper at volume) | $ per credit by tier |
| New-tenant signup bonus | 25 free credits | bonus size (and abuse limits) |
| Credit expiry | none at MVP | expiry policy (if any) |

### 1A. Commercial policy — transparent & no lock-in ([ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md))

The numbers above are placeholders, but the **commercial *policy* is decided** — it is a core trust wedge
(market-gap analysis [../market-analysis/03-market-gaps.md](../market-analysis/03-market-gaps.md) §5,
recommendation R1):

- **Transparent, self-serve pricing** — prices/packs are public; no demo-gate to see pricing or buy ([§6](#6-self-serve-abuse--fraud-guards)).
- **No auto-renewal traps** — month-to-month default; annual optional; self-serve cancellation; renewal terms
  (incl. any change) shown up front; no punitive renewal hikes.
- **No data-destroy on churn** — a cancelling tenant can **export its revealed data** (CSV) and its data is
  handled per the retention policy ([08 §7](./08-compliance.md)), never destroyed as leverage. Account-closure
  offers a full export ([12 §4](./12-settings.md)).
- **Credits do not expire at MVP**; any future expiry is announced in advance.
- **A single usable seat undercuts the DIY baseline** (Sales Navigator + a VA + bought lists). The number is a
  placeholder (§1).

## 2. Why a counter (and not a ledger — yet)

The authoritative balance is a single mutable counter, `tenants.reveal_credit_balance`, decremented
inside the reveal transaction (§3); `contact_reveals` is the **per-reveal event log** (who,
`reveal_type`, `data_source`, `credits_consumed`, `revealed_fields`). This is the founders' chosen
model ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)) — simplest fit for
the per-workspace product.

**Counter ≠ ledger — KNOWN RISKS (consciously accepted):** a bare counter has no append-only history,
so it lacks the ledger's **reconciliation invariant** (`balance == SUM(delta)`), **refund/adjustment
history**, and **replayable audit**; a naive decrement is also **race-prone** under retries/concurrency.

**Required mitigations (the design below relies on all of them):** wrap the decrement in a transaction
with `SELECT … FOR UPDATE` on the tenant row + the DB `CHECK (reveal_credit_balance >= 0)`; enforce
reveal idempotency with the unique constraint on `contact_reveals (workspace_id, contact_id,
reveal_type)`; require a client `Idempotency-Key` on money endpoints; make Stripe top-ups idempotent on
`purchases.stripe_event_id`; keep the in-transaction suppression gate.

> **Documented future hardening:** the append-only **double-entry ledger** (`credit_ledger` +
> materialized `credit_balances`, `balance == SUM(delta)`) is the safer alternative we may revisit —
> see superseded [ADR-0004](./decisions/ADR-0004-credit-ledger-idempotency.md) and the *Revisit if* note
> in [ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md) (the counter can become
> a read-only cache of the ledger). Triggered by billing disputes, double-charge incidents, or finance's
> need for an auditable trail.

Schema: [03 §8](./03-database-design.md#8-billing--compliance).

## 3. The reveal transaction (core monetized path)

The single source of truth for charging. Described **identically** in [08 §3](./08-compliance.md) and
[09 §3](./09-api-design.md). Idempotency comes from the unique `contact_reveals (workspace_id,
contact_id, reveal_type)`; the in-transaction suppression gate is unbypassable; the tenant counter is
serialized with `FOR UPDATE`. The unlocked email/phone is read from the Layer-0 **master channel**
(`master_emails`/`master_phones`) and copied into the workspace overlay
([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)); the credit accounting below is unchanged.

```sql
BEGIN;
  -- 0) compliance gate INSIDE the tx (unbypassable) — see 08 §3
  --    assertNotSuppressed(contact, workspace)  -> raises if suppressed (no charge)

  -- 1) idempotent reveal claim (per workspace copy, per reveal_type)
  INSERT INTO contact_reveals (id, tenant_id, workspace_id, contact_id, revealed_by_user_id,
                               reveal_type, data_source, credits_consumed, revealed_fields)
  VALUES (...)
  ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING;

  -- if already present -> return owned fields, charge 0
  -- else -> charge against the TENANT counter:
  SELECT reveal_credit_balance FROM tenants WHERE id = $tenant FOR UPDATE;
  IF reveal_credit_balance < cost THEN
     ROLLBACK;  -- INSUFFICIENT_CREDITS (reveal row not committed)
  ELSE
     UPDATE tenants SET reveal_credit_balance = reveal_credit_balance - cost  -- CHECK (>= 0)
       WHERE id = $tenant;
  END IF;
COMMIT;
-- audit_log(action='reveal', target=contact, metadata={reveal_type, cost, fields})
```

In words: `BEGIN`; `assertNotSuppressed(contact, workspace)` [in-tx, unbypassable]; `INSERT
contact_reveals ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING`; if already present →
**return owned fields, charge 0**; else → `SELECT reveal_credit_balance FROM tenants WHERE id=tenant FOR
UPDATE`; if `< cost` `ROLLBACK` (`INSUFFICIENT_CREDITS`); else `UPDATE tenants SET reveal_credit_balance
= balance - cost`; `COMMIT`; audit. The first `contact_reveals` row for the contact also flips
ownership (`is_revealed`, `revealed_by_user_id`, `revealed_at`) via the idempotent trigger
([03 §10](./03-database-design.md#10-triggers--db-side-logic)).

Notes:
- **`FOR UPDATE`** on the tenant row serializes concurrent reveals for the same tenant → no double-spend
  on the counter; the DB `CHECK (reveal_credit_balance >= 0)` makes overdraft impossible.
- The client also sends an **`Idempotency-Key` header**; the server replays the stored response so
  network retries of the same request don't double-charge even before the DB constraint applies. This
  pairing — `FOR UPDATE` + `CHECK >= 0` + the unique constraint + `Idempotency-Key` — is the **required
  mitigation** for the bare counter's lack of a ledger's reconciliation/refund history (§2,
  [ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)).
- `revealed_fields` records exactly what was unlocked (for audit + DSAR); `data_source` is the provider
  the data came from.
- **Charge is a function of the verified result** ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)).
  Email/phone are **verified at reveal** ([06 §9](./06-enrichment-engine.md)); `cost` is set from the result:
  `valid` → full cost; `invalid`/`catch_all`/`unknown`/provider-miss → **0** (the `contact_reveals` row is
  still written with `credits_consumed = 0` so the user sees the unusable outcome); `risky` → charged-but-flagged
  (configurable, default charge). Phone charges only when a line type resolves (`direct`/`mobile`/`hq`/`valid`).
- **Credit-back on bounce.** A charged `valid` email that **hard-bounces** (SES SNS→SQS feedback,
  [08 §6](./08-compliance.md)) within the **guarantee window** is **auto-credited back** — an audited counter
  increment (audit action `credit.adjust`, [08 §5](./08-compliance.md)); the window is a placeholder (§1). This
  is the one automated path that *increments* the counter, so it is bounded + audited (§7) and feeds the
  ledger-revival trigger ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)).

## 4. Stripe top-ups (webhook is the source of truth)

```mermaid
sequenceDiagram
  participant U as User
  participant API as api
  participant S as Stripe
  participant W as Stripe webhook handler
  participant DB as Postgres
  U->>API: Buy credit pack
  API->>S: Create Checkout Session / PaymentIntent
  S-->>U: Hosted checkout
  U->>S: Pays
  S->>W: payment_intent.succeeded (event)
  W->>DB: INSERT purchases (stripe_event_id UNIQUE) ; tenants.reveal_credit_balance += credits
  W-->>S: 200 OK
```

- **Never grant credits client-side.** Credits are granted only when the **webhook** fires, by
  incrementing `tenants.reveal_credit_balance`.
- **Idempotent:** `purchases.stripe_event_id` is **unique**; the grant runs only on first insert of the
  event row → replays/duplicate webhooks grant credits exactly once.
- **Reconciliation:** a job cross-checks Stripe settled payments vs `purchases` rows (and flags any
  grant the counter can't account for — see §8).

## 5. Entitlements & quota

- Entitlements live at **tenant level**: `tenants.plan`, `seat_limit`, `workspace_limit`, and a
  `features` jsonb flag set ([03 §4](./03-database-design.md#4-tenancy--auth)). A guard in the Hono/tRPC
  app ([ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md)) enforces plan limits (feature
  flags, seat/workspace caps, optional monthly reveal cap) **before** the credit check. Credits and
  entitlements are orthogonal: a plan may include a monthly quota *and* allow credit top-ups.
- Feature gating examples: API access, CRM sync, AI/outreach features, export row caps — all `features`
  flags.

## 6. Self-serve abuse & fraud guards

Because signup is public, fresh tenants are higher-risk:

- Email verification + disposable-domain blocking at signup.
- Signup/IP velocity limits; device/fingerprint signals.
- New-tenant **reveal throttle** until a successful payment (limit free-bonus burn).
- Card/payment risk via Stripe Radar; chargeback handling reverses credits with an **admin-issued
  counter adjustment** (decrement `reveal_credit_balance`), audit-logged (§7).
- Export rate limits; anomaly alerts on sudden reveal spikes.

## 7. Refunds, adjustments, disputes

- With a counter (not a ledger), corrections are **direct adjustments** to `tenants.reveal_credit_balance`
  via internal admin tooling, each issued with a reason and **audit-logged** (`audit_log`). There is **no
  native refund/adjustment history** beyond the audit trail — a KNOWN RISK of the counter (§2); the
  documented hardening path is reintroducing the append-only ledger
  ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md) →
  [ADR-0004](./decisions/ADR-0004-credit-ledger-idempotency.md)).
- A reveal that was charged is **not auto-refunded**; disputes go through admin review.

## 8. Reconciliation & invariants

A scheduled `billing-recon` worker asserts, per tenant:
- `reveal_credit_balance >= 0` (also a DB CHECK — overdraft impossible).
- Stripe settled payments == `purchases` rows (every grant traces to a unique `stripe_event_id`).
- Spend sanity check: `SUM(contact_reveals.credits_consumed)` vs (granted + credit-backs − current balance),
  where credit-backs and admin adjustments are the `credit.adjust` audit entries (§7,
  [08 §5](./08-compliance.md)). **Caveat:** a counter has **no `balance == SUM(delta)` invariant**, so drift
  can't be fully proven from the counter alone — the `credit.adjust` entries must be reconstructed from the
  audit log, not a delta column; this is the reconciliation gap the ledger would close (§2).

## 9. Reporting

- **User-facing:** tenant balance, usage history (reveals with dates, `reveal_type`, cost), top-up
  receipts.
- **Admin (tenant):** spend over time, per-member and per-workspace usage, remaining quota.
- **Internal:** cost-per-reveal (provider spend ÷ reveals), margin, gross credits sold vs consumed.

## 10. Testing strategy (high-risk module)

- **Property / concurrency tests:** balance never negative; idempotent reveal (same `(workspace_id,
  contact_id, reveal_type)` N times → one charge); concurrent reveals for one tenant (load) → no
  double-spend on the counter (validates `FOR UPDATE` + unique constraint + `Idempotency-Key`).
- **Stripe CLI** integration: replay a webhook twice → credits granted once.
- **Testcontainers** integration tests for the reveal transaction under concurrency.

## 11. Open questions

1. **Reveal pricing by `reveal_type`** (email vs phone vs full_profile), pack sizes/prices, signup
   bonus, expiry. *(Placeholders in §1; the pricing **policy** — transparent, no-lock-in — is decided in
   [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md) / §1A.)*
2. **Billing hardening:** when to reintroduce the append-only ledger to close the counter's
   reconciliation / refund-history / idempotency gaps
   ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md) *Revisit if*).
3. Subscription plans (seat-based) on top of credits — when? (Post-MVP; tenant entitlements already
   support it.)
4. ~~Policy on charging for `risky`/`catch_all` emails (charge, discount, or warn-only?).~~ **Resolved**
   ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), §3): charge only for `valid`;
   `invalid`/`catch_all`/`unknown`/no-data → **0**; `risky` → charged-but-flagged (configurable) — plus
   **credit-back on bounce**. Remaining placeholder: the credit-back **guarantee window** and the `risky` default.
