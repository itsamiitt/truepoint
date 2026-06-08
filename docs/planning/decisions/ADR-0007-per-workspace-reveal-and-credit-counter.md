# ADR-0007 — Per-workspace reveal & tenant credit counter

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [07-billing-credits.md](../07-billing-credits.md), [03-database-design.md](../03-database-design.md)
- **Supersedes:** [ADR-0004](./ADR-0004-credit-ledger-idempotency.md) (append-only ledger, idempotent reveals)

## Context

With per-workspace contact copies ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)), reveal and credit accounting are re-scoped. The founders chose the proposal's simpler model over the append-only ledger.

## Decision

- **Credits are a tenant-level pool:** `tenants.reveal_credit_balance` (a counter) is the authoritative balance, shared across the tenant's workspaces.
- **Reveal is per-workspace, first-reveal-wins:** the first `contact_reveals` row for a `(workspace_id, contact_id)` sets ownership on the contact (`is_revealed`, `revealed_by_user_id`, `revealed_at`) via an idempotent trigger (`… AND is_revealed = FALSE`). Subsequent reveals are recorded but don't change ownership.
- **`contact_reveals` is the event log:** every reveal (who, `reveal_type` = email/phone/full_profile, `data_source`, `credits_consumed`, `revealed_fields`) is appended.
- **Charging:** a reveal consumes `credits_consumed` from `tenants.reveal_credit_balance`. Because a contact is a per-workspace copy, revealing the **same human in another workspace charges again** (no cross-workspace free re-reveal); re-revealing the **same workspace copy** is free.
- **Reveal pricing** varies by `reveal_type` (email vs phone vs full_profile) — final numbers are placeholders (see [07 §1](../07-billing-credits.md)).
- Top-ups grant credits to the tenant pool (Stripe). Entitlements/seat/workspace limits live at tenant level.

## Rationale

Simplicity and a clear per-workspace ownership story. The counter + event log is easy to reason about for a CRM-style product.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Tenant counter + per-workspace reveal (this ADR)** | Chosen | Founder decision; simplest model matching the per-workspace product. |
| Append-only ledger + tenant-scoped reveal (ADR-0004, superseded) | Rejected | Safer (idempotent, reconcilable) but more machinery; cross-workspace free re-reveal didn't fit per-workspace copies. |

## Consequences

- **Positive:** simple mental model; ownership and history are obvious; aligns with per-workspace isolation.
- **Negative / KNOWN RISKS (consciously accepted — flagged for the build phase):**
  - **No idempotency under retry/concurrency:** a bare counter decrement has no `ON CONFLICT`/`FOR UPDATE` guarantee; double-clicks or retried requests can double-charge unless the app adds its own guard.
  - **No reconciliation invariant:** there's no `balance == SUM(delta)` audit; drift can't be detected from a single counter.
  - **No native refund/adjustment history** and weaker Stripe-webhook idempotency.
  - **Duplicate spend:** a tenant pays again for the same human in each workspace.
- **Required mitigations (carry into M3 build, see [07 §3](../07-billing-credits.md)):** wrap the counter update in a transaction with `SELECT … FOR UPDATE` + a `CHECK (reveal_credit_balance >= 0)`; enforce reveal idempotency via a unique constraint on `contact_reveals (workspace_id, contact_id, reveal_type)` and a client `Idempotency-Key`; make Stripe top-ups idempotent on `stripe_event_id`; keep the in-transaction suppression/consent gate.

## Revisit if
Billing disputes, double-charge incidents, or finance's need for an auditable trail arise — reintroduce the append-only ledger from the superseded ADR-0004 (the counter can become a read-only cache of it). This is an explicit, expected upgrade path.
