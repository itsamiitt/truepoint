# wireframes/

ASCII / Markdown wireframes for every commercial surface in this package, split by portal:

- `admin/` — internal staff console (`apps/admin`): Billing & economics, Plans, Pricing, and the
  tenant-detail credit/plan/refund controls.
- `web/` — customer app (`apps/web`): the billing hub, public pricing page, self-serve
  upgrade/downgrade/cancel, invoices/receipts, credit history, and allocation UI.

## Index (authored by `03_Information_Architecture.md §8.3`)

| File | Portal | Destination | Gating |
|---|---|---|---|
| [`admin/billing-economics.md`](./admin/billing-economics.md) | admin | `/billing` | `[exists]` + `[exists-partial]`/`[M11-ledger]`/`[Stripe]` nested |
| [`admin/plans.md`](./admin/plans.md) | admin | `/plans` | `[exists]` + `[decision-gated]` |
| [`admin/pricing.md`](./admin/pricing.md) | admin | `/pricing` | `[exists]` + `[decision-gated]` |
| [`admin/tenant-detail.md`](./admin/tenant-detail.md) | admin | `/tenants/:id` | `[exists]` + `[M11-ledger]`/`[M12-lease]`/`[Stripe]` |
| [`web/public-pricing.md`](./web/public-pricing.md) | web | `/pricing` (unauth) | `[Stripe]`/none |
| [`web/billing-hub.md`](./web/billing-hub.md) | web | `/settings/billing` (tabs) | `[exists-partial]` |
| [`web/plan-change.md`](./web/plan-change.md) | web | hub · Plan/Subscription | `[decision-gated]` |
| [`web/allocation.md`](./web/allocation.md) | web | hub · Allocation | `[M12-lease]` `[decision-gated]` |

Conventions:
- Wireframes are low-fidelity text/ASCII layouts (boxes, columns, state labels) — not pixel
  mockups. Always show the four states where relevant (loading / empty / error / data,
  per `StateSwitch`).
- Reference shared `@leadwolf/ui` primitives by name (StatTile, DataTable, Progress,
  StatusBadge, EmptyState, Skeleton) rather than redrawing them.
- Keep admin and web concerns in their own subfolder — never mix portals in one file.
- Plain LF line endings.
