# ADR-0029 — Credit ledger reintroduction & lease-based decrement

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [07-billing-credits.md](../07-billing-credits.md), [03-database-design.md](../03-database-design.md)
- **Amends:** [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md) (executes its *Revisit if*
  upgrade path; reveal semantics unchanged)

## Context

[ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md) consciously accepted a bare tenant
counter with known risks: no `balance == SUM(delta)` reconciliation invariant, no native
refund/adjustment history, audit-log archaeology for disputes ([07 §2/§8](../07-billing-credits.md)).
The enterprise audit ([28 §3.10](../28-enterprise-readiness-audit.md), G-BIL-1/2 — Critical) adds two
forcing functions: (1) enterprise finance and SOC 2 auditors require replayable balance history before
enterprise GA; (2) the `FOR UPDATE` on one `tenants` row serializes **every reveal tenant-wide** — at
thousands of concurrent agents in one tenant (the [18 §1](../18-scalability-performance.md) bar), reveal
throughput collapses to single-row lock throughput, with the same pattern on `team_credit_budgets`.

## Decision

Commit the two-step hardening; the ADR-0007 reveal semantics (per-workspace first-reveal-wins,
in-tx suppression, charge-by-verified-result per [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md))
are **unchanged**.

- **M11 — append-only `credit_ledger`.** One row per grant / spend / credit-back / adjustment
  (`entry_type`, signed `delta`, idempotency key, actor, reason, refs to `purchases`/`contact_reveals`).
  `tenants.reveal_credit_balance` becomes a **derived cache** maintained in the same transaction; the
  `billing-recon` worker asserts `balance == SUM(delta)` per tenant (closing the [07 §8](../07-billing-credits.md)
  caveat). Every `credit.adjust` audit event gains a ledger row; disputes/refunds read the ledger, not
  reconstructed audit logs.
- **M12 — lease-based decrement for hot tenants.** Workspace- or team-level **credit leases**:
  pre-allocated blocks carved from the tenant pool, decremented locally under their own `FOR UPDATE` row
  and reconciled to the ledger asynchronously. The per-reveal lock contends only on the lease row; lease
  size adapts to burn rate; lease exhaustion falls back to the tenant row (correctness preserved by the
  ledger + `CHECK >= 0` on every counter). Team budgets (H18) ride the same lease rows.

## Rationale

The ledger restores provable accounting exactly along ADR-0007's documented upgrade path ("the counter
can become a read-only cache of the ledger"), and leases convert a single-row serialization point into
per-workspace/team parallelism without weakening any invariant — the mitigations that made the counter
safe (`FOR UPDATE`, `CHECK >= 0`, unique reveal key, `Idempotency-Key`) all carry over per lease.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Ledger at M11 + leases at M12 (this ADR)** | Chosen | Provable accounting before enterprise GA; hot-row relief where it bites; staged risk. |
| Keep counter + audit-log reconstruction | Rejected | Not provable (`SUM(delta)` impossible — [07 §8](../07-billing-credits.md)); fails finance/audit needs. |
| Full event-sourced billing | Rejected | Overkill; the ledger gives the invariant without rebuilding the read path. |
| Per-workspace counters without a ledger | Rejected | Splits the tenant-pool semantics with no auditability gain. |

## Consequences

- **Positive:** replayable history, dispute/refund trail, reconciliation invariant, reveal throughput
  scales with workspaces/teams instead of tenants.
- **Negative:** more machinery (ledger insert on the money path, lease refiller/reconciler); a careful
  M11 migration (backfill the ledger from `purchases` + `contact_reveals` + `credit.adjust` audit rows).
- **Wiring:** [07 §2/§8/§11](../07-billing-credits.md), [03 §8/§14](../03-database-design.md),
  [10 M11/M12 + risk #2](../10-roadmap.md), [02 §3.1](../02-architecture.md), [00 §7/§8](../00-overview.md).

## Revisit if

Lease reconciliation lag ever lets a tenant materially overspend its pool (tighten lease sizing /
synchronous fallback), or billing needs multi-currency monetary amounts beyond integer credits.
