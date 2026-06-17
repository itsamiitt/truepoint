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

A third forcing function lands the moment **bulk reveal/enrich** ships
([30-bulk-import-export-pipeline.md](../30-bulk-import-export-pipeline.md),
[ADR-0036](./ADR-0036-bulk-async-job-and-staging-pipeline.md)). A single million-row bulk job that
decrements credits **one row at a time** takes the tenant-row (or team-budget) `FOR UPDATE` up to a
million times — and because that one row is the same lock every interactive reveal also waits on, **one
bulk job stalls every reveal in the tenant** for its duration. This is the same hot-lock pathology as
(2), but it is **self-inflicted by a single operation** and does not need thousands of concurrent agents
to trigger it: the worst case is one user clicking "reveal all" on a large list. The lease relief in this
ADR was sequenced to M12 (the high-concurrency tier); the bulk path makes the row-at-a-time decrement a
bottleneck **the moment bulk reveal/enrich ships**, which lands in **M12** (alongside, but not gated on, the full standing-lease build-out). The bulk path therefore needs a scalable
credit-debit story of its own — it cannot wait for the per-workspace lease machinery to arrive.

## Decision

Commit the hardening in three moves — ledger (M11), **batch reservation shipped with the bulk path**, and
per-workspace/team leases (M12); the ADR-0007 reveal semantics (per-workspace first-reveal-wins,
in-tx suppression, charge-by-verified-result per [ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md))
are **unchanged**.

- **M11 — append-only `credit_ledger`.** One row per grant / spend / credit-back / adjustment
  (`entry_type`, signed `delta`, idempotency key, actor, reason, refs to `purchases`/`contact_reveals`).
  `tenants.reveal_credit_balance` becomes a **derived cache** maintained in the same transaction; the
  `billing-recon` worker asserts `balance == SUM(delta)` per tenant (closing the [07 §8](../07-billing-credits.md)
  caveat). Every `credit.adjust` audit event gains a ledger row; disputes/refunds read the ledger, not
  reconstructed audit logs.
- **Batch reservation (with bulk) — lease the worst-case, settle on completion, release the remainder.**
  A bulk reveal/enrich job ([30](../30-bulk-import-export-pipeline.md),
  [ADR-0036](./ADR-0036-bulk-async-job-and-staging-pipeline.md)) does **not** decrement per row. At
  job-admission it takes **one** `FOR UPDATE` on the tenant (or team-budget) row and writes a single
  `lease` ledger entry that reserves the **worst-case cost** — `rows × max per-row charge` (every row a
  full-cost `valid` reveal). The worker then processes rows against the **reserved** balance with no
  further lock on the tenant row. On job completion (or cancel/failure) it takes the lock **once more** to
  settle: in that one transaction it writes the **actual** spend (the sum of per-row charges the ADR-0013
  charge-by-verified-result rule produced) and **releases the remainder** (worst-case − actual) back to
  the pool. Net tenant-row lock acquisitions per bulk job: **two**, regardless of row count. This is the
  contract the billing doc references: *lease the worst-case amount for a bulk job, settle on completion,
  release the remainder*.
  - **Idempotent ledger interaction.** The reservation books at most three ledger entries, all signed
    `delta`s that net to exactly the actual spend. At admission a `lease` entry posts `delta = −worst_case`
    (the reservation holds the funds). At completion, **in one transaction**, a `settle` entry posts
    `delta = −actual` and a `release` entry posts `delta = +worst_case` — together they reverse the
    reservation and charge only the actual: `−worst + (−actual) + worst = −actual`. Each entry carries the
    **job id** as its idempotency key (`lease:<job_id>`, `settle:<job_id>`, `release:<job_id>`); a retried
    admission or a duplicated completion message replays to the same rows, so a job can lease and settle
    **at most once**. The invariant is unchanged: the reserved-but-unsettled amount is just a signed
    `delta` in the ledger, so `balance == SUM(delta)` still holds at every instant, and a crashed worker
    leaves a recoverable `lease` with no `settle` (swept by a reaper that settles to actual-processed and
    releases the rest — see *Revisit if*).
  - **Credit-back interaction.** Per-row charges inside the job still follow charge-by-verified-result
    ([ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)): a row that returns `invalid` /
    `unknown` / no-data simply contributes **0** to the settled actual, so non-`valid` rows are released
    with the remainder — no separate refund. The **bounce credit-back guarantee** is orthogonal and
    unchanged: a later hard-bounce on a row that was charged `valid` posts its own `credit_back` ledger
    entry against the original `contact_reveals` row, exactly as for an interactive reveal; it is **not**
    rolled into the job's `settle`.
- **M12 — lease-based decrement for hot tenants.** Workspace- or team-level **credit leases**:
  pre-allocated blocks carved from the tenant pool, decremented locally under their own `FOR UPDATE` row
  and reconciled to the ledger asynchronously. The per-reveal lock contends only on the lease row; lease
  size adapts to burn rate; lease exhaustion falls back to the tenant row (correctness preserved by the
  ledger + `CHECK >= 0` on every counter). Team budgets (H18) ride the same lease rows. The bulk batch
  reservation above is the **same lease primitive scoped to one job** (one reserve, one settle) rather
  than a standing per-workspace block; when M12 lands, a bulk job admitted against a workspace that holds
  a standing lease reserves from **that** lease row instead of the tenant row, so the two compose without
  a second mechanism.

## Rationale

The ledger restores provable accounting exactly along ADR-0007's documented upgrade path ("the counter
can become a read-only cache of the ledger"), and leases convert a single-row serialization point into
per-workspace/team parallelism without weakening any invariant — the mitigations that made the counter
safe (`FOR UPDATE`, `CHECK >= 0`, unique reveal key, `Idempotency-Key`) all carry over per lease.
The batch reservation applies that same lease idea at **job granularity**: it turns a million tenant-row
locks into two, so a bulk job never serializes interactive reveals — and it reuses the lease/ledger
primitives rather than inventing a bulk-only debit path, so it can ship with the bulk feature without
waiting for the full M12 per-workspace lease build-out. Reserving the **worst-case** keeps the spend
correct under charge-by-verified-result: the job can only ever cost *less* than reserved, so settle +
release is always a credit back to the pool, never an overspend.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Ledger (M11) + batch reservation (with bulk) + leases (M12) (this ADR)** | Chosen | Provable accounting before enterprise GA; bulk gets hot-row relief the day it ships; per-workspace relief where concurrency bites; staged risk. |
| Per-row decrement for bulk (defer all lease work to M12) | Rejected | One million-row job takes the tenant-row lock ~1M times and stalls **every** interactive reveal in the tenant for its duration — a single user can self-DoS billing ([30](../30-bulk-import-export-pipeline.md)). |
| Charge bulk **after** completion (no reservation) | Rejected | A job can run to the end then fail the funds check, wasting provider spend; and admitting unfunded bulk lets a tenant overshoot its pool. The worst-case reserve fails fast and bounds spend. |
| Reserve the **exact** cost up front | Rejected | The exact charge isn't known until each row is verified ([ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)); worst-case reserve + settle-to-actual is the only way to pre-authorize before results exist. |
| Keep counter + audit-log reconstruction | Rejected | Not provable (`SUM(delta)` impossible — [07 §8](../07-billing-credits.md)); fails finance/audit needs. |
| Full event-sourced billing | Rejected | Overkill; the ledger gives the invariant without rebuilding the read path. |
| Per-workspace counters without a ledger | Rejected | Splits the tenant-pool semantics with no auditability gain. |

## Consequences

- **Positive:** replayable history, dispute/refund trail, reconciliation invariant, reveal throughput
  scales with workspaces/teams instead of tenants; a bulk job costs **two** tenant-row locks instead of
  one per row, so bulk and interactive reveals stop contending for the same hot row.
- **Sequencing pull-forward (closes G-BIL-1).** The batch reservation is **decoupled from the M12 lease
  tier** and ships **with the bulk path** ([30](../30-bulk-import-export-pipeline.md),
  [ADR-0036](./ADR-0036-bulk-async-job-and-staging-pipeline.md)) — it is a prerequisite of bulk
  reveal/enrich, not a deferrable scale optimization. The full per-workspace/team standing leases remain
  at M12; pulling **only** the job-scoped reservation forward is cheap because it reuses the M11 ledger's
  idempotency-keyed entries and adds no new table — just `lease`/`settle`/`release` `entry_type`s. The
  roadmap ([10](../10-roadmap.md)) sequences the batch reservation in **M12**, the milestone that introduces
  the bulk pipeline — landing ahead of the full per-workspace/team standing leases within that milestone.
- **Relation to ADR-0036's job model.** The reservation is bound to the bulk **job** lifecycle:
  admit ⇒ `lease`, complete/cancel/fail ⇒ `settle` + `release`. ADR-0036 owns the job state machine,
  staging, and at-least-once worker delivery; this ADR owns only the **credit** entries keyed by that
  job's id. The job id is the shared idempotency anchor, so ADR-0036's retry/resume semantics and this
  ADR's exactly-once lease/settle compose cleanly (a resumed job re-settles to the same row).
- **Negative:** more machinery (ledger insert on the money path, lease refiller/reconciler, a
  lease-reaper that settles crashed/abandoned bulk jobs); a careful M11 migration (backfill the ledger
  from `purchases` + `contact_reveals` + `credit.adjust` audit rows).
- **Wiring:** [07 §2/§8/§11](../07-billing-credits.md), [03 §8/§14](../03-database-design.md),
  [10 M11/M12 + risk #2](../10-roadmap.md), [02 §3.1](../02-architecture.md), [00 §7/§8](../00-overview.md),
  [30-bulk-import-export-pipeline.md](../30-bulk-import-export-pipeline.md),
  [ADR-0036](./ADR-0036-bulk-async-job-and-staging-pipeline.md).

## Revisit if

Lease reconciliation lag ever lets a tenant materially overspend its pool (tighten lease sizing /
synchronous fallback), or billing needs multi-currency monetary amounts beyond integer credits, or
abandoned bulk **reservations** tie up enough of a tenant's pool to block legitimate reveals (tighten the
lease-reaper's settle-and-release interval, or cap the worst-case reserve per job and re-reserve in
chunks).
