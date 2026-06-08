# ADR-0004 — Append-only credit ledger with idempotent per-contact reveals

- **Status:** Superseded by [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md) (2026-05-29)
- **Date:** 2026-05-29
- **Superseded note:** The 2026-05-29 decision adopted a simpler **tenant-level credit counter** + **per-workspace first-reveal** model (`contact_reveals` event log + `tenants.reveal_credit_balance`). ADR-0007 records this choice **and** the known correctness trade-offs it re-introduces (the very ones this ADR was written to avoid: idempotency under concurrency, reconciliation, refund history). This body is retained as the safer alternative we may revisit.
- **Context doc:** [07-billing-credits.md](../07-billing-credits.md), [03-database-design.md](../03-database-design.md)

## Context

Credits are real money. The reveal endpoint will be hit concurrently, retried on network errors, and
must never:

- charge twice for the same action (network retry, double-click, at-least-once job delivery), or
- charge again for a contact the org already owns (free re-reveal), or
- allow a balance to go negative, or
- drift out of sync between "the balance" and "the history of movements".

## Decision

1. **Append-only ledger.** Every credit movement is one immutable `credit_ledger` row with a signed
   `delta` and a unique `idempotency_key`. The authoritative balance is `SUM(delta)`.
2. **Materialized balance.** `credit_balances.balance` is maintained in the **same transaction** as the
   ledger insert, with `SELECT … FOR UPDATE` to serialize concurrent spends, and a DB `CHECK
   (balance >= 0)`.
3. **Idempotent reveal** keyed by `reveal_key = hash(org_id, person_id)`:
   `INSERT … ON CONFLICT (reveal_key) DO NOTHING`. Not inserted → already owned → **charge 0**.
   Inserted → lock balance, verify funds, write a `reveal` ledger row, decrement.
4. **Idempotent top-ups** keyed by Stripe `event_id` (unique on `purchases` and used as the ledger
   idempotency key). Webhook is the source of truth; no client-side credit grants.
5. **Client `Idempotency-Key` header** on money endpoints; the server replays the stored response.
6. **Reconciliation job** asserts `balance == SUM(delta)` per org (alert on drift) and cross-checks
   Stripe.

## Rationale

- `reveal_key` elegantly unifies three guarantees: retry-idempotency, "already owned = free", and
  per-contact charge-once.
- `FOR UPDATE` + single-transaction ledger+balance update makes double-spend impossible under
  concurrency.
- Append-only history is auditable, reversible (refunds/adjustments are new rows), and trivially
  reconcilable.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Mutable balance counter only | Rejected | No history/audit; race-prone; hard to reconcile or refund. |
| Ledger without materialized balance | Rejected | `SUM(delta)` on every read is costly at scale. |
| Charge at enrichment time | Rejected | Couples revenue to system cost; unfair, unpredictable for users. |
| Distributed lock instead of `FOR UPDATE` | Rejected | DB row lock is simpler and sufficient; fewer moving parts. |

## Consequences

- **Positive:** correct money handling, full auditability, fair UX (free re-reveal), easy refunds.
- **Negative:** every spend touches two writes in a tx + a row lock (tiny, fast); ledger grows
  unbounded → mitigated by time-partitioning.
- **Testing:** property-based tests for invariants (never negative; `balance == SUM(delta)`; idempotent
  under N concurrent reveals); Stripe CLI double-webhook test.

## Revisit if
Per-org spend concurrency becomes a hotspot (unlikely) — consider sharded balances or a queue per org.
