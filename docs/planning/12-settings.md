# 12 — Settings

> The settings hierarchy for the customer app, in **four scopes** — User · Workspace · Tenant ·
> Developer — each item tagged with a plan **tier** and a **milestone**. Settings open as **panels in
> the app shell** ([11](./11-information-architecture.md)), not a separate site. RBAC and tables are
> per [03](./03-database-design.md); roles per [ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md).

## 1. Scopes & who can edit

| Scope | Editable by | Backed by |
|---|---|---|
| **User** | the user (self) | `users`, `user_sessions`, `user_mfa`/`user_mfa_methods`, `webauthn_credentials`, `trusted_devices`, `user_oauth_accounts`, `sending_identities`* |
| **Workspace** | workspace `owner`/`admin` | `workspaces`, `workspace_members`, `workspace_auth_policies`, `suppression_list`, integrations* |
| **Tenant** | `tenant_members.org_role` — `owner` (all), `billing_admin` (billing), `security_admin` (SSO/auth policy), `compliance_admin` (suppression/DSAR/retention) ([ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md)) | `tenants`, `tenant_domains`, `tenant_sso_configs`, `tenant_auth_policies`, `scim_tokens`, `purchases`, `consent_records`, `dsar_requests`, `audit_log` |
| **Developer** | tenant admin+ | `api_keys`, `oauth_app_clients`, `webhooks`* |

`*` = table flagged as a follow-up [03](./03-database-design.md) amendment (see [11 §6](./11-information-architecture.md) / [§6 below](#7-schema--open-items)).

## 2. User settings *(all users — Free+)*

- **Profile** — name, avatar, email, timezone, locale.
- **Security** *(served on `auth.truepoint.in/account/security`, [17 §10](./17-authentication.md#10-screens-components--settings-surfaces))* —
  password (Argon2id) + strength meter; **MFA methods** (TOTP / SMS / email / **WebAuthn passkey**) +
  **recovery codes** (view/regenerate); **passwordless / magic link**; **active sessions** +
  sign-out-everywhere; **trusted devices** (revoke); **login history** (event, location, device,
  timestamp, **origin_domain**) ([03 §4](./03-database-design.md#4-tenancy--auth)).
- **Notifications** — per-channel prefs (in-app/email): replies, task-due, low-credits, weekly digest.
- **Sending identity** — connect the user's email/LinkedIn for sending, signature, display name
  (feeds Sequences, [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md)). *(M9)*
- **Personal access tokens** — *(if enabled by tenant policy; Team+)*.

## 3. Workspace settings *(owner/admin — Free+, multi-workspace Team+)*

- **General** — name, slug, default region, timezone, branding. *(M2)*
- **Members & roles** — invite by email (creates an `invitations` row + emailed accept link, with
  expiry/resend), set per-workspace role (`owner`/`admin`/`member`/`viewer`), remove (DSAR-aware); pending +
  accepted invites. Accept lands the global identity as a `tenant_member` + `workspace_member`
  ([ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md)). *(M2)*
- **Authentication** *(admin)* — workspace **MFA enforcement** (off/optional/**required**), **allowed
  login methods**, **session timeout**, and **IP allowlist** (`workspace_auth_policies`); may only
  **tighten** the tenant policy, never relax it
  ([ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md),
  [17 §4](./17-authentication.md#4-multi-tenancy-auth-model)). *(M11)*
- **ICP & scoring config** — default ICP definition + score weights (drives Scores, [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)). *(M4/M8)*
- **Sending & deliverability** — per-workspace **sending domains** + **DKIM/SPF/DMARC** status,
  **warm-up**, daily send limits, **unsubscribe footer + physical address**. *(M9)*
- **Suppression / DNC** — workspace-scope list + CSV import ([08 §3](./08-compliance.md)). *(M5)*
- **Integrations** — CRM connect (HubSpot/Salesforce/Pipedrive) + native apps, Sales Navigator,
  Slack/Teams app, **reverse-ETL/warehouse**, **Chrome extension**, **SMS** channel, BYO
  enrichment-provider keys ([26](./26-integrations-data-delivery.md)). *(M7/M10/M16)*
- **Import defaults** — dedup rules, default field mapping, **saved mapping templates** + default
  conflict policy (skip/overwrite/fill-empty/review); per-plan **max file size / row count** (see §6)
  ([30](./30-bulk-import-export-pipeline.md), [29 §3](./29-settings-administration-architecture.md)). *(M1)*
- **Teams & departments** — create teams (`department_type`), assign members + **team roles**, configure
  **personas** (default dashboards/views), **record-visibility** defaults, and **per-team credit budgets**
  ([25](./25-departments-teams-workspaces.md), [ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)). *(M15)*
- **Automation** — build trigger→condition→action plays + recipe library; per-team automation policies;
  **dry-run** ([27](./27-workflow-automation-engine.md)). *(M16)*
- **AI assistant** — enable/disable AI features, guardrails, **BYO model key**, per-team AI budgets
  ([23](./23-ai-intelligence-layer.md)). *(M14)*
- **Data freshness & retention** — per-field re-verify cadence + retention/purge policy
  ([22](./22-data-quality-freshness-lifecycle.md)). *(M13)*
- **Export policies** — row caps + frequency limits + approval for large exports; large jobs run as an
  **async streaming export** (gzip/shard/manifest, expiring signed links)
  ([26 §8](./26-integrations-data-delivery.md), [30 §7](./30-bulk-import-export-pipeline.md)). *(M16)*

## 4. Tenant settings *(tenant owner / billing — tier as noted)*

- **Organization** — tenant name, logo, default region. *(M1)*
- **Billing & Credits** *(Free+)* — plan tier, seats, workspace limit, **Stripe customer portal**,
  invoices, payment method; **credit pool** balance, **top-up** (packs), **auto-recharge**,
  **cross-workspace / per-team budget allocation** ([25 §5](./25-departments-teams-workspaces.md)),
  usage history. *(M3)* — the top-bar credit pill deep-links here.
  **Transparent, no-lock-in terms** ([ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md)):
  self-serve cancellation, no auto-renew traps, and **account-closure data export** (no data-destroy on churn).
- **Workspaces** *(Team+)* — create/archive, limits, default workspace. *(M2)*
- **Members directory** — tenant-wide members (`tenant_members`), invite/deactivate, assign tenant-role
  (`is_tenant_owner`). *(M2)*
- **Security & access** *(Enterprise)* — guided **SSO wizard** (SAML 2.0 / OIDC via `tenant_sso_configs`)
  with **ACS URL + Entity ID displayed** (`auth.truepoint.in` values), metadata upload/URL, **attribute
  mapping** (email/name/role/department), **JIT toggle + default role**, and a **test-connection** tool;
  **SCIM** provisioning + token management (`scim_tokens`); **domain claiming + verification**
  (`tenant_domains`) with a **join policy** (`sso_only` / `auto_join` / `request_access`, [ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md)); **enforce-SSO**, **IP allowlist**, session/MFA/password policy
  (`tenant_auth_policies`, [ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)).
  Full design [17 §8](./17-authentication.md#8-sso--scim-architecture). *(M11)*
- **Compliance & data** — global/tenant **suppression**, **DSAR** intake & status, **consent records**,
  **retention controls**, **data residency** (region), **audit-log viewer + export**, sub-processor
  list ([08](./08-compliance.md)). *(M5; export + residency Enterprise/M11)*
- **Trust Center** — sub-processor list, **DPA**, security whitepaper, and **certification status**
  (SOC 2 Type II / ISO 27001) + data-broker registration status
  ([ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [08 §15](./08-compliance.md)). *(M5 → program)*

## 5. Developer settings *(tenant admin+ — Team+/Enterprise)*

- **API keys** — tenant-scoped, **hashed + scoped**, create/rotate/revoke, usage. *(seam M2, API M10)*
- **OAuth apps** — register OAuth clients (`oauth_app_clients`); **redirect URIs must be
  `auth.truepoint.in` origins**; client id/secret, CORS allow-list (no wildcard), scopes
  ([17 §1](./17-authentication.md#1-service-boundary--domains),
  [ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md)). *(M11)*
- **Webhooks** — outbound events `reveal.completed` / `score.updated` / `outreach.status_changed` and
  **auth events** (`auth.event` — login/MFA/SSO/device, [09 §10](./09-api-design.md#10-webhooks-outbound-post-mvp));
  signing secret, **delivery log + retries**. *(M10)*
- **API docs & sandbox** — OpenAPI reference + sandbox keys. *(M10)*

## 6. Plan-tier matrix

| Capability | Free | Pro | Team | Enterprise |
|---|:--:|:--:|:--:|:--:|
| Workspaces | 1 | 1 | many | many |
| Workspace roles (admin/member/viewer) | — | — | ✅ | ✅ |
| Reveals (credits) | ✅ | ✅ | ✅ | ✅ |
| Sequences + send | — | ✅ | ✅ | ✅ |
| Reports / analytics | basic | ✅ | ✅ | ✅ |
| Integrations (CRM) | — | — | ✅ | ✅ |
| AI assistant (copilot / drafting) | — | ✅ | ✅ | ✅ |
| Departments / teams + budgets | — | — | ✅ | ✅ |
| Automation plays | — | — | ✅ | ✅ |
| Reverse-ETL / warehouse | — | — | — | ✅ |
| Public API + webhooks | — | — | ✅ | ✅ |
| SSO / SCIM | — | — | — | ✅ |
| IP allowlist / session policy | — | — | — | ✅ |
| Data residency | — | — | — | ✅ |
| Audit-log export | — | — | — | ✅ |
| SLA / priority support | — | — | — | ✅ |

**Bulk import/export limits** (initial per-plan defaults; enforced as entitlements at job submit —
[30](./30-bulk-import-export-pipeline.md), [09](./09-api-design.md); `custom` = negotiated):

| Limit | Free | Pro | Team | Enterprise |
|---|:--:|:--:|:--:|:--:|
| Max import file size | 25 MB | 100 MB | 1 GB | 5 GB |
| Max rows / import job | 50K | 500K | 5M | custom |
| Export row cap / job | 10K | 100K | 1M | custom |
| Bulk reveal — daily cap | — | 5K | 50K | custom |
| Concurrent bulk jobs / workspace | 1 | 2 | 5 | custom |
| Large-job approval threshold | — | — | ≥1M rows | configurable |

*(Tiers/limits are placeholders pending pricing — see [07 §1](./07-billing-credits.md) and [00 §8](./00-overview.md#8-open-questions-tracked-resolved-during-doc-review-or-early-milestones).)*

## 7. Schema & open items

New tables/fields these settings imply, flagged as a follow-up [03](./03-database-design.md) amendment
(not silently assumed): `sending_identities`, `integrations` (+ OAuth tokens), `webhooks` (+ delivery
log), `notification_prefs`. The **auth & security** settings (SSO/OIDC, SCIM, auth policy, domain claiming,
passkeys, trusted devices, OAuth apps) are now **defined** in
[03 §4](./03-database-design.md#4-tenancy--auth) ([17](./17-authentication.md)): `tenant_domains`,
`tenant_sso_configs`, `scim_tokens`, `tenant_auth_policies`/`workspace_auth_policies`,
`webauthn_credentials`, `trusted_devices`, `user_mfa_methods`, `oauth_app_clients`.

**Open questions:** per-user personal tokens policy (tenant-controlled?); notification-prefs storage
(table vs `users.settings` jsonb); SCIM scope at MVP-Enterprise ([17 open Q6](./17-authentication.md#open-questions)).
