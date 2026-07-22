# API Contract

The backend exposes one HTTP API, consumed by the customer web app, the internal
apps, the Chrome extension, and external integrations. Because so many clients
depend on it, the contract is fixed and disciplined — an ad-hoc API at this scale
becomes impossible to evolve without breaking someone.

The cross-tier API contract is defined by **shared Zod schemas in `@leadwolf/types`**,
imported by both the API (`apps/api`) and the web/worker clients. This file defines
the rules those schemas follow.

---

## One Source of Truth: Shared Zod Schemas

- Request/response shapes and error types are described by **Zod schemas in
  `@leadwolf/types`**, the **single source of truth** for the contract. There is no
  OpenAPI-generated client.
- Both sides depend on the same schemas: `apps/api` validates against them at the
  boundary, and the web/worker clients derive their request/response types from
  them — so the types can never drift between server and client. The Chrome
  extension and external SDKs build against the same `@leadwolf/types` contract.
- A change to the API is a change to the shared schema first, then the
  implementation — never an undocumented endpoint or an undocumented field.

---

## Versioning

- The API is versioned in the path: `/api/v1/...`. Breaking changes ship as
  `/api/v2`, never as a silent change to `/api/v1`.
- **Additive changes are not breaking**: adding an optional field or a new
  endpoint stays in the current version. Removing a field, renaming one, changing
  a type, or tightening validation is breaking and needs a new version (this
  mirrors the database additive-first discipline).
- Old versions have a documented deprecation window before removal, tracked like
  any `REMOVE AFTER` (see architecture removal-cleanup). External consumers get
  notice; the Chrome extension's minimum supported version is known.

---

## Pagination: Cursor, Always

Offset pagination (`?page=5`) breaks at scale — deep offsets force the database to
scan and discard, and results shift when rows are inserted. **Every list endpoint
uses cursor pagination.**

```
GET /api/v1/prospects?limit=50&cursor=eyJpZCI6...

200 {
  "members": [ ... ],            // the collection field is named per domain (members, jobs, …)
  "nextCursor": "eyJpZCI6..."    // string | null — null means last page
}
```

The response is **flat** — no `page` wrapper and no `hasMore` field; clients derive
"has more" from `nextCursor !== null` (see `packages/types/src/lists.ts` for the
canonical shape).

- The cursor is opaque (an encoded stable sort key, e.g. `(created_at, id)`).
  Clients pass it back verbatim; they never construct it.
- `limit` has a **hard maximum** (e.g. 100) enforced server-side — a client asking
  for 100k rows gets the max, not 100k.
- The frontend's infinite-scroll and `Pagination` component consume `nextCursor`
  (deriving has-more from non-null — see design large-data).
- No endpoint returns an unbounded collection. "Get all" is paginated like
  everything else; bulk extraction goes through export jobs (see `async-jobs.md`).

---

## Idempotency for Writes

Networks retry and users double-click. A non-idempotent write creates duplicates
(see the architecture duplicate-prevention guidance) — and for billable/enrichment
writes, duplicate cost.

- Mutating endpoints that create resources or incur cost accept an
  **`Idempotency-Key` header**. The server records the key and the result; a
  repeat of the same key returns the original result instead of re-executing.
- Idempotency keys are scoped per tenant and expire after a defined window.
- This pairs with a database unique constraint as defence-in-depth — if the
  application check is bypassed, the constraint rejects the duplicate (see
  `truepoint-data` data-model and `truepoint-security` api-security).

---

## One Error Envelope: RFC 9457 problem+json

Every error response uses the same shape — **RFC 9457 `application/problem+json`** —
so every client can handle errors uniformly (and the frontend's typed `ApiError`
maps onto it — see architecture state-and-data).

```json
{
  "type": "https://api.truepoint.in/problems/prospect-not-found",
  "title": "Prospect not found.",
  "status": 404,
  "code": "prospect_not_found"
}
```

- A stable machine-readable `code` (clients branch on this, never on the `title`
  text).
- A human-readable `title` safe to surface — **never** a stack trace, a raw
  database error, an internal path, or anything that leaks schema or PII (see
  `truepoint-security` api-security and data-protection).
- > **Implementation status:** a `requestId` correlation field is the **target** —
  > the shipped `ProblemDetails` (`packages/types/src/errors.ts`) is
  > `{ type, title, status, code, detail?, …ext }` and no request-id middleware
  > exists yet. Add the field and the middleware together when built; until then
  > don't promise users a request id.
- HTTP status used correctly: `400` validation, `401` unauthenticated, `403`
  forbidden, `404` not found / not yours (indistinguishable — see security
  access-control), `409` conflict, `422` semantic validation, `429` rate-limited,
  `5xx` server. A denied-vs-missing resource returns the same thing so IDs can't
  be enumerated.

---

## Input Validation at the Boundary

Every endpoint validates its input against its shared Zod schema (`@leadwolf/types`)
before any logic runs — type, format, length, range, enum membership. This is both
a correctness and a security boundary (see `truepoint-security`
input-and-injection). The shared schema gives clients typed inputs from the same
source of truth; the server still re-validates everything, because the client is
untrusted.

---

## Rate Limiting Is Part of the Contract

Endpoints declare their limits; clients are expected to honour `429` +
`Retry-After`. Limits are enforced server-side regardless (see
`truepoint-security` api-security and abuse-and-edge):

- Auth, search, enrichment, export, and fan-out writes are limited per user and
  per tenant.
- External API consumers have tiered limits by plan.
- Limit counters live in Redis (see `caching.md`), shared across backend
  instances so the limit is global, not per-instance.

---

## Response Shaping

The response contains only fields the caller may see — mapped from an explicit
response type, never the raw database row (see `truepoint-security`
data-protection). Adding a column to a table must not silently start exposing it.
Different roles/surfaces may get different shapes (an admin endpoint returns fields
a staff endpoint omits).

---

## Auth on Every Route

Every non-public route requires a valid session/token, verified before the handler
runs, and resolves the tenant context (see `tenancy.md`). Public routes (health,
auth callbacks, signed webhooks) are explicitly enumerated; everything else is
authenticated by default. Webhooks verify signatures (see `truepoint-security`
integrations).

---

## Checklist

- Is the change reflected in the shared Zod schema in `@leadwolf/types`, with both
  `apps/api` and the clients deriving from it?
- Is it additive (same version) or breaking (new version + deprecation)?
- Is every list endpoint cursor-paginated with a hard `limit` max?
- Do create/billable writes accept an `Idempotency-Key`, backed by a DB constraint?
- Does every error use the one RFC 9457 `problem+json` envelope, leaking no
  internals?
- Is input schema-validated and the response shaped to authorized fields only?
- Are rate limits declared and enforced server-side via shared counters?
