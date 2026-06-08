# 12 — Settings

> The settings hierarchy for the customer app, in **four scopes** — User · Workspace · Tenant ·
> Developer — each item tagged with a plan **tier** and a **milestone**. Settings open as **panels in
> the app shell** ([11](./11-information-architecture.md)), not a separate site. RBAC and tables are
> per [03](./03-database-design.md); roles per [ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md).

## 1. Scopes & who can edit

| Scope | Editable by | Backed by |
|---|---|---|
| **User** | the user (self) | `users`, `user_sessions`, `user_mfa`, `user_oauth_accounts`, `sending_identities`* |
| **Workspace** | workspace `owner`/`admin` | `workspaces`, `workspace_members`, `suppression_list`, integrations* |
| **Tenant** | `users.is_tenant_owner` / billing admin | `tenants`, `tenant_sso_configs`, `purchases`, `consent_records`, `dsar_requests`, `audit_log` |
| **Developer** | tenant admin+ | `api_keys`, `webhooks`* |

`*` = table flagged as a follow-up [03](./03-database-design.md) amendment (see [11 §6](./11-information-architecture.md) / [§6 below](#6-schema--open-items)).

## 2. User settings *(all users — Free+)*

- **Profile** — name, avatar, email, timezone, locale.
- **Security** — password (Argon2id), **MFA/TOTP** enroll + backup codes, **active sessions/devices** +
  sign-out-everywhere ([03 §4](./03-database-design.md#4-tenancy--auth)).
- **Notifications** — per-channel prefs (in-app/email): replies, task-due, low-credits, weekly digest.
- **Sending identity** — connect the user's email/LinkedIn for sending, signature, display name
  (feeds Sequences, [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md)). *(M9)*
- **Personal access tokens** — *(if enabled by tenant policy; Team+)*.

## 3. Workspace settings *(owner/admin — Free+, multi-workspace Team+)*

- **General** — name, slug, default region, timezone, branding. *(M2)*
- **Members & roles** — invite, set per-workspace role (`owner`/`admin`/`member`/`viewer`), remove
  (DSAR-aware on user deletion); pending invites. *(M2)*
- **ICP & scoring config** — default ICP definition + score weights (drives Scores, [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)). *(M4/M8)*
- **Sending & deliverability** — per-workspace **sending domains** + **DKIM/SPF/DMARC** status,
  **warm-up**, daily send limits, **unsubscribe footer + physical address**. *(M9)*
- **Suppression / DNC** — workspace-scope list + CSV import ([08 §3](./08-compliance.md)). *(M5)*
- **Integrations** — CRM connect (HubSpot/Salesforce/Pipedrive), Sales Navigator, Slack/Teams
  notifications, BYO enrichment-provider keys. *(M7/M10)*
- **Import defaults** — dedup rules, default field mapping. *(M1)*

## 4. Tenant settings *(tenant owner / billing — tier as noted)*

- **Organization** — tenant name, logo, default region. *(M1)*
- **Billing & Credits** *(Free+)* — plan tier, seats, workspace limit, **Stripe customer portal**,
  invoices, payment method; **credit pool** balance, **top-up** (packs), **auto-recharge**,
  **cross-workspace allocation** policy, usage history. *(M3)* — the top-bar credit pill deep-links here.
  **Transparent, no-lock-in terms** ([ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md)):
  self-serve cancellation, no auto-renew traps, and **account-closure data export** (no data-destroy on churn).
- **Workspaces** *(Team+)* — create/archive, limits, default workspace. *(M2)*
- **Members directory** — tenant-wide users, deactivate, assign tenant-role (`is_tenant_owner`). *(M2)*
- **Security & access** *(Enterprise)* — **SSO (SAML/OIDC** via `tenant_sso_configs`), **SCIM**
  provisioning, **enforce-SSO**, **IP allowlist**, session/MFA policy, password policy. *(M11)*
- **Compliance & data** — global/tenant **suppression**, **DSAR** intake & status, **consent records**,
  **retention controls**, **data residency** (region), **audit-log viewer + export**, sub-processor
  list ([08](./08-compliance.md)). *(M5; export + residency Enterprise/M11)*
- **Trust Center** — sub-processor list, **DPA**, security whitepaper, and **certification status**
  (SOC 2 Type II / ISO 27001) + data-broker registration status
  ([ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md), [08 §15](./08-compliance.md)). *(M5 → program)*

## 5. Developer settings *(tenant admin+ — Team+/Enterprise)*

- **API keys** — tenant-scoped, **hashed + scoped**, create/rotate/revoke, usage. *(seam M2, API M10)*
- **Webhooks** — outbound events `reveal.completed` / `score.updated` / `outreach.status_changed`;
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
| Public API + webhooks | — | — | ✅ | ✅ |
| SSO / SCIM | — | — | — | ✅ |
| IP allowlist / session policy | — | — | — | ✅ |
| Data residency | — | — | — | ✅ |
| Audit-log export | — | — | — | ✅ |
| SLA / priority support | — | — | — | ✅ |

*(Tiers/limits are placeholders pending pricing — see [07 §1](./07-billing-credits.md) and [00 §8](./00-overview.md#8-open-questions).)*

## 7. Schema & open items

New tables/fields these settings imply, flagged as a follow-up [03](./03-database-design.md) amendment
(not silently assumed): `sending_identities`, `integrations` (+ OAuth tokens), `webhooks` (+ delivery
log), `notification_prefs`. SSO/SCIM use `tenant_sso_configs` (exists) + a SCIM provisioning table.

**Open questions:** per-user personal tokens policy (tenant-controlled?); notification-prefs storage
(table vs `users.settings` jsonb); SCIM scope at MVP-Enterprise.
