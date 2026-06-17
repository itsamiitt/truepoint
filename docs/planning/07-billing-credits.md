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

> **Committed hardening ([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md)):** the
> append-only **`credit_ledger`** (`balance == SUM(delta)`) lands at **M11** — executing ADR-0007's
> *Revisit if* path and the spirit of superseded
> [ADR-0004](./decisions/ADR-0004-credit-ledger-idempotency.md) — after which the counter is a **derived
> cache** of the ledger; **lease-based decrement** (workspace/team credit leases) follows at **M12** to
> relieve the tenant-row hot lock for high-concurrency tenants. Until M11 the counter model below is
> authoritative.

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

## 3A. Bulk reveal / enrich credit handling (million-row jobs)

§3 charges **one reveal at a time** under the tenant-row `FOR UPDATE` — correct, but it **serializes every
reveal tenant-wide** ([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md) context;
G-BIL-2). A million-row CSV reveal/enrich run cannot take that lock a million times. Bulk jobs run on the
async staging pipeline ([./30-bulk-import-export-pipeline.md](./30-bulk-import-export-pipeline.md),
[ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)); the credit mechanics for a bulk
job are below. The **per-row charge policy is unchanged** — every row still settles by verified result
([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), §3); this section only changes
how credits are **reserved and reconciled in bulk**, not what a single reveal costs.

### (a) Pre-flight cost ESTIMATE (shown before the job runs)

Before a bulk reveal/enrich job is confirmed, the user is shown a **worst-case cost estimate**: the number
of **distinct, not-already-revealed** rows (after dedup, (c) below) × the per-`reveal_type` cost (§1). It is
labelled **worst-case** because charge-by-verified-result (§3, [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md))
means the **actual** spend is usually **lower** — `invalid`/`catch_all`/`unknown`/no-data rows settle at
**0**, and already-owned workspace copies are **free** (§1). The estimate also reports how many rows are
**free re-reveals** and how many fall **outside the current balance** so the user can size a top-up (§4)
before committing. The estimate is informational; it never itself moves the counter.

### (b) Bulk credit RESERVATION / lease (the scalability fix)

When a bulk job is confirmed, it **does not** decrement the tenant counter per row. Instead it
**pre-authorizes the worst-case batch cost as a single credit lease** for the job, against a
per-workspace/team lease carved from the tenant pool
([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md) M12 — *lease the worst-case amount
for a bulk job, settle on completion, release the remainder*). Mechanics:

- **Reserve once, at job start.** A `SELECT … FOR UPDATE` on the **lease row** (not the `tenants` row)
  carves the worst-case amount from the tenant pool, with the same `CHECK (>= 0)` guarding the pool. If the
  pool can't cover the worst case, the job is **not** rejected outright — it confirms at the **affordable**
  amount and runs with **partial-spend** semantics ((d) below). The tenant counter takes the hot lock
  **once per job**, not once per row, so a million-row job no longer serializes tenant-wide on the §3 hot
  lock — this is the **scalability fix** for G-BIL-2.
- **Spend locally, per row.** Each row's verified charge decrements the **job's lease** under the lease
  row's own lock (per-workspace/team parallelism, [ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md));
  the `contact_reveals` row is still written per row with `credits_consumed` set by verified result (§3).
- **Settle on completion, release the remainder.** When the job finishes, the lease **settles**: actual
  verified spend stays decremented; the **unspent remainder** (worst-case over-reservation — bad-data rows
  that settled at 0, free re-reveals discovered mid-run) is **released back to the tenant pool**. Settlement
  and release are audited (`credit.adjust`, [08 §5](./08-compliance.md)). Until M12's lease rows exist, a
  bulk job degrades to a **single reservation transaction** on the tenant counter at job start/settle
  (one hot-lock acquisition per job, not per row) — correctness preserved by `CHECK (>= 0)`.

### (c) Dedup BEFORE enrich (never charge a duplicate twice)

Bulk input is **deduplicated before any credits are reserved or spent**. The pipeline collapses duplicate
rows (same person/identity key, [./30-bulk-import-export-pipeline.md](./30-bulk-import-export-pipeline.md))
**and** excludes rows whose `(workspace_id, contact_id, reveal_type)` is **already revealed** (free under
first-reveal-wins, §1) **before** the estimate (a) and reservation (b). A duplicate row therefore enters the
charge path **once**; the per-reveal unique constraint on `contact_reveals (workspace_id, contact_id,
reveal_type)` (§2/§3) remains the **final** idempotency backstop if a duplicate slips through.

### (d) Partial-spend / resume when the lease is exhausted

A bulk job is **resumable** and never overdraws. If the lease (or the tenant pool behind it) is exhausted
mid-job — because the worst case exceeded the balance, concurrent jobs drew the pool down, or a top-up
hasn't landed — the job **pauses** at the last fully-settled row rather than failing or partial-charging a
row:

- Rows already processed are **settled and charged** (by verified result); their `contact_reveals` rows are
  committed, so no work is lost and nothing is double-charged on resume (the unique constraint, §3).
- The job enters a **`paused_insufficient_credits`** state and surfaces the **shortfall** (rows remaining ×
  worst-case cost) so the user can **top up** (§4) and **resume**. On resume, dedup (c) re-excludes the
  already-revealed rows, a fresh lease is reserved for the remainder, and processing continues.
- This mirrors the single-reveal `INSUFFICIENT_CREDITS` rollback (§3) at **batch granularity**: the unit of
  failure is a row, never a half-charged row.

### (e) Batch-granularity credit-back for failed / unverified rows

Credit-back ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), §3) applies to bulk
exactly as to single reveals, just **aggregated by batch**:

- **Unverified at reveal** (`invalid`/`catch_all`/`unknown`/no-data) — these settle at **0** during the run
  (b); they are never charged, so there is nothing to credit back. They count toward the *worst-case over
  the actual* gap released at settlement, not a refund.
- **Failed rows** (provider error, transient miss) are **not charged** and are reported as a re-runnable
  remainder of the job, not a silent loss.
- **Post-hoc credit-back on bounce** — a charged `valid` email from a bulk job that **hard-bounces** within
  the guarantee window (§3, [08 §6](./08-compliance.md)) is credited back the same way as a single reveal: an
  audited counter increment (`credit.adjust`). For a large batch these arrive as a **stream** of per-row
  credit-backs over the window; each is bounded + audited (§7) — there is no separate bulk refund path, only
  the same per-row path reconciled in aggregate by `billing-recon` (§8).

> **Alignment:** all five mechanics keep the LOCKED invariants — tenant counter as authoritative balance
> ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)), lease semantics
> ([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md)), idempotent charging (§2/§3,
> [ADR-0004](./decisions/ADR-0004-credit-ledger-idempotency.md)), and charge-for-verified + credit-back
> ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)). The lease for bulk **is**
> ADR-0029's M12 lease applied to a whole job; until M12 the degraded single-reservation path above holds.

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
- **Per-team credit budgets** (`team_credit_budgets`): a tenant/RevOps allocates a slice of the tenant
  pool to a **department**, checked **in-tx** at reveal next to the counter (`H2`) — a `hard_cap` team is
  blocked at budget while soft budgets warn/report ([25 §5](./25-departments-teams-workspaces.md),
  [ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)). This **is** the
  cross-workspace allocation policy referenced in [12 §4](./12-settings.md).
- **AI usage metering** (`ai_requests`): tokens → cost per tenant, optional **AI credits**, and
  per-tenant/workspace AI budgets with circuit-breakers ([23 §7](./23-ai-intelligence-layer.md)).

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
  audit log, not a delta column; this is the reconciliation gap the **M11 ledger closes**
  ([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md), §2): from M11 the recon worker
  asserts the invariant directly against `credit_ledger`.

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

## 11. Bulk enrichment billing ([ADR-0038](./decisions/ADR-0038-bulk-enrichment-billing-forecast-and-quota.md))

Bulk CSV enrichment ([31](./31-bulk-enrichment-pipeline.md)) **reuses the reveal/credit machinery above
unchanged** — it is the per-row reveal path (§3) run at job scale, not a second billing system. Each
enriched row that resolves to a workspace contact runs the same in-tx reveal claim against the same tenant
counter, so all of §2/§3's invariants (`FOR UPDATE` + `CHECK (reveal_credit_balance >= 0)` + unique
`contact_reveals (workspace_id, contact_id, reveal_type)` + `Idempotency-Key`) hold per row, for free.

- **Charge per verified match, same rules as §3** ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)).
  A row is charged only for `valid` verified data; `invalid`/`catch_all`/`unknown`/provider-miss → **0**
  (a `contact_reveals` row is still written with `credits_consumed = 0` so the user sees the unusable
  outcome), `risky` → charged-but-flagged. Per-type cost is the **placeholder** of §1 — the bulk job reads
  the same configured cost, **never a hardcoded number**. **Credit-back on bounce** applies identically:
  a charged `valid` email that later hard-bounces within the guarantee window is auto-credited back via
  the audited `credit.adjust` increment (§3, [08 §6](./08-compliance.md)).
- **Internal-overlay re-reveals stay 0 (first-reveal-wins).** When a bulk row matches a contact the
  workspace **already revealed**, the `ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING`
  claim charges **0** (§1, §3) — re-running a job, or enriching rows that overlap existing workspace data,
  never double-charges. Charging is a function of *new* verified matches, not input rows.
- **Pre-run estimate + explicit confirmation (no surprise spend).** Before a job runs, a sampled
  match-rate pass produces a **credit forecast** persisted to `enrichment_jobs.credit_estimate_micros`,
  surfaced to the user; the job sits in status **`awaiting_confirmation`** until the user confirms. Because
  the estimate is a forecast (sample match-rate × placeholder per-match cost), the **authoritative charge
  is still the sum of per-row §3 transactions** — actual spend is recorded in
  `enrichment_jobs.credit_spent_micros` over `charged_rows` (rows that consumed > 0), and reconciled in §8
  exactly like every other reveal. The estimate informs consent; it never substitutes for the in-tx
  `CHECK >= 0` guard, which still hard-stops a job that would overdraw mid-run (`INSUFFICIENT_CREDITS`).
- **Per-tenant bulk quota + concurrency cap (noisy-neighbor protection).** A bulk job is entitlement-gated
  before the credit check (§5): a **per-tenant bulk quota** (rows/day or jobs/day, a `features` flag —
  placeholder per §1) and a **concurrency cap** (max in-flight bulk jobs per tenant) bound any one tenant's
  share of shared enrichment capacity. A **daily provider-spend budget breaker** trips bulk matching when a
  tenant's provider cost (`provider_calls.cost_micros`, [06](./06-enrichment-engine.md)) crosses its daily
  ceiling — the bulk analogue of the per-tenant enrichment circuit-breaker, protecting both margin and
  co-tenants. These caps gate *job admission*; they are orthogonal to credit balance (a tenant can be within
  quota yet out of credits, or vice-versa).
- **Lease-based decrement for high-concurrency tenants** ([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md)).
  A large job's many concurrent per-row decrements all contend on the single `FOR UPDATE` tenant row — the
  hot-lock §2 calls out. From **M12** the job acquires a **credit lease** (a reserved slice of the tenant
  pool) and decrements against the lease, settling the remainder back on completion; this relieves the
  tenant-row contention without weakening the `balance == SUM(delta)` invariant the M11 `credit_ledger`
  establishes. Until M12 the per-row §3 path is authoritative for bulk too.

Cost/quota blowout is tracked as **Risk #25** (owner **M17**) in the roadmap risk register
([10](./10-roadmap.md)); the decision and the full forecast/quota design live in
[ADR-0038](./decisions/ADR-0038-bulk-enrichment-billing-forecast-and-quota.md) and
[31 §6/§7](./31-bulk-enrichment-pipeline.md).

## 12. Open questions

1. **Reveal pricing by `reveal_type`** (email vs phone vs full_profile), pack sizes/prices, signup
   bonus, expiry. *(Placeholders in §1; the pricing **policy** — transparent, no-lock-in — is decided in
   [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md) / §1A.)*
2. ~~**Billing hardening:** when to reintroduce the append-only ledger.~~ **Resolved** —
   [ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md): `credit_ledger` at **M11**
   (counter becomes a derived cache), lease-based decrement at **M12** (§2).
3. Subscription plans (seat-based) on top of credits — when? (Post-MVP; tenant entitlements already
   support it.)
3a. ~~**Bulk credit mechanics** (G-BIL-1, mechanics): how a million-row reveal/enrich job reserves and
   reconciles credits without serializing on the §3 hot lock.~~ **Resolved** (§3A): pre-flight worst-case
   **estimate**, a **worst-case lease** per job ([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md)
   M12 — settle on completion, release the remainder), **dedup-before-enrich**, **partial-spend / resume** on
   exhaustion, and **batch-granularity credit-back** ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)).
   Pipeline: [./30-bulk-import-export-pipeline.md](./30-bulk-import-export-pipeline.md),
   [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md).
4. ~~Policy on charging for `risky`/`catch_all` emails (charge, discount, or warn-only?).~~ **Resolved**
   ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), §3): charge only for `valid`;
   `invalid`/`catch_all`/`unknown`/no-data → **0**; `risky` → charged-but-flagged (configurable) — plus
   **credit-back on bounce**. Remaining placeholder: the credit-back **guarantee window** and the `risky` default.
