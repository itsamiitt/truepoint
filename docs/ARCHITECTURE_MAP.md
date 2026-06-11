# LeadWolf — Architecture Map

> **Status:** `live` · **Generated from:** [`docs/architecture-map.json`](./architecture-map.json)
> (run `node .claude/hooks/gen-architecture-map.mjs` — or `bun run arch:map` — to refresh). **Paths come
> from the JSON (generated); do not edit paths here by hand.** One-line purposes and the Mermaid graph are
> authored here. Maintained by the [`enterprise-architecture`](../.claude/skills/enterprise-architecture/SKILL.md) skill.

> **Live end-to-end — the FULL M0–M5 MVP thin slice + its web UI** (auth round-trip · M1 import · M3 reveal
> & credits · M4 enrichment/verification/scoring · **M5 compliance hardening**: DSAR fan-out with
> verification scan, consent + global-suppression-on-withdraw, the privileged `leadwolf_admin` path,
> tombstones, public DSAR intake). **The web app (`apps/web`) now renders the surfaces**: a 6-destination
> **AppShell** (sidebar + top-bar credit pill + workspace switcher) over a `(shell)` route group, the
> **Prospect** surface (filter rail · masked results grid · right slide-over record detail · the reveal
> confirmation dialog driving `POST /contacts/:id/reveal` with 402/403 handling · score panel), **Home**
> cockpit (credit/usage StatTiles + recent reveals + quick actions), and **Settings ▸ Billing & Credits**
> (balance + usage history) and **▸ Compliance** (suppression + public DSAR intake) — built on token-driven
> `packages/ui` primitives (`StatusBadge`/`Card`/`StatTile`/`Spinner`), `next build` green (11 routes).
> **Post-MVP M7–M9 are in**: the **activity timeline** (per-contact stream + the `last_activity_at`
> sync trigger) now drives a real **engagement component** in the scorer (M8), **Sales Navigator link
> capture** is HITL-only per ADR-0009 (M7), and the **outreach engine** (M9) ships sequences → steps →
> enrollment with the suppression gate run in-tx at BOTH enroll and send, CAN-SPAM identity enforced at
> the send transaction (postal-address + unsubscribe footer auto-appended), and the ADR-0013 bounce
> credit-back — proven by `activity.itest.ts` (5) + `outreach.itest.ts` (8). The web grew the
> **Sequences** (builder + enrollment log + send), **Reports** (client-side rollups), and **Inbox**
> (placeholder) destinations.
> 271 source files, 0 warnings, 2 framework-root files unbucketed (`apps/{auth,web}/next.config.mjs` — see Notes). **M4** adds the provider-agnostic enrichment engine
> (port in core, Apollo/ZoomInfo/Clearbit adapters in the now-live `packages/integrations`, cache-first +
> budget breaker + waterfall), **verify-on-reveal driving the ADR-0013 charge** (verification runs BEFORE
> the FOR UPDATE window; `valid` charges, `invalid`/`catch_all`/`unknown` charge 0, `risky` configurable),
> and the versioned `scores` + `intent_signals` intelligence layer with the priority_score sync trigger —
> proven by `intel.itest.ts` (6 invariants) with the M3 suite still green under the new flow.
> **M2 auth** is global-identity (`users` global + `tenant_members`): identifier-first sign-in
> (password → MFA → **org** → workspace) or registration with hybrid org placement, minting/validating the
> access JWT. **M1 Import & Contacts Core**: per-workspace CSV import dedupes contacts/accounts (encrypted
> PII + blind index) with `source_imports` provenance, behind RLS, surfaced by a masked list + import
> wizard. **M3 Reveal & Credits** lands the monetized path (07 §3): the suppression-gated, idempotent,
> `FOR UPDATE`-serialized reveal transaction against the tenant credit counter, the append-only `audit_log`
> (closed action enum), the suppression/DNC list, Stripe webhook top-ups (idempotent on
> `stripe_event_id`), the Idempotency-Key replay store, and the credits balance/usage API — proven by the
> Testcontainers/external-PG DoD suite (`reveal.itest.ts`: 9 invariants incl. N-concurrent no-double-charge
> and fail-closed RLS). `apps/admin` remains a **target**. Design: [10-roadmap.md](./planning/10-roadmap.md)
> M1–M3, [14 §3.4](./planning/14-phase-1-execution.md), [07 §3](./planning/07-billing-credits.md),
> [08 §3/§5](./planning/08-compliance.md), ADR-0006/0007.

## Repo tree (live; `apps/admin` is a target)

```
packages/                       # side-effect-free libraries, each exported via one index.ts  [LIVE]
  types/   src/{errors,auth,contacts,billing,intel,compliance,activity,outreach}.ts # RFC-9457 errors + the Zod contracts (leaf)
  config/  src/env.ts           # zod-validated env (ONLY process.env reader; BLIND_INDEX_KEY, REVEAL_COST_*, STRIPE_WEBHOOK_SECRET)
  ui/      src/                 # TruePoint tokens + cn helper + StatusBadge/Card/StatTile/Spinner primitives
  db/      src/                 # Drizzle schema + RLS + repositories (the ONLY data access)  [LIVE]
    schema/{auth,contacts,billing,intel,compliance,activity,salesnav,outreach}.ts  rls/*.sql (one per schema)
    client.ts(withTenantTx · withPrivilegedTx · closeDb)  applyMigrations.ts migrate.ts seed.ts
    repositories/{user,workspace,account,contact,sourceImport,reveal,credit,suppression,audit,idempotency,
                  score,intentSignal,providerCall,consent,dsar,activity,salesNavLink,sequence,outreachLog}Repository.ts
    test/{import,reveal,intel,compliance,activity,outreach}.itest.ts + itestDb.ts  # DoD proofs (Testcontainers or ITEST_DATABASE_URL)
  core/    src/                 # domain logic                                                          [LIVE]
    import/      runImport · parseFile · columnMap · normalize · blindIndex · encryptPii · contentHash
    reveal/      revealContact (verify-first money tx: verify → suppress-gate → claim → charge → audit)
    billing/     stripeWebhook (verify/sign/parse) · grantFromStripe (idempotent grant)
    compliance/  assertNotSuppressed (in-tx DNC gate) · writeAudit · dsarIntake · deleteFanout · assembleAccessReport · consent
    enrichment/  providerPort (06 §3 contract) · waterfall (order/breaker) · requestHash · enrichContact
    data-health/ emailVerifier (port + passThrough/static) · chargeFor (ADR-0013) · validatePhone
    scoring/     computeScore (rule-based v1 + M8 engagement, appends versioned scores — ADR-0008)
    activity/    logActivity (tombstone-aware timeline append; the DB trigger syncs last_activity_at)
    outreach/    senderPort · createSequence · enrollContact · sendStep (CAN-SPAM + in-tx gates) · handleBounce
  auth/    src/                 # self-built auth primitives (no HTTP)
  integrations/ src/enrichment/ # vendor adapters implementing core's port (httpProvider + apollo/zoominfo/clearbit)  [LIVE]
apps/                           # deployable processes (thin transport adapters)
  api/   src/                   # Hono on Bun — validates the access JWT; never issues tokens  [LIVE]
    middleware/{authn,tenancy,error,rateLimit,idempotency}.ts
    features/{auth,import,reveal,billing,enrichment,scoring,compliance,activity,sales-navigator,outreach}/  app.ts  server.ts
  auth/  src/                   # auth.truepoint.in IdP (Next 15) — screens + /token/* + JWKS  [LIVE]
  web/   src/                   # app.truepoint.in (Next 15) — the 6-destination AppShell  [LIVE]
    app/(shell)/{home,prospect,sequences,inbox,reports,settings}  app/{page,import,auth/callback}
    components/shell/  features/{import,prospect,home,sequences,reports,settings-billing,settings-compliance}/
    lib/{authClient,pkce,publicConfig}
  workers/ src/                 # Bun + BullMQ — imports · enrichment · scoring · dsar · outreach queues  [LIVE]
    index.ts  register.ts  queues/{imports,enrichment,scoring,dsar,outreach}.ts
  admin/                        # internal staff console                                          [TARGET]
```

## FEATURE → FILES index (live)

### import — *M1, load-bearing* ([05 §3](./planning/05-features-modules.md), [10 M1](./planning/10-roadmap.md))
- **core (pipeline + primitives):** `packages/core/src/import/runImport.ts` (the load-bearing
  parse→map→normalize→dedup-upsert→provenance pipeline), `parseFile.ts` (RFC-4180 CSV; XLSX seam),
  `columnMap.ts`, `normalize.ts`, `blindIndex.ts` (HMAC dedup key), `encryptPii.ts` (AES-GCM, KMS-swappable),
  `contentHash.ts` (idempotency); tests `*.test.ts`
- **db:** `packages/db/src/repositories/sourceImportRepository.ts` (per-import provenance + content-hash skip)
- **api:** `apps/api/src/features/import/{routes,index}.ts` (POST `/api/v1/imports` — multipart → `runImport`)
- **workers:** `apps/workers/src/queues/imports.ts` (the `imports` processor → same `runImport`)
- **web:** `apps/web/src/features/import/*` (ImportWizard + ContactsTable + ImportPage, hooks, api.ts) →
  route `apps/web/src/app/import/page.tsx`

### reveal — *M1 masked reads + M3 money loop* ([05 §7](./planning/05-features-modules.md), [07 §3](./planning/07-billing-credits.md), ADR-0007)
- **core:** `packages/core/src/reveal/revealContact.ts` — THE monetized transaction (07 §3, H1/H2):
  in-tx suppression gate → idempotent claim (`ON CONFLICT DO NOTHING` on the unique
  `(workspace, contact, reveal_type)`) → `FOR UPDATE` charge against `tenants.reveal_credit_balance` →
  same-tx audit; free re-reveal of an owned copy; config-injected `revealCostFor` (never hardcoded)
- **api:** `apps/api/src/features/reveal/{routes,index}.ts` (GET `/api/v1/contacts` masked list;
  POST `/api/v1/contacts/:id/reveal` behind the Idempotency-Key replay middleware)
- **db:** `packages/db/src/repositories/{account,contact}Repository.ts` (overlay reads/writes, masked list);
  `revealRepository.ts` (contact-for-reveal + the idempotent claim + usage list)

### billing — *M3 credits + Stripe* ([07 §2/§4](./planning/07-billing-credits.md))
- **core:** `packages/core/src/billing/stripeWebhook.ts` (HMAC signature verify + `signStripePayload` test
  helper + `parseCreditGrantEvent`), `grantFromStripe.ts` (grant exactly once per `stripe_event_id`)
- **api:** `apps/api/src/features/billing/{routes,index}.ts` — POST `/api/v1/billing/webhook`
  (signature-verified, the ONLY credit-grant path) + GET `/api/v1/credits/{balance,usage}`
- **db:** `packages/db/src/repositories/creditRepository.ts` (lock/decrement/read the tenant counter +
  `grantFromEvent` system tx), `idempotencyRepository.ts` (stored-response replay for money endpoints)

### compliance — *M3 gate + audit; M5 DSAR/consent (MVP-completing)* ([08](./planning/08-compliance.md))
- **core:** `packages/core/src/compliance/` — `assertNotSuppressed.ts` (the unbypassable in-tx DNC gate),
  `writeAudit.ts` (same-tx audit writer; closed enum), `dsarIntake.ts` (public intake: encrypted subject
  email + blind index), `deleteFanout.ts` (the 08 §4.2 erase-everywhere: tombstone every copy across
  tenants → purge dependents → GLOBAL suppression → per-copy audit → **verification scan gates
  `completed`**; idempotent), `assembleAccessReport.ts` (08 §4.1 enumeration + footprints),
  `consent.ts` (record + withdraw; withdrawal auto-adds global suppression)
- **db:** `suppressionRepository.ts`, `auditRepository.ts` (append-only), `consentRepository.ts`,
  `dsarRepository.ts` (request workflow + the PRIVILEGED `dsarFanoutRepository` cross-workspace queries);
  `client.ts` adds **`withPrivilegedTx`** (`SET LOCAL ROLE leadwolf_admin`, BYPASSRLS — the one sanctioned
  cross-workspace path, 03 §9/ADR-0011; the role is created in the migration bootstrap)
- **api:** `apps/api/src/features/compliance/*` — public POST `/api/v1/compliance/dsar` (session-less,
  registered before the authenticated router) + suppression/consent endpoints
- **workers:** `apps/workers/src/queues/dsar.ts` (privileged processing for VERIFIED requests)

### enrichment — *M4, provider waterfall* ([06](./planning/06-enrichment-engine.md))
- **core:** `packages/core/src/enrichment/providerPort.ts` (the 06 §3 contract — core OWNS the port),
  `waterfall.ts` (trust÷cost ordering + per-provider circuit breaker), `requestHash.ts` (normalized cache
  key), `enrichContact.ts` (cache-first → budget breaker → waterfall → overlay upsert + `source_imports`
  provenance + `provider_calls` cost row, one tx)
- **integrations:** `packages/integrations/src/enrichment/{httpProvider,providers}.ts` — Apollo/ZoomInfo/
  Clearbit VendorSpecs over one HTTP shape; injectable `fetchJson` → contract tests on recorded fixtures,
  zero live spend; a missing API key is a permanent `miss`
- **db:** `packages/db/src/repositories/providerCallRepository.ts` (cache lookup + cost ledger + daily-spend
  sum for the budget breaker)
- **api:** `apps/api/src/features/enrichment/*` (POST `/api/v1/enrichment/:entity/:id`, inline like M1
  import; bulk diverts to the queue) · **workers:** `apps/workers/src/queues/enrichment.ts`

### data-health — *M4 verification* ([06 §9](./planning/06-enrichment-engine.md), ADR-0013)
- **core:** `packages/core/src/data-health/emailVerifier.ts` (the dedicated-verifier port; passThrough until
  a vendor is chosen — 06 §11 Q1 — plus a static fixture verifier), `chargeFor.ts` (the ADR-0013
  charge-by-verified-result mapping, exhaustively unit-tested), `validatePhone.ts` (E.164 sanity)

### scoring — *M4 model + M8 engagement* ([ADR-0008](./planning/decisions/ADR-0008-lead-scoring-model.md))
- **core:** `packages/core/src/scoring/computeScore.ts` (rule-based v1: ICP fit + intent signals + the M8
  **engagement component** — 30-day activity counts where replies/meetings dominate; appends a versioned
  `scores` row with an explanatory breakdown; the DB trigger syncs `contacts.priority_score`)
- **db:** `packages/db/src/repositories/{score,intentSignal}Repository.ts`
- **api:** `apps/api/src/features/scoring/*` (GET `/contacts/:id/scores`, POST `/contacts/:id/rescore`)
  · **workers:** `apps/workers/src/queues/scoring.ts`

### activity — *M8 timeline* ([05 §10](./planning/05-features-modules.md), [03 §7](./planning/03-database-design.md))
- **core:** `packages/core/src/activity/logActivity.ts` (tombstone-aware contact check + append, one tx;
  no audit row — the activity IS the record)
- **db:** `packages/db/src/repositories/activityRepository.ts` (newest-first timeline +
  `recentCountsForContact` feeding the M8 engagement score); `schema/activity.ts` + `rls/activity.sql`
  carry the **`activities_sync_last_activity` trigger** — `contacts.last_activity_at` is a cache of the
  newest `occurred_at` and never regresses on backfill
- **api:** `apps/api/src/features/activity/{routes,index}.ts` — GET/POST `/contacts/:id/activities`
  (mounted on the same `/api/v1/contacts` base as reveal/scoring; no path overlap)

### sales-navigator — *M7 link capture (HITL)* ([05 §5](./planning/05-features-modules.md), ADR-0009)
- **db:** `packages/db/src/repositories/salesNavLinkRepository.ts`; `schema/salesnav.ts` dedups on
  (workspace_id, url)
- **api:** `apps/api/src/features/sales-navigator/{routes,index}.ts` — POST/GET `/sales-navigator/links`.
  A human pastes the link; **nothing is automated against LinkedIn** (assisted capture only). Contact
  Sales-Nav identity (`sales_nav_lead_id`) already flows through the M1 import pipeline.

### outreach — *M9 sequences + the suppression-gated send engine* ([05 §13](./planning/05-features-modules.md), [08 §3/§6](./planning/08-compliance.md), ADR-0009/0013)
- **core:** `packages/core/src/outreach/` — `createSequence.ts` (create + addStep; audits
  `sequence.create`/`sequence.update`), `enrollContact.ts` (revealed-only + **`assertNotSuppressed`
  in-tx** + idempotent (sequence, contact) membership + `outreach_status` rollup + audit `enroll`),
  `sendStep.ts` (**the compliance-critical send tx**: CAN-SPAM identity BLOCKED-not-warned at send,
  suppression re-checked in-tx so post-enrollment DNC/bounce rows still stop the message,
  postal-address + unsubscribe footer auto-appended, audit `send`), `handleBounce.ts` (replay-idempotent:
  log `bounced` + auto-suppression reason `bounce` + the **ADR-0013 credit-back** audited
  `credit.adjust`), `senderPort.ts` (`EmailSenderPort`: dev `consoleSender` + test `staticSender`; the
  M12 SES adapter swaps the port without touching the send tx)
- **db:** `packages/db/src/repositories/{sequence,outreachLog}Repository.ts`; `schema/outreach.ts`
  (`outreach_sequences` → `outreach_steps` → `outreach_log`; unique (sequence_id, contact_id) IS the
  enrollment-idempotency key) + `rls/outreach.sql`
- **api:** `apps/api/src/features/outreach/{routes,index}.ts` — `/api/v1/outreach/sequences*` CRUD/enroll/
  log + `/log/:id/send` + `/log/:id/bounce` (dev stand-in for the SES SNS→SQS feedback worker)
- **workers:** `apps/workers/src/queues/outreach.ts` (one enrollment-step delivery per job; step delays
  arrive as BullMQ job delays via `enqueueOutreach`)

### auth — *M2, global identity* ([05 §1](./planning/05-features-modules.md), [17](./planning/17-authentication.md), ADR-0019/0020)
- **api:** `apps/api/src/features/auth/{routes,index}.ts` (GET `/api/v1/auth/session` from verified claims)
- **db:** `packages/db/src/repositories/userRepository.ts` (global user/identity: users + sessions +
  `authEmailTokenRepository` for email-verification codes); `workspaceRepository.ts` `tenantSsoConfigRepository`
- **shared primitives:** `packages/auth/*` — login (`identifierLookup`/`login`/`flow`), `botCheck`/`rateLimit`
  anti-abuse (Turnstile in `apps/auth/src/shared/TurnstileWidget.tsx`), **registration**
  (`registration` provisioning + `emailVerification` codes + `signupTransaction`), **invitations**
  (`invitations` — mint a link token + accept-by-token; new invitees auto-accept by email at signup), and
  **SSO** (`sso/{types,providers,mockIdp,jit}` + `ssoTransaction` — one provider seam over OIDC/SAML with a
  dev mock IdP; callback JIT-provisions the identity + membership)
- **IdP origin:** `apps/auth/*` screens — sign-in (identifier → password → mfa → **org** → workspace, with
  `app/org/*` the org selector), **registration** (`app/signup/*` + `app/verify`, mailed via `lib/mailer`),
  and **SSO** (`app/sso/*` handoff + `oidc`/`saml` callbacks + dev `mock` IdP, via `lib/{ssoConfig,completeSso}`)
  + `/token/*` + JWKS
- **app-domain:** `apps/web` callback + in-memory token client

### workspaces — *M2* ([05 §2](./planning/05-features-modules.md))
- **db:** `packages/db/src/repositories/workspaceRepository.ts` — RLS-scoped workspaces plus the
  **tenant-membership / domain / invitation** repos and **new-org provisioning** (`tenantRepository`
  + `tenantMemberRepository.joinOrg`) for registration placement (the `tenant_members` model, ADR-0019/0020)

### Web UI surfaces ([04](./planning/04-ui-ux-design.md), [11](./planning/11-information-architecture.md))
The `apps/web` SPA: a `(shell)` route-group layout wraps every destination in the **AppShell** (auth
gate + sidebar + top bar). Slices follow the `import` pattern (`api.ts` → `fetchWithAuth`; hooks;
components; `index.ts`). Styling: shell + Prospect via `--tp-*` classes in `app/globals.css`; other
slices via co-located CSS Modules; primitives in `@leadwolf/ui`.
- **shell** (shared): `apps/web/src/components/shell/{AppShell,Sidebar,TopBar,CreditPill,WorkspaceSwitcher}.tsx`
  — the 6-destination chrome; `CreditPill` polls `/credits/balance` and re-fetches on a `credits:changed`
  window event; `app/(shell)/layout.tsx` mounts it.
- **prospect** (web): `apps/web/src/features/prospect/*` — filter rail + masked grid + `RecordDetail`
  slide-over + `RevealDialog` (`POST /contacts/:id/reveal` with `Idempotency-Key`; branches on
  `insufficient_credits` 402 / `suppressed` 403; dispatches `credits:changed`); routed at `(shell)/prospect`.
- **home** (web): `apps/web/src/features/home/*` — cockpit composing `/credits/balance` + `/credits/usage`
  into `StatTile`s + recent-reveals + quick actions; routed at `(shell)/home` (`/` redirects to `/prospect`).
- **settings-billing** (web): `apps/web/src/features/settings-billing/*` — balance card + usage history
  (`/credits/*`); routed at `(shell)/settings/billing` (the credit-pill deep-link target).
- **settings-compliance** (web): `apps/web/src/features/settings-compliance/*` — `SuppressionForm`
  (`POST /compliance/suppression`) + `DsarForm` (public `POST /compliance/dsar`); `(shell)/settings/compliance`.
- **sequences** (web): `apps/web/src/features/sequences/*` — list + two-phase builder (CAN-SPAM identity
  fields up front), per-sequence enrollment panel (log table + send-next-step with the 422 CAN-SPAM
  message verbatim + quiet `suppressed` DNC notices), enroll picker filtered to revealed contacts;
  `types.ts` holds the view models + status→tone maps; routed at `(shell)/sequences`.
- **reports** (web): `apps/web/src/features/reports/*` — client-side rollups (`rollups.ts`) over
  `/credits/*` + `/contacts`: credit-usage StatTiles + 14-day CSS bars, outreach funnel, data-health
  badges (the ClickHouse pipeline is post-MVP); routed at `(shell)/reports`.
- **inbox** (page only): `(shell)/inbox/page.tsx` — calm placeholder until mailbox sync ships (the M9
  reply-ingestion design gate); links to /sequences for send status.
- **`@leadwolf/ui` primitives:** `packages/ui/src/components/{StatusBadge,Card,StatTile,Spinner}.tsx`
  (token-driven, monochrome, presentational) exported from `packages/ui/src/index.ts`.

_Remaining domains (`search`, `lists`, `crm-sync`, `export`, `api-public`, `ai`, `alerts`, `templates`,
`notifications`, …) have **no code yet**; targets in
[05](./planning/05-features-modules.md) + [11 §6](./planning/11-information-architecture.md)._

## Destinations cross-reference (6 web destinations → domains; + the auth origin)

> From [11 §6](./planning/11-information-architecture.md). The masked contacts list + import wizard surface
> under **Prospect**; auth surfaces on the dedicated auth origin and inside Settings.

| Destination | Surfaces domains | API |
|---|---|---|
| **Home** | home, notifications | `/home/summary`, `/notifications` |
| **Prospect** | search, **reveal**, lists, **import**, enrichment, scoring | `/api/v1/imports`, `/api/v1/contacts`, `/search/*`, `/lists` |
| **Sequences** | outreach, templates | `/outreach/*`, `/templates` |
| **Inbox** | inbox | `/inbox`, `/tasks` |
| **Reports** | reports, data-health | `/reports/*` |
| **Settings** | admin-settings, billing, compliance, api-public, **auth** | `/settings/*`, `/billing` |
| **(auth origin)** | auth | `auth.truepoint.in/login · /password · /signup · /verify · /sso · /sso/{oidc,saml}/callback · /org · /token/* · /.well-known/jwks.json` |

## DEPENDENCY section (which packages depend on which)

From [`architecture-map.json`](./architecture-map.json) `dependencies` (the allowed graph, [16 §5](./planning/16-code-organization.md)):

- `types` — leaf. **`config`** → `types`. `ui` → `types`. `db` → `types`, `config`.
- **`core`** → `db`, `types`, `config` *(live in M1: import pipeline imports `@leadwolf/db`/`@leadwolf/types`/`@leadwolf/config`;
  declares ports, never imports `integrations`)*. `auth` → `db`, `types`, `config`. `integrations` → `core`, `types`, `config`.
- **`apps/api`** → `core`, `db`, `auth`, `config`, `types` (+ `hono`). **`apps/workers`** → `core`, `config`, `types` (+ `bullmq`/`ioredis`).
  **`apps/web`** → `types`, `ui` (+ `next`/`react`; talks to the api over HTTP, never via imports). `apps/*` → any `packages/*`; **never** another app.

Enforced by `dependency-cruiser` ([`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs); `bun run lint:boundaries`).
Imports go only through each package's `index.ts` (no deep imports). The Mermaid graph only *visualizes* this.

## Allowed module-dependency graph

```mermaid
flowchart TD
  subgraph apps
    web; auth; api; workers; admin
  end
  subgraph packages
    core; db; authpkg["auth"]; integrations; search; email; ui; analytics; observability; config; types
  end
  apps --> packages
  core --> db; core --> search; core --> types; core --> config
  db --> types; db --> config
  authpkg --> db; authpkg --> types; authpkg --> config
  integrations --> core; integrations --> types; integrations --> config
  search --> types; search --> config
  email --> types; email --> config
  ui --> types
  analytics --> types; analytics --> config
  observability --> types; observability --> config
  config --> types
```

## Shared / platform areas (live)

- **`packages/types`** — `errors.ts` (RFC-9457 + `ImportValidationError`/`InsufficientCreditsError`/
  `SuppressedError`), `auth.ts`, `contacts.ts`, `billing.ts` (`revealType`, suppression scopes, the **closed
  `auditAction` enum** — source of truth mirrored by the SQL CHECK), `activity.ts` (activity timeline +
  Sales Navigator link vocabularies), `outreach.ts` (sequence/step/log enums + request schemas — closed
  vocabularies mirrored by the outreach SQL CHECKs), `index.ts`.
- **`packages/config`** — `env.ts` (the only `process.env` reader; `BLIND_INDEX_KEY`, the `REVEAL_COST_*`
  placeholders per 07 §1, `STRIPE_WEBHOOK_SECRET`), `index.ts`.
- **`packages/ui`** — `tokens.css`, `cn.ts`, `index.ts`.
- **`packages/db`** — `client.ts` (`withTenantTx` GUC helper + `closeDb` graceful drain), `applyMigrations.ts`
  (bootstrap → drizzle → RLS), `migrate.ts`, `seed.ts`,
  `schema/{auth,contacts,billing,intel,compliance,activity,salesnav,outreach}.ts`, `schema/index.ts`,
  `drizzle.config.ts`, `index.ts`, and `test/` — `itestDb.ts` (provisions Testcontainers **or** an external
  server via `ITEST_DATABASE_URL`) + the six DoD suites
  `{import,reveal,intel,compliance,activity,outreach}.itest.ts`; run itest files in **separate**
  processes — the db client is a module singleton. RLS in `src/rls/*.sql` (one per schema file, applied
  sorted) — policies use the `NULLIF(current_setting(…, true), '')::uuid` idiom so unset/reset GUCs
  **fail closed** to zero rows; `billing.sql` also carries the reveal-ownership trigger + the audit_log
  append-only trigger; `activity.sql` the `last_activity_at` sync trigger; `outreach.sql` the
  sequences `updated_at` trigger.
- **`packages/core`** — `index.ts` (public surface: import pipeline + `revealContact`, `assertNotSuppressed`,
  `writeAudit`, `grantFromStripe`, stripe webhook helpers, `logActivity`, and the outreach engine —
  `createSequence`/`addStep`/`enrollContact`/`sendStep`/`handleBounce` + the sender port); domain code
  bucketed per feature above.
- **`packages/auth`** — the self-built auth primitives + `index.ts`.
- **`apps/api`** — `app.ts`, `server.ts`; **`apps/api/middleware`** — `authn.ts`, `tenancy.ts`, `error.ts`,
  `rateLimit.ts`, `idempotency.ts` (Idempotency-Key stored-response replay for money endpoints; the DB
  uniques remain the real double-charge guard).
- **`apps/auth`** — `middleware.ts` + `app/` screens/token endpoints + `shared/` + `lib/` (see JSON).
- **`apps/web/app`** — `layout`, `page`, `import/page` (the wizard route), `auth/callback`;
  **`apps/web/lib`** — `authClient`, `pkce`, `publicConfig`. (The import slice lives under `features/import/`.)
- **`apps/workers`** — `index.ts` (entry + graceful drain), `register.ts` (composition root + the
  `enqueueImport`/`enqueueEnrichment`/`enqueueScoring`/`enqueueDsar`/`enqueueOutreach` producers); each
  queue processor is bucketed to its feature (`import`, `enrichment`, `scoring`, `compliance`, `outreach`).

## Notes / unbucketed

- **`apps/auth/next.config.mjs`** and **`apps/web/next.config.mjs`** appear in `unassigned[]`. These are
  **Next.js-mandated app-root files** (they transpile the workspace packages); they cannot live under
  `apps/<app>/src/`, and the generator only classifies files under `apps/<app>/src/`. A **framework
  constraint, not a placement error**. No code-level violations: `warnings[]` is empty.
