# ADR-0049 — Machine API credentials: `api_keys`, and the surface they unlock

- **Status:** Accepted (credential layer); Proposed (the data endpoints they authenticate)
- **Date:** 2026-08-21
- **Related:** [ADR-0048](./ADR-0048-public-developer-portal-doc-truepoint-in.md) §C4 + its deferred item F (this ADR is that item being taken up) · [ADR-0030](./ADR-0030-granular-tenant-org-roles.md) (`security_admin` owns API keys) · [ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md) (what a metered call spends) · [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) (the graph a data API would serve) · [ADR-0018](./ADR-0018-auth-policy-and-mfa-enforcement-model.md) / `scim_tokens` (the credential this is modelled on)
- **Specs it implements:** [09 §1 "Auth (machine/public)", §4, §8, §11 Q4](../09-api-design.md)
- **Recorded conflict it closes:** C11 in [intelligence-platform/09-api-architecture.md](../intelligence-platform/09-api-architecture.md) — *"The one real gap: there are no API keys."*

> **Locked by this ADR.** TruePoint issues **tenant- and workspace-bound, scoped, SHA-256-hashed bearer keys**
> from `api_keys`, managed at `/api/v1/tenants/me/api-keys` behind the `security_admin` org role. A key is an
> *authentication mechanism only*: it resolves to the same `(tenantId, workspaceId)` context a session JWT
> produces, and every downstream query runs through the ordinary `withTenantTx` RLS seam. Nothing about
> tenancy, RLS, metering or suppression is special-cased for machine callers.

## Context

Three things were independently true before this ADR, and together they made the gap absurd:

1. **The management UI shipped and has been dead since M10.** `apps/web/src/features/settings-developer`
   does create / rotate / revoke, the one-time secret reveal, and copy-to-clipboard. It calls
   `GET /api/v1/tenants/me/api-keys`, receives a 404, and renders *"API keys connect once the developer API
   ships (M10)."* The front end was never the missing part.
2. **The contract was published.** `doc.truepoint.in` (ADR-0048) documents the endpoints such a key would
   authenticate, with every one badged "planned".
3. **There was no credential.** No `api_keys` table, no repository, no middleware. Authentication was user
   session JWTs and extension-scoped tokens — no server-to-server credential of any kind existed.

The reason it stayed unbuilt is recorded honestly in the intelligence-platform audit: an API-key system is an
authentication surface needing security review, a rate-limit and metering position, and *a decision about
whether TruePoint wants a public API at all*. That last one is a product decision, and it has now been taken —
see the ratification note below.

## Decision

### D1 — A key is authentication, not a parallel authorization system

`apiKeyAuth` resolves a presented key exactly as `scimAuth` resolves an IdP token: SHA-256 the bearer value,
look it up, and read the tenant **from the matched row**. It then sets the same `tenantId` / `workspaceId`
context variables `tenancy` sets, so every existing repository, RLS policy and `withTenantTx` call works
unchanged and unaware. The alternative — a separate query path for machine callers — would mean two
implementations of tenant isolation, and the second one is always the one that leaks.

### D2 — Bound to a workspace, resolving 09 §11 open question 4

The question was whether a key should be tenant-wide with an explicit `X-Workspace-Id` per call, or bound to
one workspace. **Bound.** `tenancy.md`'s rule is that scope comes from the credential and never from the
request; an `X-Workspace-Id` header is caller-supplied, so a tenant-wide key would reintroduce precisely the
client-controlled scope that rule exists to forbid. A customer who needs two workspaces mints two keys, which
also gives them independent revocation and independent usage attribution.

### D3 — Scopes are a spend control, not an access nicety

A key carries an explicit scope list; a route declares the scope it requires. The load-bearing split is
between reading and *spending*: TruePoint's reveal path debits the tenant's credit balance inside the reveal
transaction, so an integration key without that split can drain a customer's balance through an automation
loop with no human in it. `requireEntitlement` and the rate limiters bound *who* and *how fast* — only a scope
bounds *whether this credential may spend at all*. The vocabulary is 09 §4's, not a new one: the shipped
picker already offers four of the five, and inventing a parallel set would have orphaned it.

### D4 — Only the hash is stored, and rotation happens in place

The plaintext is generated at the route, returned once, and never persisted or logged. `key_hash` is
**globally unique**, which is what makes the pre-tenant lookup sound: a hash matches at most one row across
all tenants, so the tenant can be learned from the row rather than asserted by the caller. Rotation replaces
the secret on the *same row* — same id, same scopes — because a key's identity in a customer's inventory
("the production key") should survive a rotation; revoke-and-recreate turns that into a graveyard of
same-named rows. `last_used_at` is cleared on rotation, since it described the retired secret.

SHA-256 rather than a slow KDF is deliberate: a password hash is slow *because passwords are low-entropy and
human-chosen*. A 256-bit CSPRNG value is neither, there is no dictionary to attack, and the hash runs on
every request — a deliberately-slow KDF there is a self-inflicted latency floor.

### D5 — Management is a tenant duty, on the org-role axis

`requireOrgRole("security_admin")`, per ADR-0030. A workspace `admin` is not automatically allowed to mint a
credential that can spend the *tenant's* credits; the two RBAC axes exist precisely so that duty and data
access are separable. `owner` passes implicitly.

## Consequences

- The shipped Settings ▸ Developer panel goes live with no frontend change.
- One new tenant-owned table, with RLS `ENABLE` + `FORCE`, `USING` + `WITH CHECK`, fail-closed on the GUC, and
  the mandatory cross-tenant isolation test (`packages/db/test/apiKeys.itest.ts`).
- The pre-tenant auth lookup runs on the privileged connection. That is a deliberate, narrow BYPASSRLS use,
  justified by the global uniqueness of `key_hash` and mirrored on `scimTokenRepository.findActiveByHash`. If
  a deployment grants `leadwolf_admin` without BYPASSRLS the lookup fails **closed** — every call 401s — which
  is the safe direction.
- A live credential now exists that no endpoint yet accepts. That is intentional: the credential layer is
  useful on its own (a customer can provision and rotate before integrating), and shipping it separately keeps
  the security review of *issuance* apart from the review of *egress*.

## D6 — The first endpoints: companies only, and the reason is compliance, not effort

`/api/v1/public/company/match` (free) and `/api/v1/public/company/enrich` (billable) ship behind
`PUBLIC_DATA_API_ENABLED`. **Person and search endpoints do not**, and the line between them is not scope
management — it is the suppression precondition described below. Company records carry organization facts
only: no person, no contact channel, nothing a data subject can be suppressed on. They therefore have no
`suppression_list` reconciliation to do, which is exactly what the person half cannot say.

Three properties of the money path are worth stating because getting any of them wrong is expensive:

- **The graph read happens outside the tenant transaction.** It is the slow part; holding a `FOR UPDATE` on
  the tenant row across it would serialize every concurrent call from one customer behind a single query.
  Same reasoning `revealContact` gives for keeping verification out of its lock window.
- **No match, no charge — and the miss is still counted.** `calls − billed_calls` in the usage rollup is what
  makes that promise checkable by the customer rather than a slogan. Dropping the misses would quietly
  flatter our own hit rate.
- **Charge, ledger and meter commit in one transaction.** There is no state in which the balance moved
  without a ledger row explaining it.
- **Matching is free on purpose.** An integration calls it on every inbound record to decide whether
  enriching is worth a credit. Metering it would tax the step that keeps a customer's spend efficient, earn
  almost nothing, and make our unit economics look worse in every buyer's spreadsheet. It is rate-limited
  instead — the right control for a cheap read.

Usage is recorded in `api_key_usage_daily`, a per-(key, day, endpoint) rollup upserted at write time rather
than a per-call event log: a public API's call volume makes "show me this month" an aggregate over millions
of rows otherwise. It is a **counter, not a billing record** — the ledger is the money's source of truth and
nothing reconciles against the rollup, deliberately, because a second money source is how ledgers rot.

## Open — the endpoints still blocked

The credential and the company surface are Accepted; the person and search surface is not, and one problem
must be solved before it can be. **Recorded here rather than discovered later:**

**A public data API over the master graph is an egress with no `suppression_list` coverage.** Every Layer-0
read checks only `master_persons.is_suppressed` (via `MASTER_PERSON_VISIBLE`), and `is_suppressed` mirrors
*only* what the DSAR fan-out writes — it is not a mirror of tenant- or workspace-scoped `suppression_list`
rows and it has no domain rung. The two cannot be joined in one query by construction: `leadwolf_er` has no
grant on `suppression_list` and `leadwolf_app` has none on `master_*`. The overlay path reconciles them in a
*second* transaction (`revealContact` checks suppression in the tenant tx after the er tx produced the value);
a new public surface must do the same or it will serve suppressed people. This is invariant 3 of
`09-compliance.md` — suppression enforced at **every** egress — and satisfying it is a precondition, not a
follow-up.

Also unresolved, and each needs a decision before the endpoints ship:

| Open | Why it matters |
|---|---|
| Path prefix: `/v1/*` (as `doc.truepoint.in` publishes) vs `/api/v1/*` (as everything else serves) | A `/v1` mount escapes the `/api/*` rate limiter *and* the body-size cap; `middleware/rateLimit.ts` also skips any request carrying an `Authorization` header, so an API-key call under `/api/*` is throttled by **neither** limiter. Whichever prefix wins, a per-key limiter must be added. |
| Wire format: the portal publishes snake_case fields and kebab-case error codes; `/api/v1` is camelCase with snake_case codes | Both are published. One has to change, and the shipped platform is the one with users. |
| Same credit pool as reveals, or separate metering (09 §11 Q1) | ADR-0029's ledger is per-tenant and already correct for either; the choice is a pricing position, not a technical one. |
| CORS | A key is a server-side credential and must never reach a browser. The global credentialed CORS at `app.ts` matches `*`, so a public router must register ahead of it or narrow it explicitly. |

## Ratification note — the fourth market (closes ADR-0048 §C4)

ADR-0048 §C4 flagged that the developer/API consumer is a **fourth market** absent from `03-outcomes.md`'s
three, and that Rule 1 therefore required it to be *flagged, not built*, pending an operator decision. The
operator has now directed this work explicitly ("build api on web application and keep its usage dashboard
inside the default web dashboard"). That directive is the ratification §C4 asked for, and it is recorded in
`docs/strategy/decisions.md` alongside this ADR. What it does **not** ratify: the source brief's supply plan.
ADR-0048 §C1 (contributor-earned credits, forbidden by rule 7) and §C2 (the Sales Navigator path, forbidden by
rule 4) remain unbuilt and unaffected — a decision to sell data by API is not a decision about where the data
comes from.
