# ADR-0038 — Bulk enrichment billing, forecast & quota

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context doc:** [07-billing-credits.md](../07-billing-credits.md), [31-bulk-enrichment-pipeline.md](../31-bulk-enrichment-pipeline.md), [03-database-design.md](../03-database-design.md)
- **Extends:** [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) (charge-by-verified-result + credit-back, now applied per row in a bulk job), [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md) (the tenant counter + per-workspace first-reveal-wins reveal that bulk rows charge against), [ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md) (lease-based decrement, the high-concurrency path bulk jobs ride)
- **Siblings:** [ADR-0039](./ADR-0039-bulk-enrichment-pipeline.md) (the job pipeline this bills), [ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md) (the match-first stage whose sample feeds the forecast)

## Context

TruePoint is adding **bulk CSV enrichment** ([31](../31-bulk-enrichment-pipeline.md)): a user uploads a sparse CSV,
the rows are matched against our own universe ([ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md)) and
enriched/verified, then downloaded — at enterprise scale (a single job can be hundreds of thousands of rows).
The single-reveal billing path is already decided: charge a **function of the verified result**
([ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)) against the tenant counter
`tenants.reveal_credit_balance` inside the idempotent reveal transaction
([ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md), [07 §3](../07-billing-credits.md)).
Bulk does not change *what a reveal costs* — it changes the **shape of the spend** and surfaces three forces
the single-reveal path never had to answer:

1. **Spend opacity.** A user who clicks one reveal accepts one charge. A user who uploads 200k rows has **no
   idea** what they are about to spend — match rate is unknown until we try, and the market's #1 grievance is
   exactly the *surprise* of being charged for data that wasn't there
   ([market research](../../market-analysis/01-market-research.md) §7, the same complaint
   [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) answers). A bulk job that silently drains a
   credit balance is the enterprise version of that grievance.
2. **Noisy-neighbour starvation.** Bulk jobs are long, provider-heavy, and concurrent. One tenant queuing five
   500k-row jobs can starve every other tenant's enrichment workers and burn the shared **per-provider + global
   daily cost budgets** that already protect the single-reveal path ([06 §6](../06-enrichment-engine.md)) — a
   cost/quota blowout with cross-tenant blast radius.
3. **Counter hot-row at bulk throughput.** A 200k-row job decrements `tenants.reveal_credit_balance` 200k times.
   The `FOR UPDATE` on the one tenant row already serializes reveals tenant-wide
   ([ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md) context); a bulk job hammering it would
   collapse both its own and concurrent interactive reveals to single-row lock throughput.

None of these reopen the *charge model* — they extend it to a batch context honestly, fairly, and at scale.

## Decision

A bulk enrichment job ([ADR-0039](./ADR-0039-bulk-enrichment-pipeline.md)) bills through **four** rules; all
reuse the existing reveal/credit machinery unchanged.

### (a) Pre-run estimate + explicit confirm

Before any paid provider call, the job runs a **sample-based forecast** and **blocks on user confirmation**.

- The match-first stage ([ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md)) matches a **sample** of the
  uploaded rows against our universe to estimate a **match rate**, and from it a **credit forecast** for the
  full job (rows × estimated match rate × per-`reveal_type` cost). The per-reveal cost is the existing
  **placeholder** ([07 §1](../07-billing-credits.md)) — this ADR does **not** set a price; it multiplies by
  whatever §1 resolves to.
- The job parks in status **`awaiting_confirmation`** ([ADR-0039](./ADR-0039-bulk-enrichment-pipeline.md)) and
  records the forecast in **`enrichment_jobs.credit_estimate_micros`**. No provider spend, no decrement, occurs
  until the user **confirms**. The estimate is a **forecast, not a quote** — actual spend is metered per
  verified row (rule b) and recorded in `credit_spent_micros`; the UI shows estimate vs actual.
- If the tenant's balance is below the estimate, confirmation surfaces the shortfall (top-up path,
  [07 §4](../07-billing-credits.md)) before the job can start.

### (b) Charge per verified match — reuse ADR-0013, per row

Each enriched row is charged **exactly as a single reveal is** — it **is** a reveal, executed through the
existing reveal transaction ([07 §3](../07-billing-credits.md)):

- A row that yields a `valid` verified email (or a resolved phone line type) is charged full per-`reveal_type`
  cost; a row that comes back `invalid` / `catch_all` / `unknown` / provider-miss is charged **0**, with the
  `contact_reveals` row still written (`credits_consumed = 0`) so the user sees the unusable outcome — verbatim
  [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md).
- **Credit-back on bounce** applies unchanged: a charged `valid` email that hard-bounces within the guarantee
  window is auto-credited back (audited `credit.adjust`, [08 §5](../08-compliance.md)). The guarantee window is
  the existing **placeholder** ([07 §1](../07-billing-credits.md)).
- **Internal-overlay re-reveals stay 0.** A bulk row matching a contact **already revealed in the same workspace
  copy** is the existing **first-reveal-wins, free re-reveal** case
  ([ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)) — the unique
  `contact_reveals (workspace_id, contact_id, reveal_type)` makes the row's `ON CONFLICT … DO NOTHING` charge 0.
  No bulk-specific de-dup logic is needed; the constraint already does it.
- Per-row charges accumulate into **`enrichment_jobs.credit_spent_micros`**; **`enrichment_jobs.charged_rows`**
  counts the rows that consumed > 0 credits (for the estimate-vs-actual reconciliation and the job receipt).

### (c) Per-tenant bulk quota + concurrency cap + daily provider budget breaker

To prevent the noisy-neighbour starvation (Context #2):

- A **per-tenant bulk concurrency cap** (max concurrent bulk jobs / max in-flight bulk rows per tenant) and a
  **per-tenant bulk row quota** (rows/day) gate job admission — an **entitlement check**, sitting beside the
  existing entitlement guard ([07 §5](../07-billing-credits.md)), distinct from the credit check. Limits are
  plan-driven `features`/quota values; their numbers are placeholders alongside §1.
- A bulk job consumes the **same per-provider + global daily cost budgets and circuit breakers** that already
  protect the single-reveal path ([06 §6](../06-enrichment-engine.md)) — bulk does **not** get a private budget;
  it shares the breaker. When the **daily provider budget breaker** trips, in-flight bulk jobs **pause** (not
  fail) and resume on reset, so a budget event never silently double-charges or loses rows. Fairness across
  tenants is enforced by the cap above so one tenant cannot consume the whole shared budget.

### (d) Lease-based decrement for high-concurrency tenants — ADR-0029

Bulk per-row charges decrement through the **workspace/team credit lease** path
([ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md), M12), **not** the bare tenant row, so a job's
high-frequency decrements contend only on its lease row — keeping interactive reveals for the same tenant fast.
Every safety property carries over per lease: `FOR UPDATE` on the lease row, `CHECK (>= 0)`, the unique reveal
key, the client `Idempotency-Key`, and ledger reconciliation ([07 §2](../07-billing-credits.md)). Lease
exhaustion falls back to the tenant row exactly as ADR-0029 specifies; correctness is preserved by the ledger.

## Rationale

Every rule is the existing decision applied to a batch shape, not a new mechanism. (a) is the bulk form of the
trust wedge [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) won — "you only pay for valid data"
is hollow at bulk scale unless the user can *see the bill before it runs*; the forecast turns the market's #1
surprise-charge grievance into a confirm step. (b) is literally the §3 reveal transaction in a loop, so the
charge-by-result, credit-back, and free-internal-re-reveal guarantees hold per row with **zero new charge
logic**. (c) reuses the daily-budget breaker already built for enrichment and adds only a per-tenant admission
gate — the cheapest possible fairness control. (d) is exactly what ADR-0029 leases were built for: converting
a single-row serialization point into per-lease parallelism, which is precisely the bulk hot-row problem.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Forecast + confirm, charge-per-verified-match, per-tenant quota, lease decrement (this ADR) | Chosen | Extends [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)/[0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)/[0029](./ADR-0029-credit-ledger-and-lease-decrement.md) with no new charge mechanism; honest spend preview; noisy-neighbour fairness; scales the decrement. |
| Charge on match regardless of verification | Rejected | **Dishonest** — charges for matched-but-unverified/`invalid`/`catch_all` data, the exact practice [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) rejects; erodes the trust wedge at the worst scale. |
| Charge on upload (per row uploaded, before matching) | Rejected | Charges for rows we may never match or verify; punishes a sparse CSV; directly contradicts charge-only-for-`valid` ([ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)) and would charge even when the job is cancelled at the confirm gate. |
| No pre-run estimate (just run and bill) | Rejected | Recreates the surprise-charge grievance at 200k-row scale; the confirm gate is the whole point. |
| Per-bulk private provider budget | Rejected | Splits the shared daily-cost breaker ([06 §6](../06-enrichment-engine.md)), letting bulk and interactive starve each other independently; the per-tenant cap on a shared budget is fairer and simpler. |

## Consequences

- **Positive:** spend is **previewed and confirmed** before any charge (the bulk-scale form of the
  [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) trust wedge); per-row billing reuses the exact
  reveal transaction (no parallel charge code to keep in sync); free internal re-reveals fall out of the
  existing unique constraint; bulk jobs can't starve interactive reveals (lease) or other tenants (cap +
  shared breaker); estimate-vs-actual is auditable via `credit_estimate_micros` / `credit_spent_micros` /
  `charged_rows`.
- **Negative:** the forecast is a **sample-based estimate** and can diverge from actual spend (mitigated by
  metering actual per row and showing both); the per-tenant cap can delay a large tenant's job (a fairness
  trade-off); confirm adds a step to the bulk flow.
- **Mitigation:** forecast accuracy tracked on the economics dashboard ([06 §10](../06-enrichment-engine.md))
  and tuned via sample size ([ADR-0037](./ADR-0037-bulk-match-first-resolution-and-candidate-index.md)); caps are plan-driven and
  raisable per tenant; the confirm step shows the estimate range, not a single number; all per-row credit
  movements reconcile through the ledger ([ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md),
  [07 §8](../07-billing-credits.md)).

## Wiring

- **Schema:** new fields on `enrichment_jobs` — `credit_estimate_micros`, `credit_spent_micros`, `charged_rows`
  ([03 §14](../03-database-design.md), defined with the bulk pipeline table in
  [ADR-0039](./ADR-0039-bulk-enrichment-pipeline.md)). No new billing table — charges flow through existing
  `contact_reveals` + `tenants.reveal_credit_balance` + `credit_ledger` ([03 §8](../03-database-design.md)).
- **Roadmap:** new milestone **M17 — bulk enrichment** ([10](../10-roadmap.md)) owns this ADR and its siblings.
- **Risk register:** **risk #25 — bulk cost/quota blowout** ([10](../10-roadmap.md)), owner **M17**, mitigated
  by rules (a)/(c)/(d) here.
- **Billing/enrichment docs:** [07 §1/§3/§5](../07-billing-credits.md), [06 §6/§10](../06-enrichment-engine.md),
  [31](../31-bulk-enrichment-pipeline.md); decision log [00 §7](../00-overview.md).

## Revisit if

- Forecast error is materially wide enough to undermine the confirm step's value (refine the sample, or show a
  tightened range) — or users routinely confirm-then-cancel mid-run, suggesting the estimate isn't trusted.
- The per-tenant cap or shared daily budget proves too coarse and a dedicated bulk provider budget / fair-share
  scheduler is needed.
- Bulk-driven credit-back leakage or quota gaming becomes material — same ledger-and-abuse trigger as
  [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md) / [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md).
