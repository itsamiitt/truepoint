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

Every metered subsystem enforces **per-tenant quotas** so no single org can exceed
its allowance and no incident can spend without limit:

- **Plan-based allowances** — each org's plan defines its enrichment/verification
  budget (credits/quota). Usage is checked against it before each metered call; an
  org at its limit is blocked (gracefully, with a clear message and an upgrade
  path), not allowed to overspend.
- **Hard caps as a backstop** — even above plan quotas, a hard per-tenant and
  global ceiling stops a runaway (a bug or attack) from spending without bound. The
  cap is a safety limit, distinct from the business quota.
- **Per-user limits within a tenant** — so one user (or one compromised session)
  can't burn the whole org's budget (see security api-security rate limiting).

---

## Never Pay Twice

The cheapest call is the one you don't make. Caching is a cost control as much as a
performance one (see platform caching, `truepoint-data` enrichment-pipeline):

- **Cache provider results** keyed by resolved identity; a cached-fresh result
  costs nothing. A redelivered job (at-least-once queues — platform async-jobs) must
  hit the cache, never re-pay.
- **Freshness TTLs** balance cost against staleness — re-enrich/verify only when the
  data is stale enough to justify the spend, not on every view.
- **Cost-aware provider waterfall** — try cheaper/cached sources first, premium
  providers only when needed, and stop at first sufficient answer (enrichment-
  pipeline). "Call every provider for every field" is the expensive anti-pattern.

---

## Metering Is Reliable Because Billing Depends On It

- Every metered action emits a **UsageEvent** (see `truepoint-data` data-model) —
  reliably, because usage-based billing and quota enforcement both read it. A
  dropped usage event is lost revenue or a busted quota.
- Usage is **attributable** — per tenant, per user, per provider, per action — so
  spend can be analysed, billed, and traced to a cause when it spikes.
- Usage metrics feed dashboards and alerts (platform observability) — a sudden
  enrichment-spend spike is an alert (a bug or abuse), not a month-end surprise.

---

## Cost Observability and Alerting

- **Per-tenant and global spend dashboards** show where money goes and surface
  anomalies. An org suddenly enriching 100x its normal volume is visible.
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
3. **UsageEvent** emitted on the call (metering/billing).
4. **Rate limit** per user and per org (abuse + cost — security api-security).
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
- Does every metered action emit a reliable, attributable UsageEvent?
- Are there per-tenant/global spend dashboards and spend-spike alerts tied to abuse
  signals?
- Are quota, cache, usage, rate-limit, and visibility wired at build time for any
  metered feature?
