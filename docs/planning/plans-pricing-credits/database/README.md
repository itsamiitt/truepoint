# database/

Schema design artifacts for the plans-pricing-credits package: target-state table definitions,
column dictionaries, RLS notes, and **hand-authored** migration sketches. Owned primarily by
`06_Architecture_And_Data.md`.

Holds (gating noted per object):
- As-built baseline references (link `packages/db/src/schema/{billing,auth,platformOps}.ts` and
  `docs/planning/03-database-design.md §8` — do not restate).
- Proposed additive tables: `credit_ledger` `[M11-ledger]`, `subscriptions`
  `[decision-gated]` `[Stripe]`, `invoices` / `invoice_line_items` `[Stripe]` `[flag]`,
  `payment_methods` `[Stripe]`, team/workspace `budgets` + per-user soft limits `[M12-lease]`.
- Maps onto the enterprise-readiness gaps **G-BIL-1** (no-recon invariant) and **G-BIL-2**
  (tenant-row hot-lock) from `docs/planning/28-enterprise-readiness-audit.md`.

Migration rule (host constraint):
- **No `drizzle-kit generate`** — this host has no docker and `generate` causes stale-snapshot
  drift. Every new-table migration is **hand-authored** and **CI/docker-verified**. Each table
  sketch here must include its migration + rollback + RLS-policy notes.
- Plain LF line endings.
