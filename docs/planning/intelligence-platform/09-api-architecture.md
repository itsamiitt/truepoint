# Phase 9b — API architecture

The brief's scope item 10 was the one item with no artifact — docs ran 00–08 then jumped to 10. This closes
that gap. It is an **audit against the shipped API**, not a from-scratch design, for the same reason the whole
programme was reframed in iteration 1: this is not a greenfield, and designing an API that largely exists
would produce a document nobody could act on.

Evidence for every row below is a file that was opened, not a grep hit.

---

## 1. What the brief asks for, against what ships

| Item 10 asks for | State | Evidence |
|---|---|---|
| **Authentication** | ◐ **partial — see §2** | `middleware/authn.ts` + JWT access tokens; `middleware/extensionScope.ts` (AUTH-065) restricts extension-minted tokens to a route allow-list, deny-by-default, env-flippable to enforce. **No API keys.** |
| **Authorization** | ✅ shipped | `requireRole` · `requireOrgRole` · `requireStaffRole` · `requireCapability` · `requireEntitlement` · `platformAdmin` · `jobViewer`, with `roleGuards.test.ts` and `platformAdmin.test.ts` |
| **Tenant isolation** | ✅ shipped | `middleware/tenancy.ts` over the `withTenantTx` RLS seam; two-tier `tenant_id`/`workspace_id` |
| **Entity APIs** | ✅ for Layer 1 · ✗ for the new Layer-0 entities | 39 feature areas incl. `contacts-*`, `account-search`, `lists`, `tags`, `custom-fields`, `pipeline-stages` |
| **Search APIs** | ✅ shipped | `search`, `saved-searches`, `account-search` over the `SearchPort` seam |
| **Enrichment APIs** | ✅ shipped | `enrichment`, `reveal` (+ `revealRateLimit`) |
| **Contribution APIs** | ✅ shipped | `ingest`, `sales-navigator`, `master-sync` |
| **Data-quality APIs** | ✅ shipped | the `data-health` surfaces (metrics, trend, reverification, merge review) |
| **Change-history APIs** | ◐ partial | `activity`, `events`; field-grain history lives in `provenance_event`, which has **no HTTP surface** (correctly — it is REVOKE'd from `leadwolf_app`; any exposure must be an aggregate, per `provenanceBadgeRepository`) |
| **Integration APIs** | ✅ shipped | `crm-sync`, `scim` (SCIM 2.0), `email`, `webhooks` |
| **Webhooks / events** | ✅ shipped | `webhooks` feature (HMAC-signed outbound + SSRF guard), `events` |
| **Rate limiting** | ✅ shipped | `middleware/rateLimit.ts` (+ `rateLimit.test.ts`), `revealRateLimit.ts` |
| **Audit logs** | ✅ shipped | `compliance`, `admin`, `platform_audit_log` (append-only trigger, owner-written) |
| **Idempotency** | ✅ shipped | `middleware/idempotency.ts` — the `/api/v1` contract's Idempotency-Key |
| **Error contract** | ✅ shipped | `middleware/error.ts` renders every `AppError` as **RFC 9457** `application/problem+json`, wired as Hono's `onError`; non-AppErrors become a generic 500 that leaks neither internals nor PII |

**Verdict: item 10 is substantially shipped.** Eleven of fifteen rows are complete, and the API contract
(idempotency, RFC 9457, request IDs, rate limiting, tenancy) is exactly the shape `truepoint-platform`
mandates. Nothing here needs redesigning.

---

## 2. The one real gap: there are no API keys

**Verified absent:** no `api_keys` table exists anywhere in `packages/db/src/schema/`. Authentication is
user-session JWT plus extension-scoped tokens. There is **no programmatic / server-to-server credential.**

`cascade 1.md` §6 proposes exactly this and its design is sound — bearer keys where the secret is never
stored (hash + displayable prefix), `scopes TEXT[]`, a rate-limit tier, and status/expiry. One detail in it is
better than it first looks and worth preserving verbatim:

> `contacts:read` grants reading *already-unlocked* contact rows; `contacts:enrich` grants spending credits
> to unlock new ones — keeping a read-only integration key from silently burning budget.

That split is a **spend control**, not an access nicety. TruePoint's reveal path debits
`tenants.reveal_credit_balance` inside the reveal transaction; an integration key without that split can
drain a customer's balance through an automation loop with no human in it. The existing
`requireEntitlement` / `revealRateLimit` guards bound *who* and *how fast*, not *whether this credential may
spend at all*.

**Why this is not proposed as work here.** An API-key system is an authentication surface — it needs
`truepoint-security` (secret storage, rotation, revocation, leak response), `truepoint-platform` (the
contract, rate-limit tiering, metering), a decision on whether TruePoint wants a public API at all, and a
pricing position. That is a product decision with a security surface, not a gap to quietly fill mid-programme.
**Recorded as conflict C11.**

---

## 3. The other gap, and it is the familiar one

No routes exist for the Layer-0 intelligence entities this programme added — technology, signals, company
locations/funding/contact-points, person identifiers.

That is **correct for now**, and for the reason Phase 8 already established: those tables hold no rows and
have no populator. An endpoint returning an empty array is worse than a 404 — it asserts the entity exists and
has nothing, which is a claim about the data rather than about the build.

When they are populated, the read shapes are already specified in `03-target-architecture.md` §5, and the
access rules are already settled by work this programme did:

- Layer-0 reads go out through the **owner/`withErTx` seam**, never `leadwolf_app` — the tables are REVOKE'd,
  by design, and migration 0102 extends that to every partition.
- Anything derived from `provenance_event` leaves the database **aggregated** (`badgeFor` counts
  `contributor_ref` inside the SQL and never returns it) — C-02.
- Contact points carry a required `SuppressionVerdict` at the repository boundary, so no egress can skip the
  suppression check by forgetting it.

---

## 4. What this phase does not claim

- No endpoint was written, and none should be until the tables have a populator.
- The audit above is a **static read** of the route tree, middleware directory and error handler. It says
  what exists; it does not say the endpoints behave correctly — that is what the API's own test suite and CI
  are for, and CI has not run this branch.
- `api_keys` is recorded as absent on the strength of a case-insensitive schema-wide search returning
  nothing. That is the same method that produced a false negative in iteration 23, so it was confirmed by
  listing `packages/db/src/schema/` rather than by the search alone.
