# FinOps — Cost Control

TruePoint spends real money per call on metered third-party subsystems —
enrichment and verification providers cost money every time they're hit. At
millions of users this is a primary business risk: without controls, a bug, a bad
loop, a stolen session, or a single aggressive tenant can run up an unbounded bill.
Cost control is therefore an architectural concern, not an afterthought. The
security side (stopping abuse) is in `truepoint-security` api-security; this file is
the cost-management discipline.

---

## Metered Spend Is Bounded Per Tenant

Every metered subsystem enforces **per-tenant quotas** so no single tenant can
exceed its allowance and no incident can spend without limit:

- **Plan-based allowances** — each tenant's plan defines its enrichment/verification
  budget (credits/quota). Usage is checked against it before each metered call; a
  tenant at its limit is blocked (gracefully, with a clear message and an upgrade
  path), not allowed to overspend.
- **Hard caps as a backstop** — even above plan quotas, a hard per-tenant and
  global ceiling stops a runaway (a bug or attack) from spending without bound. The
  cap is a safety limit, distinct from the business quota.
- **Per-user limits within a tenant** — so one user (or one compromised session)
  can't burn the whole tenant's budget (see security api-security rate limiting).

> **Implementation status:** partially met. Spend is *tracked* — every provider call
> is ledgered with its `cost_micros` (`provider_calls`, `packages/db/src/schema/intel.ts`),
> enrichment jobs carry `credit_estimate_micros` / `credit_spent_micros`
> (`packages/db/src/schema/enrichmentJobs.ts`), and a credits/billing system exists
> (Stripe top-ups → `purchases`, balance/usage at `/api/v1/credits`,
> `apps/api/src/features/billing/routes.ts`). The per-tenant **quota/cap enforcement
> gate before each metered call** (plan allowance + hard cap + per-user limit) is the
> target and is not yet wired into the enrichment call path — keep it as the mandate.

---

## Never Pay Twice

The cheapest call is the one you don't make. Caching is a cost control as much as a
performance one (see platform caching, `truepoint-data` enrichment-pipeline):

- **Cache provider results** keyed by resolved identity; a cached-fresh result
  costs nothing. A redelivered job (at-least-once queues — platform async-jobs) must
  hit the cache, never re-pay.

  > **Implementation status:** the cache today is **DB-level only** — `provider_calls`
  > (`packages/db/src/schema/intel.ts`) persists one answer per
  > `(workspace_id, request_hash)` with `cache_hit` and `cost_micros`, so a duplicate
  > resolves against the stored payload rather than re-paying. There is no
  > faster (in-memory/Redis) tier in front of it yet, and the "a fresh cached result
  > costs nothing" guarantee depends on the read path consulting `provider_calls`
  > before every metered call — keep that as the mandate.
- **Freshness TTLs** balance cost against staleness — re-enrich/verify only when the
  data is stale enough to justify the spend, not on every view.
- **Cost-aware provider waterfall** — try cheaper/cached sources first, premium
  providers only when needed, and stop at first sufficient answer (enrichment-
  pipeline). "Call every provider for every field" is the expensive anti-pattern.

---

## Metering Is Reliable Because Billing Depends On It

- Every metered action emits a **usage record** (see `truepoint-data` data-model) —
  reliably, because usage-based billing and quota enforcement both read it. A
  dropped usage record is lost revenue or a busted quota.

  > **Implementation status:** the metered-action ledger exists as the `provider_calls`
  > rows with `cost_micros` (`packages/db/src/schema/intel.ts`) plus the append-only
  > `audit_log` (`packages/db/src/schema/billing.ts`); there is no single table named
  > `UsageEvent`. The mandate stands: every metered action must record attributable
  > usage reliably enough for billing and quota to read it.
- Usage is **attributable** — per tenant, per user, per provider, per action — so
  spend can be analysed, billed, and traced to a cause when it spikes.
- Usage metrics feed dashboards and alerts (platform observability) — a sudden
  enrichment-spend spike is an alert (a bug or abuse), not a month-end surprise.

---

## Cost Observability and Alerting

- **Per-tenant and global spend dashboards** show where money goes and surface
  anomalies. A tenant suddenly enriching 100x its normal volume is visible.
- **Spend alerts** fire on unusual cost rate — the cost equivalent of an SLO burn
  alert. Tie them to the abuse signals in security api-security; a cost spike and an
  abuse spike are often the same event.
- Cost is treated as a **first-class scaling dimension** (platform scaling-playbook)
  — designing a metered feature includes designing its cost behaviour at volume.

---

## Build-Time FinOps (Like Tests and Observability)

When building a feature that hits a metered provider, wire the cost controls at
build time, not after the first big bill:

1. **Quota check** before the metered call (plan allowance + hard cap).
2. **Cache check** before the call (never pay twice).
3. **Usage record** emitted on the call (metering/billing).
4. **Rate limit** per user and per tenant (abuse + cost — security api-security).
5. **Spend visibility** — the call shows up in the per-tenant cost dashboard.

A metered feature shipped without these is shipped with an open cost hole.

---

## Checklist

- Is every metered call gated by a per-tenant quota plus a hard cap backstop, and a
  per-user limit?
- Is a fresh cached result reused so providers are never paid twice, including on
  job redelivery?
- Does the provider waterfall try cheap/cached first and stop at first sufficient
  answer?
- Does every metered action emit a reliable, attributable usage record?
- Are there per-tenant/global spend dashboards and spend-spike alerts tied to abuse
  signals?
- Are quota, cache, usage, rate-limit, and visibility wired at build time for any
  metered feature?
