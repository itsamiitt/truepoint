# api/

API-contract artifacts for the plans-pricing-credits package: endpoint inventories, request/
response shapes (shared Zod in `@leadwolf/types`), idempotency and pagination notes, capability
gates, and audit-action mappings. Owned primarily by `06_Architecture_And_Data.md` (synthesis in
`07_Implementation_Roadmap.md`).

Holds (gating noted per endpoint):
- As-built inventory (link, do not restate): `POST /billing/webhook`, `GET /credits/balance`,
  `GET /credits/usage`, `POST /credits/checkout`; `/admin/billing/*` economics + CSV export;
  `/admin/pricing/*` + `/admin/plans`; `POST /admin/tenants/:id/{credits,plan}`, purchases +
  refund.
- Proposed endpoints: ledger reads `[M11-ledger]`, subscription lifecycle
  `[decision-gated]` `[Stripe]`, invoice/receipt reads `[Stripe]` `[flag]`, budget/allocation
  CRUD `[M12-lease]`, credit-history filter/export.

Conventions:
- Follow the `/api/v1` contract: cursor pagination, `Idempotency-Key` on money POSTs, RFC 9457
  error envelope, shared Zod types.
- Tag each endpoint with its capability gate (`billing:read`, `pricing:manage`, `plans:manage`,
  web `workspace-admin`) and its `audit_log` action name. Plain LF line endings.
