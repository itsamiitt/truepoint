# API — Proposed Endpoint Contracts (plans-pricing-credits)

> DRAFT planning artifact owned by `05_Backend_Architecture.md`. Every endpoint
> below is **gated**; deferred infra is never presented as built. Follows the
> `/api/v1` contract: cursor pagination (base64url keyset, `limit+1` probe,
> `PLATFORM_READ_LIMIT=500`), `Idempotency-Key` on money POSTs, RFC 9457 error
> envelope, shared Zod types in `@leadwolf/types`. Security has final say: every
> money/permission row cites its tenant-isolation / RLS / JIT / capability gate.

## A. Existing endpoints REUSED (link, do not restate — owned by 07 / tab audits)

| Method · Path | Capability / auth | Audit action | Notes |
|---|---|---|---|
| `POST /api/v1/billing/webhook` | Stripe HMAC signature (300s skew) | `purchase` (grant) | THE only credit-grant path. `purchases.stripe_event_id` UNIQUE dedupe. `[exists]` `[Stripe]` |
| `GET /api/v1/credits/balance` | tenant authn | — | Counter read today; ledger-derived after M11. `[exists]` |
| `GET /api/v1/credits/usage` | tenant authn | — | Paginated `contact_reveals`. `[exists]` |
| `POST /api/v1/credits/checkout` | workspace-admin (OD-8) | — | Returns `{available, checkoutUrl}`. `[exists]` `[Stripe]` |
| `GET /api/v1/admin/billing/economics[/by-tenant][/export]` | `billing:read`, `withPlatformTx` | `admin.billing_economics` / `admin.list_tenant_economics` / `admin.billing_export` | `[exists]` |
| `GET /admin/billing/low-balance` | `billing:read` | `admin.list_low_balance` | `[exists]` |
| `GET·PUT /admin/pricing/credit-packs`; `POST .../:key/active` | `pricing:manage`, `withPlatformTx` | `credit_pack.set` | `[exists]` |
| `GET·PUT /admin/pricing/plan-templates`; `POST .../:key/active` | `pricing:manage` | `plan_template.set` | `[exists]` |
| `POST /admin/tenants/:id/credits` | `tenants:credits` + JIT-elevation (ADR-0011) | `credit.grant` / `credit.adjust` | Idempotency-Key supported. `[exists]` `[capability]` |
| `POST /admin/tenants/:id/plan` | `plans:manage` + JIT | `plan.override` | `[exists]` `[capability]` |
| `GET /admin/tenants/:id/purchases`; `POST .../purchases/:pid/refund` | `billing:read` / `tenants:credits` + JIT | `credit.adjust` | Refund clamps reversal to balance. `[exists]` `[capability]` |

## B. Proposed endpoints

### B.1 Credit ledger reads `[M11-ledger]`

| Method · Path | Capability | Req → Resp | Idempotency |
|---|---|---|---|
| `GET /api/v1/credits/ledger` | tenant authn (own tenant via RLS) | `?cursor&limit&entryType?&from?&to?` → `{ entries: LedgerEntry[], nextCursor }` | n/a (read) |
| `GET /api/v1/admin/tenants/:id/ledger` | `billing:read`, `withPlatformTx` (`admin.list_credit_ledger`) | keyset → `{ entries[], nextCursor }` | n/a |
| `POST /api/v1/admin/tenants/:id/credit-adjust` | `tenants:credits` + JIT-consume (same tx) | `{ delta, reason }` → `LedgerEntry` | `Idempotency-Key` → `adjust:<key>` ledger row |

`LedgerEntry` (shared Zod): `{ id, entryType, delta, balanceAfter?, reason?, actorUserId?, createdAt }`.
RLS: tenant read is RLS-scoped; admin read goes through `withPlatformTx` (cross-tenant, audited). Adjust writes the ledger row + audit row in ONE tx and consumes a JIT elevation (rejected action releases the grant).

### B.2 Subscription lifecycle `[decision-gated]` `[Stripe]` (proposed ADR-0041)

| Method · Path | Capability | Req → Resp |
|---|---|---|
| `GET /api/v1/billing/subscription` | tenant authn | → `Subscription \| null` |
| `POST /api/v1/billing/subscription` | workspace-admin (OD-8) | `{ planTemplateKey, term, autoRenew?, variantId? }` → `Subscription` (+ `checkoutUrl` for paid) |
| `PATCH /api/v1/billing/subscription` | workspace-admin | `{ planTemplateKey?, term?, cancelAtPeriodEnd? }` → `Subscription` (proration via Stripe) |
| `DELETE /api/v1/billing/subscription` | workspace-admin | → `{ canceledAt, accessUntil }` (ADR-0012: no data-destroy on churn) |

ADR-0012 guard: `autoRenew` defaults `false`; the API NEVER defaults annual/auto-renew on. All state transitions are reconciled from Stripe `customer.subscription.*` webhooks — the POST/PATCH only *initiates*; Stripe is source of truth.

### B.3 Invoices / receipts `[Stripe]` `[flag]` (OD-5)

| Method · Path | Capability | Req → Resp |
|---|---|---|
| `GET /api/v1/billing/invoices` | tenant authn | `?cursor&limit` → `{ invoices: Invoice[], nextCursor }` |
| `GET /api/v1/billing/invoices/:id` | tenant authn (RLS) | → `Invoice` (with `lineItems[]`, `hostedInvoiceUrl`) |
| `GET /api/v1/admin/tenants/:id/invoices` | `billing:read`, `withPlatformTx` | keyset → `{ invoices[], nextCursor }` |

Behind a feature flag; local mirror reconciled from `invoice.*` webhooks. No PAN data ever returned (security).

### B.4 Public pricing read `[Stripe-adjacent]` `[flag]` (reuse 05-pricing §8.1)

| Method · Path | Auth | Req → Resp |
|---|---|---|
| `GET /api/v1/pricing/credit-packs` | **unauthenticated**, rate-limited | → `{ packs: PublicPack[] }` (active only; `key,name,credits,priceCents,currency,sortOrder`) |
| `GET /api/v1/pricing/plans` | unauthenticated, rate-limited | → `{ plans: PublicPlan[] }` (active templates + variant prices) |

Served by a **read-only** connection path; the `REVOKE ALL … FROM leadwolf_app` on the platform catalog is NEVER relaxed (security sign-off required). Cache aggressively; invalidate on `credit_pack.set` / `plan_template.set`.

### B.5 Plan entitlement registry + versions `[exists-partial]` (reuse 04-plans §8.1/§8.2)

| Method · Path | Capability | Audit |
|---|---|---|
| `GET /api/v1/admin/pricing/plan-features` | `pricing:manage` | `admin.list_plan_features` |
| `GET /api/v1/admin/pricing/plan-templates/:key/versions` | `pricing:manage` | `admin.list_plan_template_versions` |

### B.6 Promotions `[decision-gated]` (reuse 05-pricing §8.2)

| `GET·PUT /api/v1/admin/pricing/promotions`; `POST .../:code/active` | `pricing:manage`, `withPlatformTx` | `promotion.set` |

### B.7 Hierarchical allocation `[M12-lease]` `[decision-gated]` (OD-2, proposed ADR-0042)

| Method · Path | Capability | Req → Resp | Idempotency |
|---|---|---|---|
| `GET /api/v1/billing/budgets` | tenant authn (RLS) | → `{ budgets: CreditBudget[] }` | — |
| `POST /api/v1/billing/budgets` | workspace-admin (OD-8) | `{ scope, workspaceId?, teamId?, allocation, hardCap?, period? }` → `CreditBudget` | `Idempotency-Key` |
| `PATCH /api/v1/billing/budgets/:id` | workspace-admin | `{ allocation?, hardCap?, active? }` → `CreditBudget` | `Idempotency-Key` |
| `GET·PUT /api/v1/billing/users/:uid/limit` | workspace-admin | `{ limitCredits, enforce?, period? }` → `UserCreditLimit` | — |

RLS: budgets/limits carry `tenant_id`, tenant-isolated. Every write **re-resolves scope from the authenticated context** — the budget/limit/workspace IDs from the client are never trusted (security). Allocation can only subdivide the tenant pool; over-allocation is rejected against the authoritative balance.

### B.8 Credit-history export / filter (web) `[exists-partial]`

| `GET /api/v1/credits/usage` extended: `?revealType&dataSource&from&to&format=csv` | tenant authn | → CSV stream or paginated JSON |

## C. Idempotency & concurrency (cite, do not restate)

The money-POST idempotency + concurrency mechanism is **07 §2/§3** (counter `FOR UPDATE`, `Idempotency-Key` stored-response replay via `idempotency_keys`, reveal unique-claim, Stripe `stripe_event_id` dedupe). New endpoints REUSE that machinery — ledger entries dedupe on `(tenant_id, idempotency_key)` (see `database/01-credit_ledger.sql`); lease/settle/release dedupe on `<job_id>` (ADR-0029). Nothing here re-implements the reveal transaction.
