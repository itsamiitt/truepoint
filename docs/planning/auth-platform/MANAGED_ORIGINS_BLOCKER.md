# AUTH-036 / tracker item 1.4c-wire — why "wire the call sites" cannot be done as written

**Date:** 2026-08-23 · **Status:** blocked on a security-design decision · **Outcome:** A-01

The tracker lists 1.4c-wire as `◻ next`: *"Wire the redirect/CORS guards to `resolveAllowedOrigins(env floor,
managed)` — the `isAllowedOrigin` call-site switch."* It is not a wiring task. At every current call site
there is no tenant to scope the managed origins by, and the two obvious ways to get one are both
self-defeating. This note records why, so the next person does not re-derive it, and offers the two designs
that do work.

It also explains a finding from the dead-repository-method audit: `authAllowedOriginsRepository`'s
`getScopeOrigins`, `addTenantOrigin` and `removeTenantOrigin` are built, itested (
`authAllowedOriginsIsolation.itest.ts`) and called by nothing. That is not neglect — there is nowhere correct
to call them from yet.

## What exists, and is good

- `resolveAllowedOrigins(envFloor, managed)` and `isOriginAllowed(origin, envFloor, managed)` —
  pure, exact-match, env floor first so managed config can only ever ADD (`packages/config/src/managedOrigins.ts`).
- `canonicalManagedOrigin(input)` — the write-path guard: https only, no credentials, no path/query/fragment,
  no wildcard host. Storage is canonical and resolution is exact-match, so a stored row cannot become an
  open-redirect target.
- `auth_allowed_origins` with platform-NULL and per-tenant rows, RLS-isolated, writes audited in-tx.

The pieces are sound. The gap is *where the decision is made*, not how it is computed.

## The blocker

**Three of the four call sites have no tenant at check time.** `magic/actions.ts`, `password/actions.ts` and
`reset/actions.ts` validate `app_origin` at the very start of the flow, where the user has supplied an email
address and nothing else. `password/actions.ts` and `reset/actions.ts` do not mention `tenantId` at all. The
origin must be validated *before* anything is issued — that check is what stops an attacker-supplied
`app_origin` from riding the cookie and becoming an open redirect that leaks the cross-domain code.

**The fourth is gated by a CORS preflight, which cannot be tenant-scoped even in principle.**
`extension/mint/route.ts` resolves `session.tenantId`, so a tenant *is* available at the POST — but every
request to it first passes `corsHeaders(origin)`, which calls the same env-only `isAllowedOrigin`, and the
`OPTIONS` preflight is answered by that function alone. A browser preflight carries no cookies, so there is no
session and no tenant to look anything up by. An extension origin a tenant registered as a managed row would
therefore be rejected at preflight regardless of what the POST handler does — the managed row can never take
effect unless the env floor already contains that origin, which makes it redundant.

**Why the two obvious fixes are worse than the gap.** Both amount to letting an untrusted input select which
tenant's allow-list to validate against:

- *Union every tenant's managed origins.* Tenant A's registered origin then satisfies a login for tenant B's
  user. The origin is where the authorisation code is returned, so this hands any tenant a redirect target for
  everyone else's users.
- *Resolve the tenant from a hint (subdomain, query param) before the check.* Identical outcome by a longer
  route: the attacker names the tenant they control, and that tenant's origins become valid for whoever
  actually authenticates.

The invariant being protected: **the set of origins a login may return to must be determined by who
authenticates, never by a parameter the caller supplies.**

## Two designs that hold the invariant

**(A) Post-authentication widening.** Keep the env floor as the sole pre-auth gate — unchanged, so no
behaviour change to any current flow. Consult managed origins only at the point where a tenant has been
established *by authentication*, i.e. when the code/token is about to be returned to the app origin. A managed
row then widens the allow-list only for users who actually belong to that tenant. Cost: the extension mint
path still cannot benefit, because its preflight precedes authentication — that surface stays env-only, which
should be stated rather than left to be rediscovered.

**(B) Platform-scoped only.** Drop the per-tenant dimension from the read path and honour only the
platform-NULL rows, which the table already carries and which are owner-managed via `withPlatformTx`. The env
floor becomes bootstrap; platform rows extend it operationally without a deploy. No tenant ambiguity exists,
so every call site including the CORS preflight can use it as-is. Cost: tenants cannot self-serve an origin —
which may be the correct product answer, since an origin is a security-relevant platform fact and the write
path is already restricted to a tenant's `security_admin` rather than any member.

**Recommendation: (B) first, (A) only if tenant self-service is a real requirement.** (B) is a small change
that makes the existing table useful immediately and cannot widen anything cross-tenant. (A) is strictly more
work and leaves the extension surface unimproved.

## What was deliberately NOT done

No call site was changed. Redirect and CORS gates are the highest-consequence code in the auth app, security
has final say on them per CLAUDE.md's precedence rule, and the tracker item's premise does not survive
contact with the call sites.

The write path (`addTenantOrigin` / `removeTenantOrigin`) was also left unwired. Building a management UI
before the read path is decided would ship a control that appears to register an origin and has no effect —
the same class of defect as a feature flag that gates nothing, which this codebase has been auditing out.
