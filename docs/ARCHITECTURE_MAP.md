# TruePoint — Architecture Map

> **Status:** `live` · **Generated from:** [`docs/architecture-map.json`](./architecture-map.json)
> (run `node .claude/hooks/gen-architecture-map.mjs` — or `bun run arch:map` — to refresh). **Paths come
> from the JSON (generated); do not edit paths here by hand.** One-line purposes and the Mermaid graph are
> authored here. Format spec: `enterprise-architecture/reference/navigation-map-spec.md`.

> **Live end-to-end — the customer app, the dedicated auth IdP, the platform-admin console, and the worker
> tier are all real code.** Backend/contract coverage now spans the M0–M5 MVP (auth round-trip · import ·
> reveal & credits · enrichment/verification/scoring · compliance) **plus** M7–M9 (activity timeline +
> engagement scoring, Sales-Nav HITL capture, the suppression-gated outreach send engine), and the later
> waves: **search** (query-semantics core + `SearchPort` + `/search/*` + the Prospect rail, ADR-0035),
> **record customization** (custom fields, tags, pipeline stages — ADR-0028), **saved searches**,
> **account/company search + firmographics**, **bulk enrichment** (match-first `MatchPort`: overlay real +
> master-graph stub, ADR-0037/0038), **bulk contact actions** + **XLSX/template import**, the **M12 email
> subsystem** (per-tenant sending domains + DNS auth, connected mailboxes, send-gate over the M9 engine,
> tracking + deliverability + warmup + governance), the **AI intelligence layer** (NL→`ContactQuery`
> compile with prompt-injection + budget guards, ADR-0023), **webhooks** (HMAC-signed outbound + SSRF
> guard), **feature flags** (global + per-tenant override), **enterprise identity** (SSO config, **SCIM 2.0**
> provisioning — ADR-0019, IP-allowlist/MFA-policy/session-timeout auth hardening — ADR-0018/0040, account
> self-service security UI), and the **`apps/admin` staff console** (tenants · users · staff RBAC ·
> provider budgets · feature flags · audit log · system health · time-boxed audited impersonation —
> ADR-0011/0034).
> **The two-layer data model is the spine** ([ADR-0021](./planning/decisions/ADR-0021-global-master-graph-and-overlay.md)):
> the per-workspace **overlay** (`contacts`/`accounts`, RLS-FORCED) is built; the global **master graph**
> (Layer 0) + its overlay `master_*_id` FKs are designed but **not yet in code** — see the prospect↔company
> initiative in [`docs/planning/prospect-company-data/`](./planning/prospect-company-data/).
> **1275 source files · 73 code-bearing domains · 21 shared areas · 45 domain-vocabulary warnings · 57
> unbucketed** (framework-root configs + undeclared worker queues + repositories whose entity isn't in
> `REPO_DOMAIN`, plus net-new domains not yet in the canonical list — see the generated
> [`architecture-map.json`](./architecture-map.json) `unassigned[]` / `warnings[]` for the current set. Counts
> reflect the merged tree including the parallel `feat/data-mgmt` work; its new domains' prose is owned by that
> track). Design refs: [04](./planning/04-ui-ux-design.md),
> [10-roadmap.md](./planning/10-roadmap.md), [11 §6](./planning/11-information-architecture.md),
> [16 §5](./planning/16-code-organization.md), ADR-0006/0007/0008/0009/0011/0013/0016/0018/0019/0021/0023/0028/0035/0037/0040.

## Repo tree (live)

```
packages/                       # side-effect-free libraries, each exported via one index.ts  [LIVE]
  types/   src/                 # RFC-9457 errors + Zod contracts (leaf): auth, contacts, billing, intel, compliance,
                                #   activity, outreach, home, search, accountsSearch, aiSearch, bulkActions, bulkEnrichment,
                                #   customFields, dataHealth, email, enrichmentPolicy, featureFlags, identityProvisioning,
                                #   importTemplates, listGovernance, pipelineStages, platformAudit, providerConfigs,
                                #   savedSearch, scim, sso, staffAdmin, tags, webhooks (+ drift-guard tests)
  config/  src/env.ts           # zod-validated env (ONLY process.env reader); key-material + origin-allowlist tests
  ui/      src/                 # TruePoint design system: tokens/primitives/theme.css + cn + headless kit + shadcn-pattern ui/*
  db/      src/                 # Drizzle schema + RLS + repositories (the ONLY data access)  [LIVE]
    schema/{auth,contacts,billing,intel,compliance,activity,salesnav,outreach,lists,savedSearches,customFields,
            tags,pipelineStages,email,enrichmentJobs,enrichmentPolicy,importMappingTemplates,featureFlags,
            platformOps,scim,webhooks}.ts  rls/*.sql (one per schema, applied sorted)
    client.ts (withTenantTx · withPrivilegedTx · withPlatformTx · closeDb)  applyMigrations.ts  bootstrapAdmin.ts
    repositories/*.ts (one per entity)   test/*.itest.ts (per-DoD, run in separate processes)
  core/    src/                 # domain logic [LIVE]: import · reveal · billing · compliance · enrichment(+bulk) ·
                                #   data-health · scoring · activity · outreach · email · search · ai · home · prospect ·
                                #   customFields · pipelineStages · savedSearches · webhooks · featureFlags · auth · sales-navigator
  auth/    src/                 # self-built auth primitives (no HTTP): login/mfa/registration/invitations/password(+policy/breach) /
                                #   sso/switchWorkspace + ipBinding/ipAllowlist + sessionTimeout + revocation + auditEvent + log
  search/  src/                 # SearchPort adapters + field projection — inMemorySearchPort (dev/test); OpenSearch/Typesense later
  integrations/ src/            # vendor adapters: enrichment (apollo/zoominfo/clearbit over httpProvider) + anthropic NL-search adapter
apps/                           # deployable processes (thin transport adapters)
  api/   src/                   # Hono on Bun — validates the access JWT; never issues tokens  [LIVE]
    middleware/{authn,tenancy,error,rateLimit,idempotency,requireRole,requireOrgRole,requireStaffRole,platformAdmin}.ts
    features/{auth,workspaces,settings,scim,import,import-mapping-templates,reveal,billing,enrichment,enrichment via jobs,
              scoring,compliance,activity,sales-navigator,outreach,email,home,search,account-search,saved-searches,
              tags,pipeline-stages,custom-fields,contacts-bulk,lists,ai,webhooks,admin}/  app.ts  server.ts  instrumentation.ts
  auth/  src/                   # auth.truepoint.in IdP (Next 15) — screens + /token/* + JWKS + account self-service security  [LIVE]
    app/{login,password,magic,mfa(+enroll),signup,verify,sso,org,workspace,forgot,reset,account/security,token,logout}  shared/*  lib/*
  web/   src/                   # app.truepoint.in (Next 15) — AppShell over a (shell) route group  [LIVE]
    app/(shell)/{home,prospect,sequences,inbox,reports,lists,enrichment/jobs,sales-navigator,settings/*}  app/{import,auth/callback}
    components/{shell/*,PageHeader}  features/{import,prospect,home,sequences,inbox,reports,lists,sales-navigator,
                                              enrichment-jobs,settings-*}/   lib/{authClient,pkce,publicConfig}
  admin/ src/                   # admin.truepoint.in internal staff console (Next 15)  [LIVE — was a target]
    components/shell/{AdminShell,Sidebar,TopBar,navConfig,Brandmark}  components/{ImpersonationBanner,EntityPicker,TenantPicker,UserPicker}  lib/{adminGate,authClient,pkce}
    app/(shell)/{tenants,users,billing,plans,pricing,provider-configs,feature-flags,content,retention,staff,compliance,audit-log,imports,system-health}  features/*
  workers/ src/                 # Bun + BullMQ — imports · enrichment · scoring · dsar · outreach · firmographics ·
                                #   dedup · retentionSweep · sequenceTick · tokenRefresh queues + leaderLock +
                                #   mailboxThrottle (Redis token-bucket) + health/logger  [LIVE]
```

## FEATURE → FILES index (live)

> One subsection per code-bearing domain (54). Paths are authoritative in
> [`architecture-map.json`](./architecture-map.json); the purposes are here. Web slices are
> **destination-keyed** (prospect/sequences/settings-\*), api/core/db are **resource-keyed** (reveal/email/admin)
> — a file has exactly one home; the [Destinations](#destinations-cross-reference) section is where the cross-links live.

### A. Data ingestion, identity & enrichment

#### import — *M1 + XLSX/template/preview expansion* ([05 §3](./planning/05-features-modules.md), ADR-0036)
- **core:** `packages/core/src/import/` — `runImport.ts` (parse→map→normalize→dedup-upsert→provenance),
  `parseFile.ts` (RFC-4180 CSV) + `parseXlsx.ts` (XLSX with ZIP-magic + formula-injection guard + 100K-row/25 MiB caps),
  `columnMap.ts`, `validateRow.ts` (pure per-row verdict, reused by preview + run), `preview.ts` (valid/rejected/duplicate
  counts + bounded sample), `rejectedRowsCsv.ts`, `templates.ts` (save/load reusable column mappings), `normalize.ts`,
  `blindIndex.ts` (HMAC dedup key), `encryptPii.ts` (AES-GCM, KMS-swappable), `contentHash.ts`
- **db:** `sourceImportRepository.ts` (per-import provenance + content-hash skip); `importMappingTemplateRepository.ts`
- **api:** `features/import/` (POST `/imports` → `202` + `jobId`; preview; `queue.ts` BullMQ producer) ·
  `features/import-mapping-templates/` (mapping-template CRUD) · **workers:** `queues/imports.ts`
- **web:** `features/import/` — `ImportWizard` (file→map→preview→confirm), `ContactsTable`, `importJob.ts` (poll→UI state), `rejectedRowsCsv.ts`

#### enrichment — *M4 provider waterfall + bulk match-first* ([06](./planning/06-enrichment-engine.md), ADR-0037/0038)
- **core:** `enrichment/` — `providerPort.ts` (the 06 §3 contract; core OWNS the port), `waterfall.ts` (trust÷cost
  ordering + per-provider breaker), `enrichContact.ts` (cache-first → budget breaker → waterfall → overlay upsert + cost row),
  `requestHash.ts`, `policy.ts` (auto-enrich guard: trigger + field-allowlist + budget), `jobStatus.ts` (read-only job DTOs)
- **core (bulk, ADR-0037):** `enrichment/bulk/` — `matchPort.ts` (the `MatchPort` seam; injects a CandidateFinder, never
  imports db), `overlayMatcher.ts` (real Layer-1 matcher: deterministic ladder → fuzzy_name_company → review/unmatched),
  `masterGraphMatcher.ts` (Layer-0 **stub** until the Citus/OpenSearch/Spark candidate index lands), `estimate.ts`
  (pre-flight cost forecast: sample → extrapolate charged rows × hit rate, a range never a guarantee)
- **integrations:** `enrichment/{httpProvider,providers}.ts` (Apollo/ZoomInfo/Clearbit VendorSpecs over one HTTP shape; injectable fetch)
- **db:** `providerCallRepository.ts` (cache + cost ledger); `enrichmentJobRepository.ts`, `enrichmentPolicyRepository.ts`
  (*both unassigned — entity not in `REPO_DOMAIN`*) · **api:** `features/enrichment/*` · **workers:** `queues/enrichment.ts`

#### enrichment-jobs — *bulk enrichment job UI* (web; ADR-0039)
- **web:** `features/enrichment-jobs/` — `EnrichmentJobsPage` + `JobDetailDrawer` over `useEnrichmentJobs`/`useEnrichmentJobDetail`;
  GET-only surface (read the per-job ledger; the surface never mutates). Routed at `(shell)/enrichment/jobs`.

#### data-health — *M4 verification + data-quality score + freshness re-verification* ([06 §9](./planning/06-enrichment-engine.md), ADR-0013/0025)
- **core:** `data-health/` — `emailVerifier.ts` (verifier port; passthrough + fixture + `hybridVerifier`),
  `reacherVerifier.ts` (Reacher adapter + `defaultEmailVerifier` config-gated factory; injectable fetch),
  `emailPrescreen.ts` (`localPrescreenVerifier` — zero-network role/disposable short-circuit wrapped around the verifier to skip paid probes),
  `reverifyContacts.ts` (`runReverification` — re-grade revealed, past-SLA contacts via the configured verifier),
  `validatePhone.ts` (E.164), `phoneVerifier.ts` (phone verifier port + format-only default),
  `twilioPhoneVerifier.ts` (Twilio Lookup adapter + `defaultPhoneVerifier` config-gated factory; carrier-confirmed valid/invalid),
  `chargeFor.ts` (ADR-0013 charge-by-verified-result), `dataQualityScore.ts`
  (the 0.4·completeness + 0.3·verification + 0.3·freshness formula; cold-start rules for imports),
  `dataQualitySummary.ts` (`buildDataQualitySummary` — the per-workspace fill/verification/freshness count rollup the Data Health dashboard reads),
  `dataQualitySnapshot.ts` (`captureDataQualitySnapshot` — persists a daily WorkspaceDataQuality trend point)
- **workers:** `reverification.ts` (per-workspace re-verification job), `reverificationSweep.ts` (leader-locked
  daily fan-out enqueuing a per-workspace re-verification for every workspace with stale revealed contacts),
  `dataQualitySnapshotSweep.ts` (leader-locked daily capture of a per-workspace Data Health trend point)
- **db:** `verification_jobs` (the re-verification audit ledger — one row per completed run, workspace-scoped RLS;
  `verificationJobRepository` record/listRecent; migration 0022) — written by `runReverification` (PLAN_06);
  `data_quality_snapshots` (the Data Health TREND store — `dataQualitySnapshotRepository`; migration 0023)

#### reveal — *M1 masked reads + M3 money loop* ([07 §3](./planning/07-billing-credits.md), ADR-0007)
- **core:** `reveal/revealContact.ts` — the monetized tx: in-tx suppression gate → idempotent claim (unique
  `(workspace, contact, reveal_type)`) → `FOR UPDATE` charge against `tenants.reveal_credit_balance` → same-tx audit
- **db:** `{account,contact}Repository.ts` (overlay reads/writes, masked list); `revealRepository.ts` (claim + usage)
- **api:** `features/reveal/*` (masked `/contacts` list; POST `/contacts/:id/reveal` behind Idempotency-Key replay)

### B. Prospect & account data surface

#### prospect — *the find-anyone destination (contacts + accounts)* ([05](./planning/05-features-modules.md), ADR-0035)
- **core:** `prospect/` — `dedup.ts` (per-workspace soft-pointer dedup: canonicalName + registrableDomain grouping),
  `accountSearch.ts` (workspace-visible account result count), `firmographics.ts` (roll intent_signals → account facets:
  technologies from tech_install slugs, fundingStage from latest funding_round), `bulkActions.ts` (batch apply to
  workspace-visible ids + audit), `tags.ts`, `lists.ts`
- **web:** `features/prospect/` — masked grid + `RecordDetail`/`QuickViewDrawer` slide-overs + `RevealDialog`; **bulk
  reveal** (`useBulkSelection`, `BulkActionBar`, `BulkRevealDialog`, pure `bulkReveal.ts` policy: stop on 402 / skip 403);
  **filter rail** (`FilterRail` + `FacetTypeahead` over `searchApi.ts`); **AI search** (`AiSearchBox` + `ParsedFilterPreview`);
  **accounts** (`AccountsTable`/`AccountFilterPanel`/`AccountDetailDrawer` over `accountSearchApi.ts`); **stages/tags**
  (`StageSelector`/`StageManagementPanel`, `TagChip`/`TagPicker`/`tagColors`); `export.ts` (masked CSV, no PII);
  `searchUrlState.ts` (shareable/bookmarkable query); `savedSearchApi.ts` + `RecentSearches`/`SaveSearchPanel`; routed at `(shell)/prospect`

#### account-search — *company-side search/facets API* (ADR-0035)
- **api:** `features/account-search/*` — `GET` account search / facets / typeahead (firmographic facets: industry,
  technologies, employee_band, funding). Backed by `accountSearchRepository.ts` (*unassigned repo*).

#### scoring — *M4 model + M8 engagement* ([ADR-0008](./planning/decisions/ADR-0008-lead-scoring-model.md))
- **core:** `scoring/computeScore.ts` (ICP fit + intent + engagement → versioned `scores` row; trigger syncs `contacts.priority_score`)
- **db:** `{score,intentSignal}Repository.ts` · **api:** `features/scoring/*` · **workers:** `queues/scoring.ts`

#### activity — *M8 timeline* ([03 §7](./planning/03-database-design.md))
- **core:** `activity/logActivity.ts` (tombstone-aware append, one tx) · **db:** `activityRepository.ts` (+ `last_activity_at` trigger)
- **api:** `features/activity/*` (GET/POST `/contacts/:id/activities`)

#### sales-navigator — *M7 HITL link capture* (ADR-0009)
- **core:** `sales-navigator/{captureLink,parseLink}.ts` · **db:** `salesNavLinkRepository.ts` (dedup on workspace+url)
- **api:** `features/sales-navigator/*` · **web:** `features/sales-navigator/` (`CaptureForm` + `LinksTable`; a human pastes the link)

#### lists — *static prospect lists + bulk add-to-list* ([list-plan](./planning/list-plan/00-overview.md))
- **db:** `listRepository.ts` (owner-gated mutations; `visibleContactIds` cross-workspace guard); `schema/lists.ts` (`lists`/`list_members`)
- **api:** `features/lists/*` · **web:** `features/lists/` (`ListsPage`/`ListDetailPage`/`ListFormDialog`/`ImportIntoListDialog`); `(shell)/lists`

#### tags — *cross-list record labels* (ADR-0028)
- **core:** `prospect/tags.ts` (case-insensitive per-workspace name uniqueness) · **db:** `tagRepository.ts` (*unassigned*),
  `schema/tags.ts` (`tags` + `record_tags`; color is a brand-palette KEY, not hex) · **api:** `features/tags/*`

#### pipeline-stages — *workspace deal stages mapped to outreach_status* (ADR-0028)
- **core:** `pipelineStages/manageStages.ts` (one-to-one map to the canonical `outreach_status`; at-most-one default)
- **db:** `pipelineStageRepository.ts` (*unassigned*), `schema/pipelineStages.ts` (`maps_to_status` CHECK mirrors the enum)
- **api:** `features/pipeline-stages/*` · **web:** in `features/prospect/` (`StageManagementPanel`/`StageSelector`/`stagesApi`)

#### custom-fields / customFields — *typed record customization (jsonb, not EAV)* (ADR-0028)
- **core:** `customFields/` — `manageDefinitions.ts` (immutable key/entity/type), `setValues.ts` (validate + merge into jsonb),
  `validateValue.ts` (pure per-type validation, reused by import) · **db:** `customFieldRepository.ts` (*unassigned*),
  `schema/customFields.ts` (`custom_field_definitions` + `custom_fields` jsonb on contacts/accounts)
- **api:** `features/custom-fields/*` · **web:** `features/settings-custom-fields/` (`CustomFieldsPanel`)

#### saved-searches / savedSearches — *persisted ContactQuery filters* (M8, ADR-0035)
- **core:** `savedSearches/savedSearches.ts` (thin; most logic in db) · **db:** `savedSearchRepository.ts` (*unassigned*),
  `schema/savedSearches.ts` (filters as jsonb ContactQuery, re-run never SQL-parsed; visibility private/workspace)
- **api:** `features/saved-searches/*` · **web:** in `features/prospect/` (`savedSearchApi`/`SaveSearchPanel`/`RecentSearches`)

#### contacts-bulk — *batch actions on search results* (ADR-0036)
- **api:** `features/contacts-bulk/*` — bulk tag/owner/status/archive/enroll/add-to-list/enrich/reveal over
  workspace-visible ids (core logic in `prospect/bulkActions.ts`; audited per closed enum) · **web:** `prospect/bulkActionsApi.ts` + `BulkActionBar`

### C. Outreach & email

#### outreach — *M9 sequences + the suppression-gated send engine* ([08 §3/§6](./planning/08-compliance.md), ADR-0009/0013)
- **core:** `outreach/` — `createSequence.ts`, `enrollContact.ts` (revealed-only + `assertNotSuppressed` in-tx + idempotent),
  `sendStep.ts` (the compliance-critical send tx: CAN-SPAM identity BLOCKED-not-warned, suppression re-checked, footer
  appended, audit), `handleBounce.ts` (replay-idempotent + auto-suppress + ADR-0013 credit-back), `senderPort.ts`
  (`EmailSenderPort`: dev console + test static; the M12 dispatch swaps the port without touching the send tx)
- **db:** `{sequence,outreachLog}Repository.ts`; `schema/outreach.ts` (sequences→steps→log; unique (sequence,contact) = enrollment idempotency)
- **api:** `features/outreach/*` · **workers:** `queues/outreach.ts`

#### sequences — *outreach builder + enrollment + send UI* (web; ADR-0009)
- **web:** `features/sequences/` — `SequenceList`/`SequenceBuilder` (CAN-SPAM identity up front), `EnrollmentPanel` +
  `EnrollmentLogTable`, `DraftReviewPanel`, `SendStatusDashboard`, `TemplatesPanel`; `(shell)/sequences`

#### email — *M12 email subsystem (sending domains, mailboxes, send-gate, tracking, deliverability)* ([14](./planning/14-phase-1-execution.md), email-planning)
- **core:** `email/` — `sendingDomains.ts` (create + DNS-verify SPF/DKIM/DMARC per-tenant domains) + `dnsAuth.ts`
  (verify against an injected DnsResolverPort), `connectMailbox.ts` (workspace mailbox + KMS-envelope-encrypted credential)
  + `secretStore.ts` (AES-256-GCM versioned envelope), `resolveSendingIdentity.ts` (own mailbox + verified domain or refuse),
  `dispatchOutreachSend.ts` (P1 send-gate: verify identity + consume tenant send-quota in tx + per-mailbox
  rate-throttle check, then M9 `sendStep` unchanged; a throttle denial refunds the quota and defers the send),
  `providerAdapter.ts` (ESP adapter seam — **dark default `consoleSender`, no network until an SES/Google/SMTP adapter is wired**),
  `templates.ts` + `renderTemplate.ts` (**P2 editor:** versioned owner-scoped templates — create/update +
  `getTemplate`/`listTemplateVersions`/`restoreVersion` (immutable append-only versions) + keyset-paginated
  `listTemplates` + `previewTemplate` (server-side safe render: HTML-escaped single-pass `{{merge}}`, canonical
  `allowedKeys` whitelist); D8 owner-only edits, IDOR→404),
  `sequenceScheduler.ts` (leader-locked tick: claim due enrollments `FOR UPDATE SKIP LOCKED`), `trackingToken.ts`
  (signed opaque open-pixel/click token), `ingestTrackingEvent.ts` (idempotent event → projects open/click to activities),
  `deliveryWebhook.ts` (HMAC-verified ESP webhook → delivery/bounce/complaint), `deliverabilityAnalytics.ts`
  (workspace aggregates; reply-rate primary, opens MPP-inflated), `warmup.ts` (deterministic ramp curve), `governance.ts`
  (staff-only global suppression + per-tenant send-quota); **P1 OAuth + Gmail send (new):** `signingKeys.ts` (P0
  per-tenant webhook/tracking key derivation — closes the global-secret forgery), `pkce.ts` + `oauthProvider.ts`
  (provider-agnostic connect seam + registry + injectable HTTP port) + `googleOAuth.ts` (Gmail OAuth:
  authorize/exchange/refresh/revoke/identity; scopes `gmail.send`+`gmail.readonly`), `mailboxConnectFlow.ts`
  (start/complete connect handshake — single-use state, send-scope-downgrade reject, encrypted token vault),
  `gmailSend.ts` + `mimeMessage.ts` (Gmail `messages.send` adapter realizing the M9 `EmailSenderPort`: RFC 5322
  build + stable Message-ID threading key + CR/LF header-injection guard), `mailboxTokenProvider.ts`
  (send-time token loader — the D7-sanctioned server-side credential read-back: decrypt + proactive-refresh +
  rotate, `invalid_grant`→`reauth_required`), `registerProviders.ts` (`registerEmailProviders` — wires the
  OAuth provider + Gmail send adapter at api/worker boot; `resolveSender` falls back to dark `consoleSender`
  until then), `recordOutboundMessage.ts` (best-effort, post-`sendStep`: find-or-create the conversation thread +
  persist the outbound `email_message` w/ the rfc822 Message-ID — never fails a sent email; outbound rows store
  the tenant's own from-address, recipient via `contact_id`); **per-mailbox throttle + token refresh (new):**
  `tokenBucket.ts` (pure refill-then-consume token-bucket algorithm) + `mailboxThrottle.ts` (the
  `MailboxThrottlePort` seam + `allowAllThrottle` default + `MailboxThrottledError`), `refreshDueMailboxTokens.ts`
  (the leader-locked sweep body: owner-connection id-only scan of mailboxes near expiry → per-mailbox
  tenant-scoped refresh, each failure isolated)
- **db:** `schema/email.ts` (`sending_domain` TENANT-scoped + globally unique; `mailbox_integration` WORKSPACE-scoped +
  encrypted credential **+ P1 OAuth token-lifecycle cols** `oauth_expires_at`/`oauth_scopes`/`provider_account_id`/
  `reauth_required`/`reauth_reason`; `oauth_connect_state` **(new, P1)** short-lived CSRF+PKCE handshake, RLS
  ENABLE-not-FORCE for the session-less callback; `email_thread`+`email_message` **(new, P1/P3)** the conversation +
  per-message store — workspace+owner-scoped (D8), encrypted body (D7), `rfc822_message_id` reply-threading key;
  `email_event` firehose **+ `reply`/`auto_reply` event types**; `outreach_log.last_reply_at` cache) + migrations
  `0020_new_patriot`/`0021_far_blob` (additive); repos `mailboxRepository`/`sendingDomainRepository`/
  `emailEventRepository`/`emailTemplateRepository`/`emailAnalyticsRepository`/`sendQuotaRepository`/
  `oauthConnectStateRepository`/`emailThreadRepository`/`emailMessageRepository` (*all unassigned*)
- **api:** `features/email/` — `routes.ts` (mailboxes **+ `POST /mailboxes/connect/start`**, sending-domains, verify,
  reports), `templateRoutes.ts` (**P2: GET `/`(paginated)·`/:id`·`/:id/versions` + POST `/`·`/:id/preview`·`/:id/restore` + PATCH `/:id`**),
  `webhookRoutes.ts` (PUBLIC session-less: ESP delivery webhook + open-pixel +
  click-redirect), `connectRoutes.ts` **(new, P1: PUBLIC session-less OAuth `connect/callback`)**, `oauthProviders.ts`
  (side-effect provider registration from env)
- **workers:** `queues/outreach.ts` (real-send path: flag-gated `dispatchOutreachSend`, `MailboxThrottledError`
  → clamped re-enqueue, never a double-send) + `queues/tokenRefresh.ts` (leader-locked `email_token_refresh`
  repeatable sweep, every 2 min) + `mailboxThrottle.ts` (Redis atomic-Lua token-bucket adapter realizing
  `MailboxThrottlePort`, keyed `email:throttle:{mailboxId}`); both wired in `register.ts`
- **web:** `features/settings-mailboxes/` (connect mailbox + sending-domain DNS records + send-quota) + `features/settings-enrichment/` (auto-enrich policy)

#### inbox — *M9 unified replies + tasks* (web)
- **web:** `features/inbox/` — `ThreadList` + `ThreadView` over `useInbox`, `TasksPanel` over `useTasks`; `(shell)/inbox`

### D. Intelligence & reporting

#### search — *query-semantics core + SearchPort + `/search/*` + Prospect rail* ([24](./planning/24-advanced-search-exploration-ux.md), ADR-0035)
- **core:** `search/` — `normalizeTitle.ts` (freetext → stable key: "CEO" ≡ "Chief Executive Officer"), `canonicalizeTitle.ts`,
  `expandQuery.ts` + `expandTitleFilters.ts` (synonym sets), `titleTaxonomy.ts` (seed taxonomy; prod backfilled from O*NET/ESCO),
  `planTitleFilter.ts` (selected values → an engine-agnostic match plan)
- **search (pkg):** `fields.ts` (project rows → searchable facets), `inMemorySearchPort.ts` (dev/test adapter proving the
  contract: term filters, free-text, suggest, facet counts, keyset paging) · **types:** `search.ts` (the `SearchPort` contract)
- **api:** `features/search/` — `routes.ts` (`/search/{contacts,suggest,facets}`), `searchPortProvider.ts` (wires the active port)

#### ai — *NL→ContactQuery compile with guards* (M14, ADR-0023)
- **core:** `ai/` — `aiPort.ts` (the `parseSearchQuery` contract; core owns the port), `compileSearchQuery.ts`
  (inject-guard → budget-reserve → port → re-validate against `contactQuery` schema), `promptGuard.ts` (`sanitizeNlQuery` +
  cheap `looksLikeInjection` no-spend gate), `budgetGuard.ts` (per-tenant daily ceiling, reserve-before-call + refund-on-failure)
- **integrations:** `anthropic/nlSearchAdapter.ts` (the provider adapter behind the port)
- **api:** `features/ai/` — POST `/ai-search` (returns a validated `query` + notes; human confirms before applying), `aiPortProvider.ts`
- **metering (M14 / 13a Area 14):** `ai_requests` table (mig 0039 + rls/aiRequests.sql) + `aiRequestRepository` (append + `usageSince` platform rollup); `/ai-search` logs each call best-effort (task/model/outcome/latency/tokens — NL text never stored; the Anthropic adapter surfaces `usage`) · **types:** `aiUsage.ts` (`aiRequestOutcome`). Staff `GET /admin/ai-usage` (audited `admin.ai_usage`, coarse-gated) + admin `ai-usage` cockpit (window + per-tenant table).

#### home — *the cockpit destination* (web + api + core)
- **core:** `home/buildHomeSummary.ts` (fan-out over domain repos in one `withTenantTx`) + `data-health/dataQualitySummary.ts`/`dataQualitySnapshot.ts` · **api:** `features/home/*` (GET `/home/summary`, `/home/data-quality`, `/data-quality/history`, `/data-quality/reverification-runs`)
- **web:** `features/home/` — KPI tiles + cards (recent reveals, hot leads, **data health** + freshness trend, burn sparkline, imports, enrichment, sequence
  snapshot, activity feed) + `QuickActionsRow`/`TasksCard`/`RepliesCard`; `(shell)/home`

#### reports — *client rollups + XLSX export* (web)
- **web:** `features/reports/` — `rollups.ts` over `/credits/*` + `/contacts`; sections (CreditUsage, Funnel, DataHealth,
  Deliverability, Intent, LeadScore, TeamActivity); `charts/` (Bar/Line/Distribution/Funnel); `export/` (dependency-free
  OOXML `xlsxWriter` + `exportData` + `downloadXlsx`); `(shell)/reports`

### E. Identity, access, billing & developer

#### auth — *M2 global identity + ADR-0040 hardening* ([17](./planning/17-authentication.md), ADR-0019/0020/0040)
- **api:** `features/auth/*` (GET `/auth/session` incl. live workspace role); RBAC middleware
  `{requireRole,requireOrgRole,requireStaffRole,platformAdmin}.ts` (workspace / org / platform tiers)
- **core:** `auth/members.ts` (workspace member lifecycle: invite/change-role/remove, owner non-removable, audited),
  `auth/adminSessions.ts` (list/revoke member sessions, force-reauth) · **db:** `userRepository.ts`
- **shared primitives:** `packages/auth/*` — login (`identifierLookup`/`login`/`loginTransaction`/`flow` + `scopeGuard`),
  `botCheck`/`rateLimit`/`policy`, **registration** (`registration`/`emailVerification`/`signupTransaction`), **invitations**,
  **password** (`password` + `passwordPolicy` NIST 800-63B + `breachCheck` HIBP k-anonymity + `passwordReset`/`refresh`),
  **MFA** (`mfa`/`mfaVerify`), **SSO** (`sso/{types,providers,mockIdp,jit}` + `ssoTransaction`), **switch** (`switchWorkspace`/`switchOrg`),
  **session hardening** (`revocation` deny-list, `findActiveSessionOrDetectReuse`, `sessionTimeout` policy cap — ADR-0018/0040),
  **client-IP** (`ipBinding` token-exchange binding + `ipAllowlist` CIDR tenant gate), `auditEvent` (tenant + platform audit), `log`
- **IdP origin:** `apps/auth/*` — screens (sign-in/signup/verify/sso/forgot/reset/magic/org/workspace) + **account self-service
  security** (`app/account/security/` PasswordSection/MfaSection/SessionsSection/HistorySection + `actions`/`data`/`status`/`stepUp`
  re-auth gate + one-time `enrollCookie`; `app/mfa/enroll/`) + `/token/*` + JWKS + `instrumentation`/`bootSelfTest`; `lib/*`
  (cookies, cors, mailer, `authFailure`, `domainResolver`, `finishLogin`, `requireUser`, `completeMagic`/`completeSso`, `emails/*`)

#### workspaces — *M2 + member/session admin* ([05 §2](./planning/05-features-modules.md))
- **api:** `features/workspaces/` — `routes.ts` (`GET /workspaces` for the switcher), `memberRoutes.ts` (list/invite/
  change-role/remove, RLS-scoped + re-verified), `sessionRoutes.ts` (member sessions: revoke / force-reauth-all)
- **db:** `workspaceRepository.ts` (RLS-scoped workspaces + role + tenant-membership/domain/invitation + new-org provisioning)
- **web:** `features/settings-workspace/` (`WorkspaceGeneralPanel` + `MembersPanel` + `SessionsPanel`)

#### settings — *tenant identity / SSO config API*
- **api:** `features/settings/` — `routes.ts`, `identityRoutes.ts` (domain claim/verify for SSO routing + SCIM token
  mint/list/revoke, plaintext shown once), `ssoRoutes.ts` (SAML/OIDC config upsert; OIDC secret write-only, encrypted)
- **db:** `domainRepository`/`ssoConfigRepository`/`authPolicyRepository`/`scimTokenRepository` (*all unassigned*)

#### scim — *SCIM 2.0 provisioning* (ADR-0019; RFC 7643/7644)
- **api:** `features/scim/` — `index.ts` (mounts `/scim/v2`), `scimAuth.ts` (bearer-token middleware → resolves tenant,
  gates every route), `scimService.ts` (provision/deprovision/read; ADR-0019 global-identity ↔ SCIM mapping; idempotent +
  session revocation + bounded stale-access window), `userRoutes.ts` (/Users list/get/post/put/patch/delete; Zod + tenancy
  from the token, never the body), `scimError.ts` (RFC 7644 error envelope — never RFC-9457 on this surface)
- **types:** `scim.ts` (the wire contract) · **db:** `schema/scim.ts` (`scim_tokens` — hash only; tenant-scoped)

#### billing — *M3 credits + Stripe; the plans-pricing-credits self-serve slice* ([07 §2/§4](./planning/07-billing-credits.md), [plans-pricing-credits/05](./planning/plans-pricing-credits/05_Implementation_Roadmap.md), ADR-0012)
- **core:** `billing/stripeWebhook.ts` (HMAC verify) + `grantFromStripe.ts` (grant once per `stripe_event_id`)
- **db:** `creditRepository.ts` (lock/decrement counter), `idempotencyRepository.ts`, `revealRepository.ts` (usage keyset/filter/CSV reads), `tenantRepository.getBillingProfile` (plan envelope), `planTemplateRepository` (+`trial_bonus_credits`, mig 0037); `client.withPlatformReadTx` (non-auditing owner catalog read)
- **api:** `features/billing/*` (signature-verified webhook + `/credits/{balance,usage,me}`), `features/pricing/*` (**PUBLIC** unauth `/pricing/{credit-packs,plans}` — ADR-0012 transparent pricing)
- **web:** `features/settings-billing/` (the tabbed billing **hub**: Plan/Credits/Usage + defer-honest Invoices/Subscription), `features/public-pricing/` + `app/(public)/pricing` (the unauth pricing page), `lib/useSessionRole.ts` (OD-8 workspace-admin gate)
- **admin:** `features/tenants/` per-tenant economics panel (`TenantEconomics` over `GET /admin/tenants/:id/economics`) + refund-reason taxonomy + plan-template `trial_bonus_credits` field; `features/billing/` economics rollup + `EconomicsTrend` revenue sparkline (`/economics/trend`); `features/{plans,pricing}/` catalog CRUD
- **workers:** `lowBalanceNotifierSweep.ts` (dark, read-only low-balance detector — env-gated off)
- **types:** `pricing.ts` (public catalog + plan envelope), `billing.ts` (+usage page/query/`dataSource`), `planTemplateAdmin.ts` (+`trialBonusCredits`)
- *(generator flags two net-new domains — `pricing` (api) + `public-pricing` (web) — distinct commercial concerns not yet in the canonical list; folded here for readability)*

#### notifications — *in-app feed (G-NTF-1); LIVE end-to-end*
- **db:** `schema/notifications.ts` (`notifications` table — workspace/user-scoped, `read_at`; mig 0038 + rls/notifications.sql),
  `notificationRepository.ts` (create/listForUser keyset/unreadCount/existsUnreadOfType/markRead/markAllRead — RLS bounds the workspace, repo enforces per-user)
- **api:** `features/notifications/*` (`GET /notifications` feed+unreadCount · `/unread-count` · `POST /:id/read` · `/read-all`)
- **web:** shell `NotificationsBell` + `useNotifications` (real feed, poll, mark-read/mark-all) + `features/notifications` history page (`(shell)/notifications`, keyset paging + per-item mark-read) · **types:** `notifications.ts`
- **producers:** welcome-on-signup (`workspaceRepository.provisionNewOrg`) + low-credits (`workers/lowBalanceNotifierSweep`, deduped, dark-gated). Follow-ups: import-complete, reply-received.

#### compliance — *M3 gate + audit; M5 DSAR/consent* ([08](./planning/08-compliance.md), ADR-0011)
- **core:** `compliance/` — `assertNotSuppressed.ts` (unbypassable in-tx DNC gate), `writeAudit.ts` (same-tx append),
  `dsarIntake.ts`, `deleteFanout.ts` (erase-everywhere: tombstone every copy → purge dependents → GLOBAL suppression →
  per-copy audit → verification scan), `assembleAccessReport.ts`, `consent.ts` (record + withdraw → auto global suppression)
- **db:** `{suppression,audit,consent,dsar}Repository.ts`; `client.ts` `withPrivilegedTx`/`withPlatformTx` (the sanctioned
  cross-workspace `leadwolf_admin` paths) · **api:** `features/compliance/*` (public session-less `/compliance/dsar`) ·
  **workers:** `queues/dsar.ts` (privileged, VERIFIED only) · **web:** `features/settings-compliance/` (`SuppressionForm`/`SuppressionList`/`DsarForm`)

#### webhooks — *outbound event delivery* (M10)
- **core:** `webhooks/` — `dispatch.ts` (deliver + retry), `sign.ts` (HMAC payload signature), `ssrfGuard.ts` (block
  internal/metadata targets), `webhooks.ts` (subscription logic) · **db:** `webhookRepository.ts` (*unassigned*),
  `schema/webhooks.ts` (`webhook_subscriptions` + `webhook_deliveries`; secret encrypted, recoverable for replay)
- **api:** `features/webhooks/*` (subscribe/list/delete + replay/self-test) · **web:** `features/settings-developer/` (`WebhooksPanel`)

#### featureFlags — *global flags + per-tenant override* (ADR-0011)
- **core:** `featureFlags/` — `evaluateFlag.ts` (pure precedence: tenant override > global > default > **OFF/unknown**),
  `flagsForTenant.ts` · **db:** `featureFlagRepository.ts` (*unassigned*), `schema/featureFlags.ts` (`feature_flags` global +
  `tenant_feature_flags` override) · **admin UI:** see `feature-flags` below

### F. Platform-admin (`apps/admin` console + admin API)

> The internal staff console at `admin.truepoint.in`. Gated two ways: PKCE auth **and** a platform-admin probe of the API
> (the API gate is the source of truth, never a client flag). Every cross-tenant action runs under `withPlatformTx`
> (owner role, RLS bypass, immutable `platform_audit_log` write). ADR-0011/0034.

#### admin — *platform-admin API surface* ([13](./planning/13-platform-admin.md), ADR-0011/0032)
- **api:** `features/admin/` — `routes.ts` (`/workspaces`, `/users`, `/tenants`, `/tenants/:id`), `auditLog.ts` (GET
  `/audit-log`, itself audited), `impersonation.ts` (start w/ reason + end + active; time-boxed, banner-flagged),
  `providerConfigs.ts` (toggle + monthly budget), `staff.ts` (grant/revoke staff roles)
- **db:** `platformAdminReads.ts` + `platformAuditReads.ts` (bounded reads); `impersonationRepository`/`platformStaffRepository`/
  `providerConfigRepository`/`staffRepository` (*unassigned*); `schema/platformOps.ts` (`impersonation_sessions`) + `platformStaff`
  in `schema/auth.ts` (deny-all to app role); `platform_audit_log` (raw table, `rls/platform.sql`, owner-insert only)

#### apps/admin shell + features (web)
- **shell/lib:** `components/shell/` (`AdminShell` two-stage gate, `Sidebar`/`TopBar`/`navConfig`/`Brandmark`),
  `ImpersonationBanner` (polls `/admin/impersonation/active`), `EntityPicker` + `TenantPicker`/`UserPicker` presets (async typeahead over `/admin/{tenants,users}?search=`, replaces raw-UUID entry), `lib/` (`adminGate` API probe, `authClient`, `pkce`, `publicConfig`)
- **tenants** — directory (plan/status/seats/credits) + detail (workspaces/members/usage; plan overrides, suspend, credit grants)
- **users** — cross-tenant user search; deactivate; reset MFA / force reset; revoke sessions
- **staff** — grant/revoke platform staff roles (super_admin/support/billing_ops/compliance_officer/read_only)
- **provider-configs** — enrichment provider enable/disable + monthly budget + rate-limit (mtd spend masked)
- **feature-flags** — create/list/toggle global flags + per-tenant overrides (`NewFlagDialog`/`OverrideDialog`)
- **audit-log** — read-only append-only privileged-action log viewer
- **system-health** — service indicators (ECS/Aurora/Redis/Typesense/OpenSearch) + queue depth + worker status

### G. Web settings scopes (`apps/web/src/features/settings-*`)
The `(shell)/settings/*` routes mount a two-column `SettingsScopeLayout` (scope nav + panel) driven by `navConfig`.
- **settings-shell** — `SettingsScopeLayout` + `SettingsNav` + `SettingsPlaceholder` (the chrome for all scopes)
- **settings-user** (User) — `ProfilePanel`, `NotificationsPanel`, `SecurityPanel` (status map deep-linking to the auth-origin account-security flows)
- **settings-workspace** (Workspace) — `WorkspaceGeneralPanel`, `MembersPanel`, `SessionsPanel`
- **settings-tenant** (Tenant/Org) — `OrganizationPanel`, `IdentityPanel` (domains + SCIM tokens), `SsoConfigPanel`,
  `SecurityAccessPanel` (MFA enforcement / allowed methods / enforce-SSO / session timeout / IP allowlist), `AuthAuditList`
- **settings-developer** (Developer) — `ApiKeysPanel`/`OAuthAppsPanel`/`WebhooksPanel`/`ApiDocsPanel`
- **settings-billing** — `BillingPage` + `UsageTable` · **settings-compliance** — `SuppressionForm`/`SuppressionList`/`DsarForm`
- **settings-custom-fields** — `CustomFieldsPanel` · **settings-enrichment** — `AutoEnrichPanel` · **settings-mailboxes** — mailbox + sending-domain + send-quota config

## Destinations cross-reference (web destinations → domains)

> From [11 §6](./planning/11-information-architecture.md) + the implemented `navConfig`. The index never cross-lists a file;
> this is where a destination's surfaced resource-domains are noted (the reveal domain's API is `features.reveal.api`; its UI lives under Prospect).

| Destination | Surfaces domains | Route |
|---|---|---|
| **Home** | home, notifications | `(shell)/home` |
| **Prospect** | reveal, import, search, account-search, ai, lists, tags, pipeline-stages, custom-fields, saved-searches, enrichment, scoring, contacts-bulk | `(shell)/prospect` |
| **Sequences** | outreach, email, templates | `(shell)/sequences` |
| **Inbox** | inbox | `(shell)/inbox` |
| **Reports** | reports, data-health | `(shell)/reports` |
| **Lists** | lists | `(shell)/lists` |
| **Enrichment jobs** | enrichment-jobs | `(shell)/enrichment/jobs` |
| **Settings** | settings (identity/SSO), workspaces (members/sessions), billing, compliance, webhooks/api-public, custom-fields, enrichment, email/mailboxes, **auth** | `(shell)/settings/*` |
| **(auth origin)** | auth | `auth.truepoint.in/{login,password,magic,mfa,signup,verify,sso,org,workspace,account/security,token/*,.well-known/jwks.json}` |
| **(admin origin)** | admin, tenants, users, staff, provider-configs, feature-flags, audit-log, system-health | `admin.truepoint.in/(shell)/*` |

## DEPENDENCY section (which packages depend on which)

From [`architecture-map.json`](./architecture-map.json) `dependencies` (the **allowed** graph, [16 §5](./planning/16-code-organization.md)):

- `types` — leaf. `config` → `types`. `ui` → `types`. `db` → `types`, `config`. `search` → `types`, `config`.
  `email` → `types`, `config` *(allowed seam; the email logic currently lives in `packages/core/src/email`, not a separate package)*.
  `analytics`/`observability` → `types`, `config`.
- `core` → `db`, `search`, `types`, `config` *(declares ports — enrichment/sender/SearchPort/AiPort/MatchPort — never imports `integrations`)*.
  `auth` → `db`, `types`, `config`. `integrations` → `core`, `types`, `config`.
- `apps/api` → `core`, `db`, `auth`, `search`, `config`, `types` (+ hono). `apps/workers` → `core`, `config`, `types` (+ bullmq/ioredis).
  `apps/{web,admin}` → `types`, `ui` (+ next/react; talk to the api over HTTP, never via imports). `apps/auth` → `auth`, `db`, `config`, `types`.
  `apps/*` → any `packages/*`; **never** another app.

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

- **`packages/types`** — RFC-9457 `errors.ts` + the Zod contract surface (one file per domain, listed in the tree); closed-enum
  **drift guards** (`auditCoverage.test.ts`, `platformAuditCoverage.test.ts`). Single source of truth for request/response types.
- **`packages/config`** — `env.ts` (the only `process.env` reader) + key-material / origin-allowlist / origin-consistency tests.
- **`packages/ui`** — the TruePoint **design system**: `tokens/primitives/theme.css` + `cn`; dashboard primitives (StatusBadge,
  Card, StatTile, Spinner, Avatar, Progress, Pagination, Icon), **State Kit** (`state.tsx`: Skeleton/Loading/Empty/Error/StateSwitch),
  Tp-prefixed form `controls.tsx` + `form.tsx`, `Tabs`, overlays (`overlay.tsx` Dialog/Drawer; `floating.tsx` Popover/DropdownMenu/Tooltip),
  `Toast`, `DataTable`, `Combobox`, and shadcn-pattern `components/ui/*` (used by the auth screens).
- **`packages/db`** — `client.ts` (`withTenantTx`/`withPrivilegedTx`/`withPlatformTx`/`closeDb`), `applyMigrations.ts`
  (bootstrap → drizzle → RLS sorted → grants), `bootstrapAdmin.ts`, `migrate.ts`, `seed.ts`; `schema/*.ts` (23 schema files incl.
  the system-owned **Layer-0 master graph** `masterGraph.ts` — ADR-0021, walled off from `leadwolf_app` by the
  `applyMigrations` grant-off, no RLS), one RLS `.sql` each, `NULLIF(current_setting(…, true), '')::uuid` fail-closed idiom); `repositories/*.ts`; `test/*.itest.ts`
  (35+ DoD suites, run in **separate** processes — the db client is a module singleton; isolation itests prove cross-tenant invisibility).
- **`packages/core`** — `index.ts` is the public surface; domain code bucketed per feature above. Owns all ports
  (enrichment/sender/SearchPort/AiPort/MatchPort/DnsResolverPort) — never imports `integrations`.
- **`packages/auth`** — the self-built auth primitives (login/registration/invitations/password+policy+breach/MFA/SSO/switch/
  session-hardening) + `ipBinding`/`ipAllowlist`/`sessionTimeout`/`revocation`/`auditEvent`/`log`.
- **`packages/search`** — `index.ts` (the SearchPort adapter/types seam), `inMemorySearchPort.ts` (dev/test), `fields.ts`
  (facet projection). *Only the in-memory adapter exists; OpenSearch/Typesense land behind the same seam (ADR-0002/0035).*
- **`packages/integrations`** — `enrichment/{httpProvider,providers}.ts` (Apollo/ZoomInfo/Clearbit) + `anthropic/nlSearchAdapter.ts` (the AI port adapter).
- **`apps/api`** — `app.ts`, `server.ts`, `instrumentation.ts`; **`apps/api/middleware`** — `authn`, `tenancy`, `error`,
  `rateLimit`, `idempotency` (the DB uniques remain the real double-charge guard), `requireRole`/`requireOrgRole`/`requireStaffRole`, `platformAdmin`.
- **`apps/auth`** — `instrumentation` + `bootSelfTest` + `middleware`; `app/*` screens + token endpoints + account-security;
  `shared/*` (AuthShell/AccountShell/BrandLockup/OtpInput/SubmitButton/TurnstileWidget); `lib/*` (cookies, cors, mailer,
  `authFailure`, `domainResolver`, `finishLogin`, `requireUser`, `bootstrapAdmin`, `clientIp`, `completeMagic`/`completeSso`, `emails/*`).
- **`apps/web`** — `app/(shell)/*` destinations + `settings/*` routes (+ `import`, `auth/callback`); `components/shell/*`
  (AppShell auth gate, Sidebar/TopBar/navConfig, CommandPalette, DensityProvider, CreditPill, NotificationsBell,
  WorkspaceSwitcher/OrgSwitcher/TeamSwitcher, useSidebarPin); `lib/` (`authClient`, `pkce`, `publicConfig`).
- **`apps/admin`** — `app/(shell)/*` staff pages + `components/shell/*` (AdminShell two-stage gate, Sidebar/TopBar/navConfig,
  Brandmark) + `ImpersonationBanner` + `EntityPicker`/`TenantPicker`/`UserPicker`; `lib/` (`adminGate`, `authClient`, `pkce`, `publicConfig`).
- **`apps/workers`** — `index.ts` (entry + graceful drain), `register.ts` (composition root + producers), `leaderLock.ts`
  (single-runner election for scheduled ticks), `health`/`logger`; queue processors bucketed to their feature (imports/
  enrichment/scoring/dsar/outreach) — see Notes for the four undeclared queues. Queue itests in `apps/workers/test/`.

## Notes / unbucketed & warnings

- **Framework-root files (4, in `unassigned[]`):** `apps/{admin,auth,web}/next.config.mjs` + `apps/auth/postcss.config.mjs`
  — framework-mandated app-root files that cannot live under `src/` (the generator only classifies under `src/`). A framework
  constraint, not a placement error.
- **Undeclared worker queues (8, in `unassigned[]`):** `apps/workers/src/queues/{dedup,firmographics,masterBackfill,masterBackfill.test,masterBackfillSweep,retentionSweep,sequenceTick,tokenRefresh}.ts`
  are real processors whose queue name isn't in `QUEUE_DOMAIN` (`lib/arch-map.mjs`). They belong to `prospect`
  (dedup/firmographics), the master-graph backfill (`masterBackfill*` — prospect/enrichment), `compliance`
  (retentionSweep) and `email` (sequenceTick — the sequence cron; `tokenRefresh` — the leader-locked OAuth
  token-refresh sweep, M12 P1) respectively. Reconcile by extending `QUEUE_DOMAIN` (the spec-sanctioned way to grow the declared maps).
- **Unmapped repositories (30, in `unassigned[]`):** repositories whose entity isn't in `REPO_DOMAIN` —
  `accountSearch`, `authPolicy`, `customField`, `domain`, `emailAnalytics`, `emailEvent`, `emailMessage`, `emailTemplate`,
  `emailThread`, `enrichmentJob`, `enrichmentPolicy`, `featureFlag`, `impersonation`, `importMappingTemplate`, `mailbox`,
  `masterGraph`, `oauthConnectState`, `pipelineStage`, `platformStaff`, `providerConfig`, `savedSearch`, `scheduler`,
  `scimToken`, `searchRepository`, `sendQuota`, `sendingDomain`, `ssoConfig`, `staff`, `tag`, `webhook`. All are real,
  intentional repos; they bucket cleanly to the domains above (email/enrichment/prospect/custom-fields/saved-searches/
  tags/webhooks/admin/scim/settings). Reconcile by extending `REPO_DOMAIN` as the schema grows.
- **Domain-vocabulary warnings (31):** folder slugs not yet in `CANONICAL_DOMAINS` (`lib/arch-map.mjs`) — the new feature
  families since the canonical list was last edited: `account-search`, `admin`, `audit-log`, `contacts-bulk`,
  `custom-fields`/`customFields`, `email`, `enrichment-jobs`, `feature-flags`/`featureFlags`, `import-mapping-templates`,
  `pipeline-stages`/`pipelineStages`, `provider-configs`, `saved-searches`/`savedSearches`, `scim`, the `settings-*` family
  (`-custom-fields`/`-developer`/`-enrichment`/`-mailboxes`/`-shell`/`-tenant`/`-user`/`-workspace`), `staff`, `system-health`,
  `tags`, `tenants`, `users`, `webhooks`. All bucket correctly (nothing is lost); they surface as warnings so the canonical
  list can be reconciled (add the slugs, the way `settings-billing`/`settings-compliance` were declared) or the folders renamed.
  Left as flagged warnings — the established handling — not papered over.
- **Map hygiene:** this prose was refreshed from the 967-file JSON. When the source set changes again, re-run
  `node .claude/hooks/gen-architecture-map.mjs` (the Stop hook compares the `fileSetHash`) and refresh these purposes.
```
