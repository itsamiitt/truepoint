# wireframes/web/

ASCII / Markdown wireframes for the **customer app** (`apps/web`) commercial surfaces. Owned by
`05_Web_Experience.md`.

Covers (target state — gating noted per screen):
- **Billing hub** (`/settings/billing`) — one hub with Plan / Credits / Usage / Invoices /
  Subscription (OD-3): plan + seat StatTiles, balance card with Top-up, UsageTable.
- **Public pricing page** — unauth, transparent self-serve pricing (`ADR-0012`); **not built
  today** `[Stripe]` `[flag]`.
- **Self-serve plan change** — upgrade / downgrade / cancel `[decision-gated]` (OD-1).
- **Invoices / receipts** `[Stripe]` `[flag]`; **credit history** pagination/filter/export.
- **Allocation UI** — team/workspace budgets + per-user soft limits `[M12-lease]` (OD-2).
- Shell affordances: `CreditPill` (top-bar balance, low<20 amber) and the home credit/burn tile.

Conventions:
- Web is vanilla React + `fetchWithAuth` + `StateSwitch` + `MaybeList` (NOT TanStack Query).
- Purchase/allocate actions are **workspace-admin-only** (OD-8); annotate the gate per control.
- Show four states; reference `@leadwolf/ui` primitives by name. Plain LF line endings.
