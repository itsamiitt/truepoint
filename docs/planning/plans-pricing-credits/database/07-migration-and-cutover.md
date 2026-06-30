# Migration & Cutover — counter → ledger, and the additive billing tables

> DRAFT planning artifact owned by `05_Backend_Architecture.md`. **No
> `drizzle-kit generate`** — this host has no docker; `generate` causes
> stale-snapshot drift (MEMORY: "Drizzle snapshot drift blocks generate"). Every
> table here ships as a **hand-authored** `packages/db/migrations/NNNN_*.sql`,
> CI/docker-verified, with the Drizzle schema object authored to match.

## 1. Per-table migration order & gating

| Order | Migration | Tables | Gating | RLS file |
|---|---|---|---|---|
| 1 | `NNNN_plan_registry.sql` | `plan_features`, `plan_template_versions`, `plan_template_variants` | `[platform]` | `rls/platformOps.sql` deny-all + REVOKE |
| 2 | `NNNN_price_history.sql` | `credit_pack_prices` | `[platform]` | `rls/platformOps.sql` |
| 3 | `NNNN_credit_ledger.sql` | `credit_ledger` | `[M11-ledger]` | `rls/billing.sql` tenant-isolation + append-only trigger |
| 4 | `NNNN_subscriptions.sql` | `subscriptions`, `billing_cycles`, `trials` | `[decision-gated]` `[Stripe]` | `rls/billing.sql` |
| 5 | `NNNN_invoices.sql` | `invoices`, `invoice_line_items`, `payment_methods` | `[Stripe]` `[flag]` | `rls/billing.sql` |
| 6 | `NNNN_promotions.sql` | `promotions` | `[decision-gated]` | `rls/platformOps.sql` |
| 7 | `NNNN_budgets.sql` | `credit_budgets`, `user_credit_limits` | `[M12-lease]` `[decision-gated]` | `rls/billing.sql` |

Each migration: (a) `CREATE TABLE` + indexes + CHECK; (b) `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + policy (tenant) **or** REVOKE (platform); (c) append-only trigger where applicable; (d) `applyMigrations.ts` REVOKE line for platform tables. Verified by the CI/docker integration suite (testcontainers), never locally.

## 2. Counter → ledger cutover (Phase 3, M11) — see `diagrams/05-counter-to-ledger-migration.mmd`

1. **Create** `credit_ledger` (counter still authoritative).
2. **Backfill** (idempotent, replayable, keyed):
   - `grant` ← `purchases` (`grant:<stripe_event_id>`, `delta = +credits`).
   - `spend` ← `contact_reveals` (`reveal:<id>`, `delta = -credits_consumed`).
   - `adjustment` ← `audit_log` `credit.adjust` / `credit.grant` (`adjust:<audit_id>`) — the §8 caveat says adjustments live only in the audit log today; the backfill reconstructs them here.
   - **Opening-drift balancing entry**: one `adjustment` per tenant = `counter − SUM(delta)` so the invariant holds from row zero.
3. **Shadow recon**: `billing-recon` asserts `balance == SUM(delta)` read-only; never cut over on a mismatch.
4. **Dual-write window**: every reveal/grant writes the ledger row + updates the counter in the **same tx** (the existing `FOR UPDATE` tx, 07 §3). Run until recon is green for N days.
5. **Flip**: counter becomes a **derived cache** of the ledger (ADR-0029); recon asserts the invariant directly — closing **G-BIL-1** (no-recon invariant) and the **07 §8** counter caveat.

## 3. Rollback

Additive tables drop cleanly (no column changes to live tables in steps 1–7) — rollback = `DROP TABLE` in reverse FK order. The cutover (step 4→5) is reversible *until* the flip: while dual-writing, reverting to counter-authoritative is a config flag, not a migration. After the flip, the counter is still present and correct (maintained in-tx), so a revert re-promotes the counter and pauses recon-against-ledger. **No destructive change is ever applied without a green shadow recon.**

## 4. Security posture (security has final say)

- Tenant tables (`credit_ledger`, `subscriptions`, `billing_cycles`, `invoices`, `invoice_line_items`, `payment_methods`, `trials`, `credit_budgets`, `user_credit_limits`): RLS tenant-isolation on `app.tenant_id`; writes only inside the scoped money tx; admin cross-tenant access via `withPlatformTx` + JIT (ADR-0011).
- Platform tables (`plan_features`, `plan_template_versions`, `plan_template_variants`, `credit_pack_prices`, `promotions`): deny-all to `leadwolf_app`; owner-connection-only; the public pricing read uses a separate read-only path — the REVOKE is **never** relaxed (05-pricing §8.1).
- `payment_methods` stores **only** Stripe tokens + display fields — PCI scope stays in Stripe.
