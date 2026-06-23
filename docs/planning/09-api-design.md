# 09 — API Design

> The `api` service (**Hono on Bun**, ECS Fargate — [ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md))
> is the only public HTTP surface. It serves **two contracts from one service layer**: **tRPC** for the
> internal Next.js app (end-to-end types) and **REST/OpenAPI** (`@hono/zod-openapi`) for the public API.
> Everything is **workspace-scoped**, versioned, and **idempotent where it spends money** (the reveal
> path, [07 §3](./07-billing-credits.md)).

## 1. Conventions

| Aspect | Choice |
|---|---|
| Style | **tRPC** (internal app) + **REST/OpenAPI** (`@hono/zod-openapi`, public); resource-oriented JSON |
| Base path (REST) | `/api/v1` (versioned from day one); tRPC mounted at `/trpc` |
| Auth (dashboard) | **Access JWT** (15 min, in-memory) minted by the `auth.truepoint.in` IdP, validated by `apps/api` via JWKS; the durable Lucia session + rotating refresh cookie stay on the auth origin ([ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md), [17](./17-authentication.md)) |
| Auth (machine/public) | `Authorization: Bearer <api_key>` (hashed, prefixed, scoped) |
| Tenancy | `tenant_id` + `workspace_id` derived from auth context (**never** from the client body) |
| Workspace scope | active workspace via session/`X-Workspace-Id` (dashboard) or key→workspace (public); sets `app.current_tenant_id` + `app.current_workspace_id` ([03 §9](./03-database-design.md#9-row-level-security)) |
| IDs | UUID v7 strings |
| Validation | **Zod** schemas (`packages/types`) → Hono middleware; `422` on invalid |
| Errors | RFC 9457 Problem Details (`type`, `title`, `status`, `detail`, `code`) |
| Pagination | Cursor-based (`?cursor=&limit=`) for large sets; `next_cursor` in response |
| Idempotency | `Idempotency-Key` header required on reveal/checkout |
| Rate limiting | Per session + per API key (Redis token bucket); `429` + `Retry-After` |
| Time | ISO-8601 UTC |
| Correlation | `X-Request-Id` echoed; correlation id in logs/traces (X-Ray) |

The middleware chain is uniform for both contracts: **authn → resolve tenant+workspace → `SET LOCAL`
GUCs (RLS) → RBAC → entitlement/quota → handler → audit**. RLS under a non-`BYPASSRLS` role is the
last-line guarantee that a handler can't read across workspaces ([03 §9](./03-database-design.md#9-row-level-security)).

## 2. Resource model

```
# ── Identity provider on auth.truepoint.in (apps/auth, 17) — NOT /api/v1; mints the app's access JWT ──
/login                          POST: email|username → exists? → routed step OR /signup (Turnstile+rate-limit, ADR-0020)
/auth/signup                    POST: register → verify email → place by domain/invite/new-org (ADR-0019/0020)
/auth/org                       POST: select active org (tenant_member) when the identity is in >1 org
/invitations/accept             POST: accept a pending invite → tenant_member + workspace_member
/auth/password                  POST: password login → session on the auth origin
/auth/logout                    POST: revoke session + refresh family
/auth/mfa/enroll                POST: begin TOTP/SMS/email/WebAuthn enrollment (user_mfa_methods)
/auth/mfa/verify                POST: verify factor / consume recovery code; "trust device 30d"
/auth/magic                     POST: send magic link / email OTP (auth_email_tokens)
/verify                         GET:  validate magic-link / OTP token (expired/used states)
/auth/oauth/:provider           GET:  begin social OAuth (Google/Microsoft via arctic)
/oauth/callback                 GET:  social OAuth callback → session
/auth/password/forgot|reset     POST: issue / consume password-reset token
/sso/saml/callback              POST: SAML ACS (node-saml) → JIT provisioning
/sso/oidc/callback              GET:  OIDC redirect_uri → code exchange → JIT
/token/exchange                 POST: single-use 60s code (+PKCE) → access JWT (15m)  [ADR-0016]
/token/refresh                  POST: rotate refresh cookie → new access JWT (silent refresh)
/.well-known/jwks.json          GET:  public signing keys (apps/api validates JWTs against this)
/scim/v2/*                      SCIM 2.0 user lifecycle (scim_tokens bearer; Enterprise)
# app domain (apps/web): GET /auth/callback receives the code, exchanges it, holds the JWT in memory

/tenants/me                     GET:  current tenant (plan, seat_limit, workspace_limit, balance)
/tenants/me/api-keys            create/list/revoke scoped keys (tenant-scoped)
/tenants/me/entitlements        GET:  plan + feature flags
/tenants/me/sso                 GET/PUT: tenant SAML/OIDC config (tenant owner only)

/workspaces                     CRUD workspaces (within workspace_limit)
/workspaces/:id/members         list/invite/update-role/remove (workspace RBAC)
/workspaces/:id/switch          POST: set active workspace for the session

/home/summary                   GET:  Home cockpit widgets (tasks, replies, hot leads, burn) (11 §4.1)

/search/contacts                POST: faceted search (masked results)
/search/accounts                POST: faceted search

/contacts/:id                   GET:  masked contact detail (+ per-import provenance summary)
/contacts/:id/reveal            POST: reveal contact (spends tenant credits; idempotent)
/contacts/:id/activities        GET/POST: timeline (sends/opens/clicks/replies/calls/notes)
/contacts/:id/scores            GET:  versioned score history (icp_fit/intent/engagement/composite)
/accounts/:id                   GET:  account detail

/intent-signals                 GET/POST: weighted intent signals (filter by contact/type)

/outreach/sequences             CRUD sequences (+ steps as nested resource)
/outreach/enrollments           POST: enroll contact(s); GET: enrollment + send status
/outreach/enrollments/:id       GET:  one enrollment (status, sent/replied timestamps)
/outreach/drafts                POST: AI-draft a step; PATCH: review/edit (draft→review→send)
/templates                      CRUD message templates (snippets, merge fields, AI draft) (11 §4.3)

/sales-nav-links                CRUD Sales Navigator links (link_type-scoped)

/inbox                          GET:  unified replies (email + LinkedIn); PATCH: assign/snooze/done (11 §4.4)
/tasks                          CRUD tasks/reminders (manual + system-generated) (11 §4.4)

/source-imports                 POST: start an import (CSV/CRM/provider); GET status/history
/source-imports/uploads         POST: request presigned PUT (tenant/workspace/uploadId, short TTL); for >5 GiB multipart: part URLs + complete
/source-imports/uploads/:id     POST: finalize a staged upload (Idempotency-Key) → creates a bulk job (30 §3, ADR-0036)
/imports                        alias of /source-imports (11 §6 wiring map)

/jobs/:id                       GET:  bulk-job state machine + counts + progress (import/export/reveal — 30 §2, ADR-0036)
/jobs/:id/cancel                POST: request cancel (terminal-safe; idempotent)
/jobs/:id/results               GET:  paginated/streamed per-row results, ?outcome=succeeded|failed|unprocessed

/lists                          CRUD lists
/lists/:id/members              add/remove members; list members
/saved-searches                 CRUD saved searches

/reports/*                      GET:  analytics dashboards (pipeline, credit usage, deliverability, data-health) (11 §4.5)
/notifications                  GET:  notifications center feed; PATCH: mark read (11 §5)

/settings/user/*                GET/PUT: profile, security, notification prefs, sending identity (12 §2)
/settings/workspace/*           GET/PUT: members, ICP/scoring, sending+deliverability, import defaults (12 §3)
/settings/tenant/*              GET/PUT: organization, billing, members directory, security, compliance (12 §4)
/webhooks                       CRUD outbound webhook subscriptions; delivery log (developer settings, 12 §5)
/integrations                   CRUD/connect CRM, Slack/Teams, BYO provider keys (workspace, 12 §3)

/credits/balance                GET:  current tenant balance
/credits/usage                  GET:  usage history (reveals by reveal_type, dates, cost)
/credits/checkout               POST: create Stripe checkout for a credit pack
/billing/webhook                POST: Stripe webhook (no auth; signature-verified)
  # credits/billing have no nav tab — surfaced in Settings ▸ Billing & Credits + a top-bar pill (11, 12 §4)

/exports                        POST: create export (CSV) by ids or filter-blob → bulk job; GET status; manifest of signed URLs (30 §4, ADR-0036)
/exports/:id/manifest           GET:  current presigned-URL manifest (regenerated via the job's status)

/compliance/suppression         CRUD suppression entries (scope global|tenant|workspace)
/compliance/dsar                POST intake; GET status   (+ public intake variant)

/enrichment/:entity/:id         POST: trigger on-demand enrichment (async; returns job ref)

/enrichment/bulk                POST: create a bulk CSV enrichment job (multipart CSV | S3 upload ref) → 202 job ref (M17, 30 §4)
/enrichment/bulk/estimate       POST: sample-based match-rate + credit forecast (no charge, no job)
/enrichment/bulk/:jobId         GET:  job status + progress + live match-rate (poll; SSE on the M12 backbone)
/enrichment/bulk/:jobId/download GET: signed S3 URL(s) — enriched CSV + unmatched report
/enrichment/bulk/:jobId/confirm POST: confirm after estimate (awaiting_confirmation → running)
/enrichment/bulk/:jobId/cancel  POST: cancel a queued/running job
```

Resource names follow the corpus-wide rename ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md)):
**`organizations`→`tenants`, `persons`→`contacts`, `companies`→`accounts`**. A `contacts`/`accounts` id is a
**workspace overlay** over a Layer-0 **master entity** ([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)):
`/search/*` queries the **global master graph** (masked), and a **reveal** materializes/links an overlay copy
in the active workspace. The overlay id is workspace-scoped; the underlying `master_person_id` /
`master_company_id` is global but is never the API's addressing key.

### 2.1 Internal staff API (`/admin/*`) — separate service

The super-admin console ([13](./13-platform-admin.md)) is served by a **separate internal API**
(`apps/admin`), **not** reachable from the customer app. It has its **own staff auth + staff RBAC**
(`super_admin`/`support`/`billing_ops`/`compliance_officer`/`read_only`), **JIT elevation** for
sensitive actions, and runs under the **privileged cross-tenant DB role** (distinct from the app's
non-`BYPASSRLS` role); **every handler is audited to `platform_audit_log`** ([ADR-0011](./decisions/ADR-0011-platform-admin-and-privileged-access.md)).

```
/admin/tenants                  GET/PATCH: directory + plan/limit/status (suspend/reactivate/churn)
/admin/tenants/:id/credits      POST: manual credit grant/adjustment (JIT + audited)
/admin/users                    GET/PATCH: cross-tenant search; deactivate; reset MFA; revoke sessions
/admin/impersonate              POST: start time-boxed, banner-flagged, reason-logged login-as; DELETE: end
/admin/billing/*                refunds/adjustments, dunning, MRR/ARR
/admin/feature-flags            CRUD global + per-tenant overrides
/admin/providers                CRUD enrichment-provider configs, rate-limits, cost budgets
/admin/abuse                    GET: fraud/deliverability dashboards; POST: blocklists/holds
/admin/compliance/dsar          GET: cross-tenant DSAR oversight; POST: trigger fan-out delete
/admin/data-quality             GET: DQ scorecards; POST: bulk re-verify/re-enrich (AWS Batch)
/admin/system                   GET: service/queue/CDC/backup health; PUT: maintenance mode/banners
/admin/audit                    GET: platform_audit_log (immutable, exportable)
```

## 3. Key endpoints (sketch)

### 3.1 Search (masked)
```http
POST /api/v1/search/contacts
{
  "filters": {
    "title": ["VP Engineering","Head of Engineering"],
    "seniority": ["vp","c_suite"],
    "employeeCount": ["51-200"],
    "locationCountry": ["US","DE"],
    "hasEmail": true
  },
  "cursor": null,
  "limit": 50
}
=> 200
{
  "results": [
    { "id":"...", "fullName":"Jane Doe", "title":"VP Engineering",
      "account": { "id":"...", "name":"Acme", "domain":"acme.com" },
      "emailStatus":"valid", "emailMasked":"j••••@acme.com",
      "phonePresent": true, "priorityScore": 82, "revealed": false }
  ],
  "facets": {
    "seniority": { "vp": 540, "c_suite": 210 },
    "employeeBand": { "51-200": 612, "201-500": 668 },
    "locationCountry": { "US": 980, "DE": 300 }
  },
  "next_cursor": "...",
  "total_estimate": 1280
}
```
No PII (real email/phone) is returned here — only **masked previews + status + facet counts**. Search runs
over the **global master graph** (the billions-row shared universe — [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md))
on **OpenSearch** behind `SearchPort` ([ADR-0002](./decisions/ADR-0002-search-postgres-then-engine.md) amended),
fed by Aurora CDC; the index carries **non-PII facets only** (`email_domain`, `email_status`,
`seniority_level`, `employee_band`, `industry`, `location_country`, `has_email`, `priority_score`, …), never
decrypted PII. Filters **post as a body** (not query-string); **pagination is `search_after` cursoring**
(never deep offset) so it holds at billions; **facet counts** come from `terms`/`range` aggregations
(ClickHouse backs the heavy high-cardinality counts). Per-key **rate limits + quotas** apply
([§5](#5-idempotency--concurrency), [§8](#8-public-api-readiness-post-mvp-seams-now)). The universe is shared;
what a workspace *owns* (revealed/overlay state) is RLS-scoped — search flags which hits are already revealed
in the active workspace.

### 3.2 Reveal (spends tenant credits, idempotent) — H1
```http
POST /api/v1/contacts/{id}/reveal
Idempotency-Key: 7f3c... (client-generated)
{ "reveal_type": "email" }              // email | phone | full_profile
=> 200
{
  "contactId":"...",
  "reveal_type":"email",
  "email":"jane.doe@acme.com",
  "emailStatus":"valid",
  "creditsCharged": 1,
  "balanceAfter": 124,
  "alreadyOwned": false
}
=> 402  (Problem Details, code="insufficient_credits")  when tenant balance < cost
=> 403  (code="suppressed")                              when contact is suppressed
```

This is the single monetized path, described **identically** in [07 §3](./07-billing-credits.md) and
[08 §3](./08-compliance.md) (drift hazard **H1**). The handler opens **one transaction**:

```sql
BEGIN; assertNotSuppressed(contact, workspace)  -- in-tx, unbypassable (08 §3)
  INSERT INTO contact_reveals (...) ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING;
  -- if already present -> return owned fields, charge 0 (alreadyOwned=true)
  -- else -> SELECT reveal_credit_balance FROM tenants WHERE id = $tenant FOR UPDATE;
  --         IF < cost THEN ROLLBACK (INSUFFICIENT_CREDITS)
  --         ELSE UPDATE tenants SET reveal_credit_balance = balance - cost;
COMMIT; -- audit_log(action='reveal')
```

In words: `BEGIN`; `assertNotSuppressed(contact, workspace)` [in-tx, unbypassable]; `INSERT
contact_reveals ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING`; if already present →
**return owned fields, charge 0** (`alreadyOwned: true`); else → `SELECT reveal_credit_balance FROM
tenants WHERE id=tenant FOR UPDATE`; if `< cost` `ROLLBACK` (`INSUFFICIENT_CREDITS`); else `UPDATE
tenants SET reveal_credit_balance = balance - cost`; `COMMIT`; audit. The first `contact_reveals` row
for the `(workspace_id, contact_id)` flips ownership (`is_revealed`, `revealed_by_user_id`,
`revealed_at`) via the idempotent trigger ([03 §10](./03-database-design.md#10-triggers--db-side-logic)).

- **Sourced from the master channel:** the unlocked email/phone is read from the Layer-0
  `master_emails`/`master_phones` for the hit's `master_person_id` and **copied into the workspace overlay**
  ([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)); verification still drives the charge
  (below).
- **First-reveal-wins, per workspace:** re-revealing the **same workspace copy** is **0** credits
  (`alreadyOwned: true`); the **same human in another workspace** is charged again (each workspace owns
  its own copy — [ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)).
- **Cost** varies by `reveal_type`; the per-type number is a **placeholder** — see
  [07 §1](./07-billing-credits.md) (never hardcoded here).
- **Known risks (per [ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)):** the
  tenant counter lacks a ledger's reconciliation/refund history; the `FOR UPDATE` + `CHECK >= 0` + the
  unique `contact_reveals (workspace_id, contact_id, reveal_type)` + the client `Idempotency-Key` are
  the **required mitigations**. The server replays the stored response for a seen key so network retries
  don't double-charge before the DB constraint applies.
- `emailStatus` is the field-correctness signal (`unverified/valid/risky/invalid/catch_all/unknown`) —
  **distinct** from the lead/`priorityScore` (prospect quality); never conflate them.
- **Charge by verified result** ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)):
  `creditsCharged` is **0** when the verified `emailStatus` is `invalid`/`catch_all`/`unknown` (or no data was
  found) — the reveal still returns so the caller sees the outcome; `risky` is charged-but-flagged. A charged
  `valid` email that hard-bounces within the guarantee window is **credited back** (audit `credit.adjust`,
  [08 §5](./08-compliance.md)).

### 3.3 Outreach (enroll + send status)
```http
POST /api/v1/outreach/enrollments
{ "sequenceId":"...", "contactIds":["..."] }
=> 202 { "enrolled":[{ "id":"...", "contactId":"...", "status":"enrolled" }] }
```
Enrollment runs the **same `assertNotSuppressed` gate as reveal**; and the gate fires **again inside the
send transaction at dispatch time** (mirroring the reveal-tx in §3.2) — so a contact suppressed after
enrollment is still never sent to. Suppression/DNC gates **sending** as well as revealing
([08 §3](./08-compliance.md), [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md)); EU
sends additionally require a consent check. Send status (`enrolled|active|replied|completed|
unsubscribed|bounced`) and the `outreach_status` on the contact (`new/in_sequence/replied/
meeting_booked/disqualified/nurture/unsubscribed`) are read via `GET /outreach/enrollments`. LinkedIn /
Sales-Nav automated send defaults to **human-in-the-loop** (ToS risk).

### 3.4 Credit checkout + webhook
```http
POST /api/v1/credits/checkout { "pack":"pack_500" }  => { "checkoutUrl":"https://checkout.stripe.com/..." }
POST /api/v1/billing/webhook  (Stripe signature-verified; idempotent by stripe_event_id) => 200
```
Credits are **granted only by the webhook**, incrementing the tenant counter `tenants.reveal_credit_balance`;
`purchases.stripe_event_id` is **unique** → duplicate webhooks grant exactly once
([07 §4](./07-billing-credits.md)).

### 3.5 Bulk async jobs — the uniform contract (import / export / bulk-reveal)

Anything that touches **millions of rows** is a **first-class async job**, never a synchronous request
(a million-row load times out long before it finishes). The mechanics — server-owned chunking, streaming
parse, `COPY`→staging→`ON CONFLICT`, checkpoint/resume, revert-by-batch — live in
[30 §2–§5](./30-bulk-import-export-pipeline.md) and [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md);
**03 owns the job tables** (`import_jobs`/`export_jobs`, sharing the `bulk_job_status` enum + cheap status counters —
[03 §15.2](./03-database-design.md)). Bulk **reveal** jobs reuse the same job-ledger pattern ([03 §15.2](./03-database-design.md)) with the credit reservation of [07 §3A](./07-billing-credits.md) / [ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md).
This section pins only the **REST contract** the three job kinds (`import` / `export` / `bulk_reveal`)
share. The Salesforce Bulk API 2.0 lifecycle (create → upload → close → process → poll → fetch) is the
reference shape.

**(a) Create** — by **enumerated ids** *or* a **serialized filter-blob** (never both), plus a
**job-level** `Idempotency-Key` (one key per batch/enqueue — **not** per item, unlike the per-item reveal
key in [§5](#5-idempotency--concurrency)):

```http
POST /api/v1/exports
Idempotency-Key: 9b2e... (one per enqueue)
{
  "entity":"contacts",                                                     // what to export; the job kind is "export"
  "selection": { "filterBlob":"<opaque, server-signed §3.8 handoff>" },   // OR { "ids":["...","..."] }
  "columns":["fullName","email","title","account.name"],
  "format":"csv"
}
=> 202
{ "jobId":"...", "status":"queued", "kind":"export", "selectionCount":812043 }
```

The same envelope drives `POST /source-imports/uploads/:id` (finalize → `import` job) and a
`POST /contacts/bulk-reveal` (→ `bulk_reveal` job). **Re-POSTing the same `Idempotency-Key` returns the
existing `jobId`** rather than enqueuing a second job ([§5](#5-idempotency--concurrency)) — so a retried
enqueue collapses to one job.

**(b) Poll** — `GET /jobs/{id}` exposes the **state machine + cheap counts + progress** (status fields are
read on a poll loop, so they must be cheap — [30 §2](./30-bulk-import-export-pipeline.md)):

```http
GET /api/v1/jobs/{id}
=> 200
{
  "id":"...", "kind":"import", "status":"running",
  "state":"running",            // queued → [pending_approval] → validating → running → completed | failed | canceled | partial
  "progress": { "pct": 61, "rowsTotal": 1000000, "rowsProcessed": 610000 },
  "counts":   { "succeeded": 588120, "failed": 21880, "unprocessed": 390000 },
  "batchIdempotencyKey":"9b2e...",
  "createdAt":"...", "startedAt":"...", "finishedAt":null,
  "results": { "succeeded":"/jobs/.../results?outcome=succeeded", "failed":"...", "unprocessed":"..." },
  "manifest": null              // export-only; populated on completion (§3.7)
}
```

`unprocessed` is **first-class**: rows uploaded but never attempted (job hit a cap or failed mid-run) are
distinct from `failed` and must be resubmittable — fetching only succeeded+failed and assuming the rest
landed is the classic bulk bug.

**(c) Results — split by outcome, correlate by row not position.** Three paginated/streamed endpoints
each **echo the input row + the assigned id**, so callers reconcile by content, never by ordinal (parallel
chunking reorders rows):

```http
GET /api/v1/jobs/{id}/results?outcome=failed&cursor=&limit=1000
=> 200
{
  "results":[
    { "rowKey":"csv:000241", "input": { "email":"j.doe@acme.com", "title":"VP Eng" },
      "error": { "code":"duplicate_in_workspace", "detail":"matches contact ..." } }
  ],
  "next_cursor":"..."
}
# outcome=succeeded rows add the assigned overlay id + created-vs-matched:
#   { "rowKey":"csv:000007", "input":{...}, "id":"<contactId>", "outcome":"created" }
```

Results are also downloadable as a **rejected-rows artifact** (a presigned CSV per outcome, **short TTL +
workspace access control** — [30 §5](./30-bulk-import-export-pipeline.md)) for resubmission; callers must
persist what they need before the TTL lapses (the artifact is not retained indefinitely).

**(d) Cancel** — `POST /jobs/{id}/cancel` requests cancellation; it is **terminal-safe** (a no-op once the
job is `completed`/`failed`) and **idempotent**. In-flight batches finish or roll back per the staging
revert-by-batch rule ([30 §4](./30-bulk-import-export-pipeline.md)); already-committed rows are surfaced in
`succeeded` so a cancel never silently loses accounting.

**(e) Governors** ([§5](#5-idempotency--concurrency)) — a **per-tenant in-flight bulk-concurrency cap**
(queued/running jobs over the cap get `429` + `Retry-After`, they are not dropped) and a **dedicated bulk
queue-class rate limit** separate from the interactive per-key bucket, so a million-row export can never
starve dashboard traffic.

### 3.6 Bulk import upload — presigned / multipart

CSV bytes never stream through the API. The client requests a **presigned S3 PUT keyed to
`tenant/workspace/uploadId` with a short TTL**, uploads directly to S3, then **finalizes** to create the
job ([30 §3](./30-bulk-import-export-pipeline.md), [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)):

```http
POST /api/v1/source-imports/uploads
{ "filename":"contacts.csv", "bytes": 9100000000 }      // > 5 GiB ⇒ multipart
=> 200
{ "uploadId":"...", "method":"multipart", "expiresIn":900,
  "parts":[ { "partNumber":1, "url":"https://s3...&X-Amz-Expires=900" }, ... ],
  "complete":"/source-imports/uploads/{uploadId}:complete" }
# single PUT caps at 5 GiB; larger files use multipart part URLs + a complete call.

POST /api/v1/source-imports/uploads/{uploadId}      // finalize
Idempotency-Key: 4a7c...
{ "mapping": { "templateId":"..." }, "mergePolicy":"skip_existing" }   // mapping templates: 30 §3
=> 202 { "jobId":"...", "status":"queued", "kind":"import" }
```

Finalize carries the **`Idempotency-Key`** (re-finalizing the same `uploadId`+key returns the same job),
the **mapping template** (saved column→field maps), and the **explicit merge policy**
(`skip_existing | overwrite | merge` — default is safe, [30 §4](./30-bulk-import-export-pipeline.md)). Dedup
runs **before** any reveal/enrich spend ([§5](#5-idempotency--concurrency), [30 §4](./30-bulk-import-export-pipeline.md)).

### 3.7 Bulk export — results contract

An export is **never synchronous**: the worker streams keyset-cursored rows to S3 and the job completes
with a **manifest of presigned URLs** (a multi-file CSV set, or a single zip for smaller results), each
with an **expiry**:

```http
GET /api/v1/jobs/{id}            // export job, completed
=> 200
{ "id":"...", "kind":"export", "state":"completed",
  "manifest": {
    "format":"csv", "rowCount":812043, "expiresAt":"2026-06-17T12:00:00Z",
    "files":[ { "url":"https://s3...&X-Amz-Expires=3600", "rows":500000 },
              { "url":"https://s3...&X-Amz-Expires=3600", "rows":312043 } ]
  } }
```

- **Regenerate via status:** an expired manifest is **not** an error — re-`GET /jobs/{id}` (or
  `GET /exports/{id}/manifest`) mints fresh presigned URLs against the already-written S3 objects; the
  export is not recomputed.
- **Row caps:** a selection above the export ceiling fails fast with Problem Details
  (`code="export_row_cap_exceeded"`, echoing `requested` / `max`) — the caller narrows the filter or
  splits the job; we never silently truncate.

```json
{ "type":"https://leadwolf.dev/errors/export_row_cap_exceeded",
  "title":"Export exceeds row cap", "status":422,
  "code":"export_row_cap_exceeded", "requested":4200000, "max":2000000 }
```

### 3.8 Select-all-matching-filter handoff + bulk-reveal governance

A user who "selects all 800k matching rows" must **not** ship 800k ids in a request body. `/search/*`
returns a **server-signed, opaque `filterBlob`** (the exact query + facet state) that bulk endpoints accept
in place of an id list (§3.5a); the server re-resolves it at job time against the master graph
([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md), [ADR-0035](./decisions/ADR-0035-search-query-and-filter-architecture.md)).
A **selection cap** bounds how large a single filter-handoff job may be (same `export_row_cap_exceeded`
shape, applied to the resolved count).

**Bulk reveal spends money, so it is the most governed job kind:**

- **Credit reservation up front.** A `bulk_reveal` job **reserves** the worst-case credits at enqueue and
  settles per verified result on completion — **07/[ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md)
  own credit reservation/lease semantics**; this doc only enqueues against them. Charge-by-verified-result
  ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)) and per-workspace
  first-reveal-wins ([§3.2](#32-reveal-spends-tenant-credits-idempotent--h1)) are unchanged per row.
- **Per-user / per-team daily caps + threshold approval.** Daily bulk-reveal volume is capped per user and
  per team; a job above the approval threshold enters `pending_approval` (a workspace `admin`+ / tenant
  `billing_admin` approves — RBAC axes per [§4](#4-auth--authorization)) before it leaves `queued`. Over a
  cap returns Problem Details (`code="bulk_reveal_cap_exceeded"`).
- **Idempotency-on-enqueue.** The job-level `Idempotency-Key` (§3.5a) means a retried bulk-reveal enqueue
  **reserves once and reveals once** — the network retry returns the existing `jobId`, and the reservation
  is not duplicated.
### 3.9 Bulk CSV enrichment (async job) — M17

Upload a sparse CSV → match against the master graph → enrich/verify → download, at enterprise scale
([31](./31-bulk-enrichment-pipeline.md), [ADR-0039](./decisions/ADR-0039-bulk-enrichment-pipeline.md)).
This is an **async job**, mirroring `/source-imports` and `/exports` (file in → 202 + job ref → poll
status → signed download URL), not the synchronous reveal of §3.2. The job fans out across
`enrichment_jobs` → `enrichment_chunks` → `enrichment_rows` and is driven by the
`BULK_ENRICHMENT_QUEUE` workers ([31 §4](./31-bulk-enrichment-pipeline.md)).

**Create the job** (multipart CSV *or* a presigned-upload ref — large files upload straight to S3 first):
```http
POST /api/v1/enrichment/bulk
Idempotency-Key: 1a2b... (client-generated)
Content-Type: multipart/form-data            // OR application/json with { "upload": { "s3Ref":"..." } }

# multipart: file=<csv>, and a JSON `body` part:
{
  "columnMapping": { "email":"Email", "fullName":"Name", "companyDomain":"Domain" },
  "options": { "verify": true, "fillMissing": ["email","phone","title"], "skipAlreadyOwned": true }
}
=> 202
{ "jobId":"...", "status":"queued" }         // status ∈ enrichment_job_status
```

**Estimate** (cheap, sample-based; **spends nothing**, creates **no** job — a forecast only):
```http
POST /api/v1/enrichment/bulk/estimate        // same multipart/upload-ref + columnMapping shape
=> 200
{ "rowCount": 48211, "estimatedMatchRate": 0.62, "estimatedCreditMicros": 29890000 }
```
`estimatedCreditMicros` is the forecast spend in **credit-micros** (a fractional projection over the
sample × expected match-rate; `1e6` micros = `1` integer credit, so a whole-job total still resolves to
the integer credits charged at the verified-match price — [07 §1](./07-billing-credits.md)). Micros are
used only for this *forecast* (matching the `cost_micros` convention, [03 §2](./03-database-design.md#2-conventions-binding-for-all-tables));
actual per-row charges are **integer credits**, exactly as the reveal path (§3.2).

**Poll status** (progress + live match-rate; SSE later on the M12 event backbone,
[20 §8](./20-event-driven-realtime-backbone.md)):
```http
GET /api/v1/enrichment/bulk/{jobId}
=> 200
{
  "jobId":"...", "status":"running",
  "progress": { "totalRows":48211, "processedRows":31044, "matchedRows":19082 },
  "liveMatchRate": 0.61,
  "creditsCharged": 19082,
  "createdAt":"...", "updatedAt":"..."
}
```

**Confirm / cancel** — the estimate→confirm gate gives the user a spend preview before any charge:
```http
POST /api/v1/enrichment/bulk/{jobId}/confirm   // awaiting_confirmation -> running (no-op if already past)
POST /api/v1/enrichment/bulk/{jobId}/cancel    // queued|estimating|awaiting_confirmation|running|paused -> cancelled
=> 200 { "jobId":"...", "status":"running" | "cancelled" }
```

**Download** (only when `completed`; signed S3 URLs, time-boxed — mirrors `/exports`):
```http
GET /api/v1/enrichment/bulk/{jobId}/download
=> 200
{ "enrichedCsvUrl":"https://...signed...", "unmatchedReportUrl":"https://...signed...", "expiresAt":"..." }
=> 409  (Problem Details, code="job_not_complete")  when status != completed
```

**Async contract & statuses.** The lifecycle is the canonical `enrichment_job_status` vocabulary —
`queued → estimating → awaiting_confirmation → running → completed`, with `paused`, `failed`, and
`cancelled` as terminal/interrupt states ([31 §4](./31-bulk-enrichment-pipeline.md)):

| Status | Meaning |
|---|---|
| `queued` | accepted (202); awaiting a `BULK_ENRICHMENT_QUEUE` worker |
| `estimating` | sampling rows for match-rate + credit forecast |
| `awaiting_confirmation` | estimate ready; held for `…/confirm` before spending |
| `running` | matching/enriching/verifying chunks; counters advance |
| `paused` | temporarily halted (entitlement/quota/admin hold); resumable |
| `completed` | done; enriched CSV + unmatched report available at `…/download` |
| `failed` | unrecoverable error; Problem Details on the job; no further charge |
| `cancelled` | cancelled via `…/cancel`; partial results may still download |

- **Idempotency.** `POST /enrichment/bulk` honors `Idempotency-Key` exactly like the reveal path
  ([§5](#5-idempotency--concurrency)): a replayed key returns the **same `jobId`** instead of creating a
  duplicate job, so a retried upload never enqueues twice. `…/confirm` and `…/cancel` are naturally
  idempotent (terminal-state transitions are no-ops).
- **Charge per verified match** ([07 §3](./07-billing-credits.md),
  [ADR-0038](./decisions/ADR-0038-bulk-enrichment-billing-forecast-and-quota.md)): credits are spent **only for
  rows that resolve to a verified result**, on the **same per-verified-data rule as reveal**
  ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)) — `invalid`/`catch_all`/
  `unknown`/no-match rows charge **0** and land in the unmatched report; `valid` charges full; `risky`
  is charged-but-flagged. Per-row charges decrement the same tenant counter the reveal path uses
  (`tenants.reveal_credit_balance`, [07 §2](./07-billing-credits.md)) and feed the same
  credit-back-on-bounce guarantee. `skipAlreadyOwned` rows reuse the existing workspace overlay and
  charge **0** (first-reveal-wins, per workspace).
- **Tenancy & RLS** are uniform with every other endpoint: `tenant_id`/`workspace_id` derive from auth
  context (never the body), and the job + its chunks/rows are RLS-scoped to the active workspace
  ([§1](#1-conventions), [03 §9](./03-database-design.md#9-row-level-security)). Scope: `enrich:write`.

## 4. Auth & authorization

- **Dashboard:** authentication runs on a dedicated origin **`auth.truepoint.in`** (the IdP/BFF —
  [17](./17-authentication.md), [ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md)).
  The durable **Lucia** session + a rotating **refresh cookie** (HttpOnly · Secure · SameSite=Strict) stay
  on the auth origin (`user_sessions`, Postgres + Redis). After login the app domain receives a single-use
  60 s **PKCE code** and exchanges it (`/token/exchange`) for a short-lived **access JWT** (15 min,
  in-memory only); `apps/api` validates the JWT statelessly via JWKS, then resolves tenant/workspace and
  sets the RLS GUCs. **Silent refresh** hits `/token/refresh`. Login is **progressive/identifier-first**
  ([ADR-0017](./decisions/ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md)); MFA is
  TOTP/SMS/email/WebAuthn (`user_mfa_methods`); per-scope **auth policy** (MFA enforcement, allowed methods,
  IP allowlist, session timeout) resolves strictest-wins
  ([ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)). Tables:
  [03 §4](./03-database-design.md#4-tenancy--auth).
- **SSO:** Google/Microsoft OAuth + **SAML 2.0 / OIDC**; ACS/redirect resolve on `auth.truepoint.in`
  (`/sso/saml/callback`, `/sso/oidc/callback`). SSO users map to a tenant via a **verified domain**
  (`tenant_domains`) or invite, then to a workspace via `workspace_members`; first login **JIT-provisions**
  per `tenant_sso_configs.default_role`, and **SCIM 2.0** (`scim_tokens`) syncs lifecycle
  ([17 §8](./17-authentication.md#8-sso--scim-architecture)).
- **Machine/public:** `api_keys` (hashed, prefixed, **tenant-scoped**, bound to a workspace). Scopes
  gate endpoints (`search:read`, `reveal:write`, `outreach:write`, `export:write`, `enrich:write`, …). Reveals via the
  API spend the **tenant's** credits and are metered.
- **RBAC — two distinct axes** (drift hazard **H8**):
  - **Workspace role** on `workspace_members` (`owner/admin/member/viewer`) gates data actions in the
    active workspace (e.g. `viewer` can search/read but not reveal/enroll; `member`+ can reveal;
    `admin`+ manages members/sequences).
  - **Tenant-level capability** `tenant_members.org_role`
    (`owner|billing_admin|security_admin|compliance_admin|member` —
    [ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md); orthogonal to workspace role) gates
    tenant-wide actions by duty: `billing_admin` → billing/checkout + plan; `security_admin` → API keys +
    SSO config + auth policy; `compliance_admin` → suppression/DSAR/retention; `owner` → everything incl.
    workspace creation/deletion. A workspace `owner` is **not** automatically a tenant owner.

## 5. Idempotency & concurrency

- **Money endpoints** (`/contacts/:id/reveal`, and the `/credits/checkout` completion via webhook)
  require/define an idempotency key; the server stores the first response for a key and replays it on
  retry.
- **DB-level guarantees back this up** ([03 §11](./03-database-design.md#11-integrity-rules)):
  - unique `contact_reveals (workspace_id, contact_id, reveal_type)` → reveal idempotency
    (`ON CONFLICT … DO NOTHING` makes re-reveal of the same copy free);
  - `tenants.reveal_credit_balance CHECK (>= 0)` + `SELECT … FOR UPDATE` → no overdraft, no
    double-spend under concurrent reveals for one tenant;
  - unique `purchases.stripe_event_id` → idempotent Stripe top-ups.
- Per-workspace dedup on import (unique `(workspace_id, email_blind_index)` /
  `(workspace_id, linkedin_public_id)` / `(workspace_id, sales_nav_lead_id)`) makes `POST
  /source-imports` safely re-runnable.
- **Idempotency-on-enqueue for bulk jobs** ([§3.5a](#35-bulk-async-jobs--the-uniform-contract-import--export--bulk-reveal)).
  Bulk import/export/reveal carry a **job-level** `Idempotency-Key` (one per batch/enqueue, **not** per
  item). The server records the key against the created job; a re-POST with the same key **returns the
  existing `jobId`** instead of enqueuing a second job — so a retried enqueue collapses to one job, one
  credit reservation, one load (resume/revert are then by `jobId` per [30 §4](./30-bulk-import-export-pipeline.md)).
- **Bulk governors** (multi-tenant fairness for million-row work — [18 §9](./18-scalability-performance.md),
  [30 §6](./30-bulk-import-export-pipeline.md)):
  - **Per-tenant in-flight bulk-concurrency cap** — queued/running bulk jobs above the cap get `429` +
    `Retry-After` (the enqueue is rejected, never dropped); the client retries with its same
    `Idempotency-Key`.
  - **Dedicated bulk queue-class rate limit** — bulk endpoints draw on a **separate token bucket** from the
    interactive per-key/per-session limit ([§1](#1-conventions)), so a large export/import cannot starve
    dashboard traffic, and bulk abuse can't exhaust the interactive budget.

## 6. Errors (Problem Details)

```json
{ "type":"https://leadwolf.dev/errors/insufficient_credits",
  "title":"Insufficient credits", "status":402,
  "code":"insufficient_credits",
  "detail":"This reveal costs 1 credit; balance is 0.",
  "balance":0, "required":1 }
```
Stable machine-readable `code` for every error; never leak internal details or PII in errors.

## 7. Versioning & deprecation

- URI versioning (`/api/v1`) for REST; tRPC versions with the app it ships in. Additive changes are
  non-breaking; breaking changes bump the version.
- Deprecations announced via `Sunset` header + changelog; a documented **minimum support window of
  ≥ 6 months** for a deprecated version once the public API is live.

## 8. Public API readiness (post-MVP, seams now)

Built so the public API is mostly *exposing* what already exists:
- API keys + scopes (schema + admin UI) exist from M2.
- Idempotency + metering exist from M3.
- **The same service layer powers tRPC and REST** (thin handlers over `packages/core`/`packages/db`).
- Add: per-key rate limits/quotas (**incl. per-tenant global-search quotas**, [18 §9](./18-scalability-performance.md)),
  hosted OpenAPI docs, usage-based billing hooks, sandbox keys, **SSE streaming**
  ([20 §8](./20-event-driven-realtime-backbone.md)), and resource groups for **teams**
  ([25](./25-departments-teams-workspaces.md)), **AI** ([23](./23-ai-intelligence-layer.md)),
  **automation** ([27](./27-workflow-automation-engine.md)), and **saved-views/segments**
  ([24](./24-advanced-search-exploration-ux.md)).
- **CRM-neutral by design (strategic).** The public API + CRM sync ([10 M10](./10-roadmap.md)) keep TruePoint an
  **open, CRM-agnostic layer** — the most defensible counter to incumbent feature-absorption (the market
  analysis' sole Critical risk — [10 risk #13](./10-roadmap.md), recommendation R8) and a low-noise acquisition
  channel for the orphaned ex-Clearbit / API-first audience ([15 §3](./15-gap-remediation.md)).

## 9. OpenAPI & docs

- `@hono/zod-openapi`: Zod schemas → generated **OpenAPI 3.1** spec; served at `/api/v1/openapi.json`
  and rendered docs. The internal app uses the tRPC type-bridge (no separate client codegen).
- Contract drives a typed REST client (and contract tests).

## 10. Webhooks (outbound, post-MVP)

For customers: subscribe to events with signed payloads, retries with backoff, and a delivery log. Not
in MVP, but the event vocabulary is reserved now. These ride the **domain-events catalog / transactional
outbox** ([20 §2](./20-event-driven-realtime-backbone.md)); **reverse-ETL** + native apps live in
[26](./26-integrations-data-delivery.md):

| Event | Fires when |
|---|---|
| `reveal.completed` | a reveal commits (includes `reveal_type`, `creditsCharged`, `alreadyOwned`) |
| `score.updated` | a new `scores` row lands → `contacts.priority_score` re-cached ([ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)) |
| `outreach.status_changed` | an enrollment's `status` or a contact's `outreach_status` changes ([ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md)) |
| `enrichment.completed` | an on-demand enrichment job finishes |
| `enrichment.bulk.completed` | a bulk CSV enrichment job reaches `completed`/`failed`/`cancelled` (rowCount, matchedRows, creditsCharged) ([31 §4](./31-bulk-enrichment-pipeline.md)) |
| `import.completed` | a `source_imports` job finishes (counts, dedup outcome) |
| `bulk_job.state_changed` | a bulk import/export/reveal job changes state (terminal + `pending_approval`); carries `jobId`, `kind`, `counts` ([§3.5](#35-bulk-async-jobs--the-uniform-contract-import--export--bulk-reveal), [30](./30-bulk-import-export-pipeline.md)) |
| `signal.received` | an intent signal is ingested (`signal_type`, account/contact) — feeds automation ([27](./27-workflow-automation-engine.md)) |
| `verification.completed` | a `verification_jobs` run finishes (freshness + credit-back, [22](./22-data-quality-freshness-lifecycle.md)) |
| `list.updated` | a list's membership changes |
| `auth.event` | an auth event of interest fires (suspicious login, MFA enrolled, SSO/device change) — [17 §9](./17-authentication.md#9-audit--events) |

## 11. Open questions

1. Public API GA timing and its pricing relationship to credits (same pool vs separate metering)?
2. GraphQL for the dashboard later, or stay tRPC + REST? (Default: tRPC internal + REST public; revisit
   if a customer needs flexible field selection.)
3. Outbound webhook event catalog finalization (and per-event payload schemas).
4. Workspace selection for API keys — one key per workspace vs a tenant key with an explicit
   `X-Workspace-Id` per call?
5. **CRM integration build approach** — build each connector behind the custom `IntegrationProvider`
   ([05 §14](./05-features-modules.md), [10 M10](./10-roadmap.md)) vs adopt a **unified integration API**
   (e.g. **Merge.dev**) to ship Salesforce/HubSpot/Pipedrive from one integration. *(Lean: unified API for
   breadth at launch, custom where depth differentiates — data-side research
   [../research/sales-intelligence-data-research.md](../research/sales-intelligence-data-research.md) §6.)*
