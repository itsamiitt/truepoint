# wireframes/admin/

ASCII / Markdown wireframes for the **internal staff console** (`apps/admin`) commercial
surfaces. Owned by `04_Admin_Experience.md`.

Covers (target state — gating noted per screen):
- **Billing & Revenue Ops** (`/billing`) — economics rollup StatTiles, per-tenant economics
  table, low-balance list, CSV export; target MRR/ARR/churn drill-downs `[exists-partial]`.
- **Plans** (`/plans`) — `plan_templates` catalog CRUD, plan-change impact preview, grandfathering.
- **Pricing** (`/pricing`) — `credit_packs` catalog CRUD, effective-date scheduling, price-change
  simulation.
- **Tenant detail** (`/tenants/:id`) — Adjust credits / Apply plan / Suspend, purchases + refund.

Conventions:
- All write controls are render-gated by `useStaffMe().canMaybe(capability)`; annotate the
  gating capability (e.g. `pricing:manage`, `billing:read`, `tenants:credits`) on each control.
- Show four states (`StateSwitch`) and reference `@leadwolf/ui` primitives by name.
- Plain LF line endings.
