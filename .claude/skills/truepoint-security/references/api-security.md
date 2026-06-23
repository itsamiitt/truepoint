# API Security

The API is the real security boundary — it is what an attacker actually talks to,
bypassing the UI entirely. This file covers hardening the API surface beyond
access control (`access-control.md`) and input validation (`input-and-injection.md`),
both of which also apply to every endpoint.

---

## Rate Limiting

Anything expensive, sensitive, or abusable is rate-limited. Without limits, an
attacker can brute-force, scrape, or run up cost.

Rate-limit at minimum:
- **Authentication** — login, password reset, token endpoints. Unlimited login
  attempts is a brute-force invitation. Limit by IP and by account.
- **Search** — an unlimited search endpoint is a data-scraping tool.
- **Enrichment** — these calls cost money per request to the provider. An
  unlimited enrichment endpoint lets a user (or an attacker with a stolen session)
  run up a large bill. Limit per user and per org.
- **Export and bulk operations** — a bulk export is a bulk data-exfiltration risk;
  rate-limit it and scope it to the requester's org.
- **Any write that fans out** — an action that creates many records or sends many
  notifications needs a limit so it can't be used as a flood.

Limits are enforced server-side. A limit the client respects but the server
doesn't is no limit.

> **Rate limiting is the app-layer defence; it is not the whole story.** Volumetric
> attacks, malicious request patterns, and systematic scraping of the dataset are
> handled at the **edge** — DDoS mitigation, a WAF, and bot/scraping defence — in
> addition to these limits. For a data product, scraping defence is existential and
> goes beyond per-request limits to pattern/anomaly detection and per-account volume
> caps. See `abuse-and-edge.md`. Rate-limit counters live in shared Redis so limits
> are global across instances (see **truepoint-platform** api-contract, caching). In
> this codebase that is `rate-limiter-flexible` on Redis (`packages/auth/src/rateLimit.ts`):
> per-IP 30/min and per-identifier 10/min on credential steps, plus a coarse 120/min
> per-caller cap on the resource API.

---

## Request Size Limits

Cap the size of request bodies, individual fields, and arrays. An unbounded
endpoint lets an attacker send a 100MB body or a million-element array to exhaust
memory or CPU.

- Set a global maximum body size at the server/gateway.
- Validate array lengths and string lengths in the input schema (see
  `input-and-injection.md`) — "a list can have at most N members added per
  request," "a note is at most N characters."
- Reject oversized requests early, before parsing or processing.

---

## Mass Assignment / Field Allowlisting

Covered in `access-control.md` because it is an escalation vector, and repeated
here because it is an API-shape discipline: never apply a request body wholesale
to a database write. Allowlist the exact fields a caller may set, and exclude
identity/ownership fields (`id`, `role`, `tenantId`, `workspaceId`, `ownerUserId`)
from anything a user can self-assign. A general update endpoint that trusts the body
lets a user set fields you never intended.

---

## Return Only Authorized Fields

The response is shaped to contain only what the caller may see — never the raw
database row (see `data-protection.md`).

- Map records to an explicit response type. Adding a field to a database model
  must not silently start exposing it through every endpoint that returns the row.
- Be careful with nested/related data: including a record's relations can leak
  fields from the related records that the caller shouldn't see.
- Different roles may warrant different response shapes — an admin endpoint may
  return fields a staff endpoint omits.

---

## CORS

Cross-Origin Resource Sharing controls which origins may call the API from a
browser. Misconfigured CORS (reflecting any origin, or `*` with credentials) lets
a malicious site make authenticated requests on a user's behalf.

- Allowlist the specific TruePoint origins — `app.truepoint.in` (the customer surface)
  and `auth.truepoint.in` / `api.truepoint.in`, plus their staging equivalents. The
  internal/platform-admin surface is `apps/admin` (its subdomain is TBD — add it to the
  allowlist when configured; don't assume a `staff.`/`admin.` host exists yet).
- Never reflect arbitrary origins. Never combine `Access-Control-Allow-Origin: *`
  with credentialed requests.
- Keep the allowlist in config (the `APP_ORIGINS` allow-list, `packages/config/src/env.ts`),
  not hardcoded, so environments differ correctly.

---

## Idempotency for Mutations

A mutation that isn't idempotent can double-execute on a retry or a double-click,
creating duplicate records (see the architecture duplicate-prevention guidance).
Beyond the data-integrity concern, this is a security/abuse concern: a
non-idempotent expensive operation can be triggered repeatedly.

- Critical writes (especially anything billable or that creates records) use an
  idempotency key so a repeat of the same request is recognised and not
  re-executed.
- Combine with a unique constraint at the database level so duplicates are
  rejected even if the application check is bypassed.

---

## Errors Don't Leak Internals

API error responses tell the client what it needs and nothing more.

- Never return a stack trace, a raw database error, or an internal file path to
  the client. These reveal the stack, the schema, and attack surface.
- Return a clear, generic message and a status code; log the detail server-side
  (without PII or secrets — see `data-protection.md`).
- A denied or missing resource returns an indistinguishable response so IDs can't
  be enumerated (see `access-control.md`).

---

## Checklist

- Are auth, search, enrichment, export, and fan-out writes rate-limited server-side?
- Are request body size, field length, and array length capped?
- Does every write allowlist fields rather than trusting the body?
- Does every response return only authorized fields, never the raw row?
- Is CORS restricted to the known TruePoint origins (the `APP_ORIGINS` allow-list),
  never reflecting arbitrary ones?
- Are billable/record-creating mutations idempotent, backed by a DB constraint?
- Do error responses avoid leaking stack traces, schema, or internal paths?
