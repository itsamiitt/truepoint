# 04 — Platform Admin Authentication Console

> Document 4 of 12 · TruePoint Centralized Authentication Platform. The admin module (in `admin.truepoint.in`) that lets a
> platform administrator configure **every** authentication feature without touching code. Built on the effective-policy
> engine (doc 03 §11), the config schema (doc 11), the Management API (doc 10 §7), and the existing staff RBAC.

## Executive summary

Today, auth behaviour is spread across env vars, code constants, and a partial `tenant_auth_policies` table, and there is **no
admin surface** to manage it — the single largest net-new scope in this program. This document specifies the Authentication
Management console: a set of admin modules, each backed by the effective-policy store and the Management API, each write
`withPlatformTx`-audited and **staff-RBAC-gated**, each respecting **strictest-wins** (an org can tighten but not loosen a
platform minimum) and the **lockout-safe rollout discipline** (default-OFF, staged, break-glass). The console is where the
platform team turns login methods, policies, providers, callbacks, branding, templates, webhooks, rate limits, and risk
policies on and off — per environment and per org — without a deploy.

## 1. Principles

- **Every write is audited + RBAC-gated.** Config changes go through `withPlatformTx` (owner role, writes
  `platform_audit_log` in the same tx) and require the appropriate `platform_staff.staff_role`. The staff app itself is
  hardened: mandatory phishing-resistant MFA + IP allowlist + step-up before sensitive changes (`AUTH-021`).
- **Strictest-wins + scope.** The console edits platform defaults and org overrides; it **cannot** let an org loosen a
  platform security minimum (the resolver rejects it).
- **Lockout-safe.** Every enforcement toggle is per-tenant default-OFF, staged (observe → soft-fail → enforce), with a
  documented, audited break-glass. A control that can lock a tenant out (SSO-required, IP-allowlist, forced-MFA, session
  timeout) exposes its rollout stage explicitly.
- **No secrets to the client.** Provider/client secrets are write-only, shown-once, encrypted at rest; the console never
  reads them back.
- **Config is versioned.** Every change bumps a version and is reversible; the audit log reconstructs who changed what.

## 2. The modules

Each module maps to config tables (doc 11) and Management API resources (doc 10 §7).

### 2.1 Login methods
Enable/disable, priority, per-method config, org restrictions, **test-connection**, and health for every method (doc 06). The
no-lockout guard lives here: a method can't be made mandatory until its test passes (`AUTH-031`).

### 2.2 Registration settings
Self-signup on/off, allowed email domains, invitation-only mode, default role on signup, email-verification requirement,
CAPTCHA on signup, verified-domain auto-join policy (`sso_only | auto_join | request_access`).

### 2.3 Password policy
Min length, breach-check on/off (fail-open posture), rotation/expiry (discouraged per NIST but configurable), reuse history,
lockout thresholds. Maps to `auth_policies` password keys; strictest-wins.

### 2.4 MFA policy
Allowed factors, required/optional per org, forced-enrollment behaviour, trusted-device 30-day skip, recovery-code settings,
step-up rules. Guardrail: required-MFA cannot be enabled without the enrollment path (`AUTH-069`).

### 2.5 Session policy
Idle + absolute timeouts, **concurrent-session cap** (`AUTH-042`), remember-me, refresh-token lifetime, re-auth requirements.
Each timeout enforcement is staged.

### 2.6 OAuth providers (social) & 2.7 Enterprise SSO
Provider registry CRUD (`auth_providers`): SAML/OIDC/social connections per org — metadata, client id/secret (write-only),
attribute/role mapping, JIT default role, cert fingerprints, **test-connection**, health. The self-service **SSO setup
wizard** (the WorkOS admin-portal pattern) can be surfaced to the customer's IT admin (doc 07).

### 2.8 Organization authentication
Per-org policy overrides, login-portal branding + slug/custom domain, domain verification (DNS-TXT) status + trigger, role/
group mapping, SCIM token management (doc 07).

### 2.9 Callback URLs / allowed domains / allowed origins
The managed allow-list (`auth_allowed_origins`) for redirect/callback URLs and CORS origins, per environment and per org,
with env as the floor (doc 08 §3). Exact-match validation; changes audited (an added origin is a security event).

### 2.10 Security policies & 2.11 Rate limiting & 2.12 Risk management
IP/country restrictions, VPN/Tor policy, brute-force/lockout thresholds, per-tenant rate-limit knobs (`auth_rate_limits`),
and the adaptive-risk thresholds + policy actions (allow/step-up/deny) — all config-driven (doc 09).

### 2.13 Branding
Per-org logo, colors, custom domain, login-portal appearance (`auth_branding`), email-template branding.

### 2.14 Email templates & 2.15 Notification settings
Per-org overridable transactional + security-notification templates (`auth_email_templates`), locale variants, and which
notification events are enabled. (The security-notification emails themselves are `AUTH-067`.)

### 2.16 Audit logs
Read/search the auth-event + `platform_audit_log`; filter by actor/tenant/event; **export to SIEM** (`AUTH-038`); retention
config (`AUTH-014/038`).

### 2.17 API tokens & 2.18 Webhooks
Manage `oauth_clients`, service accounts, and signed auth webhooks (doc 10): create/rotate/revoke, scopes, delivery health.

### 2.19 Access policies
Staff-RBAC assignment (who can change what), impersonation controls (time-boxed, audited, step-up-gated — `impersonation_
sessions`, doc 11).

## 3. Functional requirements

- CRUD for every module via the Management API, each write audited + RBAC-gated + versioned + reversible.
- **Effective-value preview:** for any org, show the resolved effective policy (platform default → org → workspace) so an
  admin sees exactly what a tenant experiences.
- **Test-before-enforce:** test-connection for providers/methods; observe-mode for enforcement flips; per-tenant staged
  rollout controls.
- **Break-glass:** a documented, audited path to re-open owner local-login without a deploy.

## 4. UI/UX recommendations

- **Navigation:** an "Authentication" section in the admin console with the modules above; a per-org drill-down and a
  platform-defaults view.
- **Effective-policy diff view:** platform default vs org override, with a clear "this tightens/loosens" indicator (loosening
  a security key is blocked).
- **Every mutation shows its rollout stage** (observe/soft-fail/enforce) and its audit trail inline.
- **Provider/method config drawers** with test + health badges; secrets are write-only fields ("replace" not "view").
- **Staff-app hardening is visible** — the console requires step-up before sensitive changes and surfaces the requirement.
- WCAG 2.2 AA + i18n; four states on every async surface (per the design system).

## 5. API specification (Management API, `/api/v1/auth-admin/*`)

```
GET/PUT  /auth-admin/methods[/{method}]            login-method registry
GET/PUT  /auth-admin/policies?scope&tenant         effective-policy read/write (strictest-wins enforced)
GET/POST/PUT/DELETE /auth-admin/providers          SSO/OIDC/social connections (+/test, /health)
GET/POST /auth-admin/domains[/{id}/verify]         domain claim + DNS-TXT verify trigger
GET/PUT  /auth-admin/origins                        allowed callbacks/origins
GET/PUT  /auth-admin/branding | /email-templates    per-org branding + templates
GET/POST/DELETE /auth-admin/clients | /api-keys | /webhooks   developer platform
GET      /auth-admin/audit  |  POST /auth-admin/audit/export   audit + SIEM export
GET/PUT  /auth-admin/rate-limits | /risk-policies   abuse + risk config
POST     /auth-admin/impersonation                  time-boxed, audited, step-up-gated
```

All writes: staff-RBAC-gated, `withPlatformTx`-audited, RFC-9457 errors, `Idempotency-Key` on creates, cursor pagination on
lists, versioned config.

## 6. Security considerations

- **The console is a high-value target** — a poisoned config is a lockout/escalation vector. Mitigations: staff-RBAC + step-
  up + staff-app hardening (`AUTH-021`), strictest-wins (can't loosen a minimum), config versioning + full audit, default-OFF
  flips, break-glass.
- **Secrets never read back**; write-only, encrypted, KMS-managed (`AUTH-013`).
- **Mass-assignment allowlists** — no privilege field (`org_role`, `is_platform_admin`) settable via a config/provider claim
  (`AUTH-034`).
- **Every config write is an auditable security event**, esp. allowed-origin additions, provider changes, and enforcement
  flips.

## 7. Non-functional, testing, migration, risks

- **Non-functional:** config reads are cached + versioned (resolver); writes are strongly consistent + audited; low traffic,
  high assurance.
- **Testing:** strictest-wins holds (loosening rejected); every flip is staged + break-glass-reversible; test-connection
  gates mandatory methods; audit captures every change; cross-tenant isolation on config tables.
- **Migration:** stand up the console shell + effective-policy engine (doc 12 Phase 1); migrate `tenant_auth_policies` into
  `auth_policies`; seed the method registry from today's hard-coded methods; add modules incrementally.
- **Risks:** admin lockout (default-OFF + break-glass), config drift (versioning + effective-value preview), secret exposure
  (write-only + KMS).
- **Future:** config-as-code export/import, change-approval workflows, per-org self-service admin delegation, policy
  simulation ("what happens if I flip this").
