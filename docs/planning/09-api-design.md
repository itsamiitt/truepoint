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
/login                          POST: identifier → domain lookup → routed step (no enumeration, ADR-0017)
/auth/signup                    POST: provision tenant + owner user + default workspace
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
/imports                        alias of /source-imports (11 §6 wiring map)

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

/exports                        POST: create export (CSV); GET status; signed download URL

/compliance/suppression         CRUD suppression entries (scope global|tenant|workspace)
/compliance/dsar                POST intake; GET status   (+ public intake variant)

/enrichment/:entity/:id         POST: trigger on-demand enrichment (async; returns job ref)
```

Resource names follow the corpus-wide rename ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md)):
**`organizations`→`tenants`, `persons`→`contacts`, `companies`→`accounts`**. Contacts/accounts are
**per-workspace copies** — there is no global golden record, so a contact id is only meaningful within
its workspace.

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
  "next_cursor": "...",
  "total_estimate": 1280
}
```
No PII (real email/phone) is returned here — only **masked previews + status + facets**. Search is
served by **Typesense** behind `SearchPort`, fed by Aurora CDC ([ADR-0002](./decisions/ADR-0002-search-postgres-then-engine.md));
the index carries non-PII facets only (`email_domain`, `email_status`, `seniority_level`,
`priority_score`, …), never decrypted PII. Results are scoped to the active workspace by RLS.

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
  gate endpoints (`search:read`, `reveal:write`, `outreach:write`, `export:write`, …). Reveals via the
  API spend the **tenant's** credits and are metered.
- **RBAC — two distinct axes** (drift hazard **H8**):
  - **Workspace role** on `workspace_members` (`owner/admin/member/viewer`) gates data actions in the
    active workspace (e.g. `viewer` can search/read but not reveal/enroll; `member`+ can reveal;
    `admin`+ manages members/sequences).
  - **Tenant-level billing/admin capability** `users.is_tenant_owner` (orthogonal to workspace role)
    gates tenant-wide actions: billing/checkout, plan + entitlements, API keys, SSO config, workspace
    creation/deletion. A workspace `owner` is **not** automatically a tenant owner.

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
- Deprecations announced via `Sunset` header + changelog; minimum support window once the public API
  is live.

## 8. Public API readiness (post-MVP, seams now)

Built so the public API is mostly *exposing* what already exists:
- API keys + scopes (schema + admin UI) exist from M2.
- Idempotency + metering exist from M3.
- **The same service layer powers tRPC and REST** (thin handlers over `packages/core`/`packages/db`).
- Add: per-key rate limits/quotas, hosted OpenAPI docs, usage-based billing hooks, sandbox keys.
- **CRM-neutral by design (strategic).** The public API + CRM sync ([10 M10](./10-roadmap.md)) keep LeadWolf an
  **open, CRM-agnostic layer** — the most defensible counter to incumbent feature-absorption (the market
  analysis' sole Critical risk — [10 risk #13](./10-roadmap.md), recommendation R8) and a low-noise acquisition
  channel for the orphaned ex-Clearbit / API-first audience ([15 §3](./15-gap-remediation.md)).

## 9. OpenAPI & docs

- `@hono/zod-openapi`: Zod schemas → generated **OpenAPI 3.1** spec; served at `/api/v1/openapi.json`
  and rendered docs. The internal app uses the tRPC type-bridge (no separate client codegen).
- Contract drives a typed REST client (and contract tests).

## 10. Webhooks (outbound, post-MVP)

For customers: subscribe to events with signed payloads, retries with backoff, and a delivery log. Not
in MVP, but the event vocabulary is reserved now:

| Event | Fires when |
|---|---|
| `reveal.completed` | a reveal commits (includes `reveal_type`, `creditsCharged`, `alreadyOwned`) |
| `score.updated` | a new `scores` row lands → `contacts.priority_score` re-cached ([ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)) |
| `outreach.status_changed` | an enrollment's `status` or a contact's `outreach_status` changes ([ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md)) |
| `enrichment.completed` | an on-demand enrichment job finishes |
| `import.completed` | a `source_imports` job finishes (counts, dedup outcome) |
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
