# TruePoint — Authentication Plan

A single, source-verified reference on TruePoint's authentication system: where it stands today, how it
compares to an enterprise-grade 2025–2026 benchmark, where the gaps are, which settings exist on the admin
and user sides, and what to plan next. Every claim about the codebase is cited to `file:line`; every external
claim carries a source URL. Status words are used consistently: **Implemented · Partial · Stub · Planned · Absent**.

> Scope note: this folder is a **planning artifact**, not a code change. It was produced by reviewing
> `packages/auth`, `packages/db`, `apps/auth`, `apps/web`, `apps/admin`, and `docs/planning/*`, benchmarked
> against NIST SP 800-63B-4, OWASP ASVS 5.0, FIDO/passkeys, OpenID CAEP/Shared Signals, and the admin settings
> catalogs of Okta, Microsoft Entra, and WorkOS.

> Two priority axes: the P0–P3 labels in [`07-recommended-settings.md`](07-recommended-settings.md) are
> **business priority** (how badly an enterprise needs the setting), while the P0–P3 labels in
> [`08-roadmap.md`](08-roadmap.md) are the **delivery wave** (sequenced by dependencies). They are different
> axes — an item can be high business-priority yet land in a late wave (passkeys are P0 business priority but a
> P3 delivery wave, because they depend on the P1b `/account/security` wizard). Doc 07 carries a mapping column
> so both are visible at once.

## Reading order

| # | File | Read it for |
|---|------|-------------|
| 1 | [`01-enterprise-benchmark.md`](01-enterprise-benchmark.md) | What enterprise-grade auth looks like in 2025–2026 — the yardstick. |
| 2 | [`02-current-state-backend.md`](02-current-state-backend.md) | As-built backend (`packages/auth`, `packages/db`) by capability, with status. |
| 3 | [`03-current-state-flows-frontend.md`](03-current-state-flows-frontend.md) | As-built flows & screens (`apps/auth`, `apps/web`, `apps/admin`). |
| 4 | [`04-settings-inventory.md`](04-settings-inventory.md) | **The settings that exist today — admin side and user side.** |
| 5 | [`05-planned-not-built.md`](05-planned-not-built.md) | Designed-but-unbuilt work, with source-doc references. |
| 6 | [`06-gap-analysis.md`](06-gap-analysis.md) | **Benchmark vs. TruePoint — the gaps, by severity.** |
| 7 | [`07-recommended-settings.md`](07-recommended-settings.md) | **Additional admin- and user-side settings to plan.** |
| 8 | [`08-roadmap.md`](08-roadmap.md) | Prioritized roadmap (P0→P3 delivery wave) mapped to owners and acceptance criteria. |
| 9 | [`09-threat-model.md`](09-threat-model.md) | Threat model & per-feature security acceptance criteria (SAML/OIDC validation, SSRF, SCIM race, MFA integrity, open redirects, mass-assignment, session/CSRF/CSP invariants, recovery abuse). |
| 10 | [`10-operations-and-compliance.md`](10-operations-and-compliance.md) | Auth observability & SLIs/SLOs, key management & rotation, DSAR/retention/deletion, incident response & breach notification, email/SMS deliverability, data residency, FinOps, consent & lawful basis. |
| 11 | [`11-gap-register.md`](11-gap-register.md) | Consolidated gap register (stable `AUTH-###` IDs, 06→07→08 traceability, effort, status) + a delivery-risk register. |

> **Implementation:** apply-ready, gate-checked specs for the P0 wave live in
> [`implementation/`](implementation/00-README.md) — start there to build the plan. The 6 open decisions are
> resolved (register shows 0 open), and the AUTH-015 near-term action (removing the dead social-login button)
> is done.

---

## Executive summary

**The foundation is strong; the gaps are at the edges — real federation, policy *enforcement*, and end-user
self-service.** TruePoint's cryptographic and session core is genuinely enterprise-grade, but several
enterprise-defining capabilities are scaffolded rather than wired, and the per-user account-security surface
does not exist yet.

### What's solid today (Implemented)
- **Credentials & sessions:** Argon2id passwords (uniform, enumeration-safe errors); EdDSA JWT + JWKS + key
  rotation; Lucia-style durable sessions with rotating refresh, reuse-detection (family revocation + deny-list);
  single-use, 60-second, PKCE/IP/origin-bound cross-domain code on a dedicated auth origin.
- **MFA (baseline):** TOTP + single-use recovery codes; strictest-wins policy *resolution*.
- **Abuse resistance:** Redis rate-limiting (per-IP/identifier + credential lockout), Cloudflare Turnstile,
  IP-binding for the code.
- **Tenant isolation:** two-tier `tenant_id`/`workspace_id` enforced at the DB by RLS; `scopeGuard` cross-tenant
  gate; org/workspace switching with session rotation. (The two earlier Phase-0 security items — cross-tenant
  selector checks and `platform_audit_log` RLS — are **already remediated** in source; they remain only as
  regression-test items.)
- **Admin (tenant/org) settings wired:** SSO config, auth policy (values stored), domains + join policy, SCIM
  token mint/revoke.
- **Workspace-admin session management:** an owner/admin can list members' active sessions, revoke one, and
  force-reauth a member (`apps/api/.../workspaces/sessionRoutes.ts`, mounted `app.ts:71`).
- **Platform console:** tenant view, audit log, feature flags, provider-configs (write-capable), global users
  list; impersonation *start* endpoint (the "login-as" token issuance is deferred).

### The top gaps (full detail in `06-gap-analysis.md`)
1. **Real SSO is a stub.** OIDC (`arctic`) and SAML (`@node-saml`) adapters **throw "not configured"** — only
   the mock IdP runs. Per-tenant federation does not work in production. *(Enterprise-critical.)* The real SAML
   validator must ship with adversarial acceptance gates — **anti-XXE**, **anti-signature-wrapping**, and
   **reject-unsigned-assertion** — as ship-blocking criteria, not a follow-up; see
   [`09-threat-model.md`](09-threat-model.md) ("SAML validation", "OIDC id_token validation"). *(Critical.)*
2. **SCIM provisioning/deprovisioning is absent.** Only token storage exists; no `/scim/v2/*` endpoints and no
   automated deprovisioning (a deactivation in the customer's IdP does not revoke access). *(Enterprise-critical.)*
3. **Policy is resolved but not enforced.** Only MFA-required is gated at login; **allowed-methods, IP
   allowlist, session timeout, and require-SSO are stored but never enforced.**
4. **No per-user self-service security.** The `/account/security` route is **Absent**; the web `SecurityPanel`
   only deep-links to it and shows a hard-coded MFA list. Users cannot change their password, enroll/disable
   MFA, view/revoke their *own* sessions, or see login history in-product.
5. **MFA breadth & modern factors.** SMS/email OTP and **WebAuthn/passkeys** are stub/planned; trusted-devices
   is schema-only. No phishing-resistant/passkey-first option despite it being the 2025 enterprise default.
6. **No adaptive/risk-based or continuous auth.** No device/geo/impossible-travel step-up; no **CAEP/Shared
   Signals** for real-time cross-service session revocation.
7. **Granular admin RBAC mostly wired; two narrow gaps remain.** The `requireOrgRole`/`requireStaffRole` guards
   are **Implemented** (`apps/api/src/middleware/requireOrgRole.ts`, `requireStaffRole.ts`,
   `roleGuards.test.ts`), as are the `org_role` column (`packages/db/src/schema/auth.ts:79`) and the
   `platform_staff` table (`packages/db/src/migrations/0006_kind_tomorrow_man.sql:1`, with
   `platformStaffRepository.ts`). The remaining RBAC gap is only (a) a `requireWorkspaceRole` coverage review and
   (b) the workspace **Members** API (invite/role/remove), which is still **Absent** (UI-only).
8. **Operate & comply is unbuilt.** Auth has no observability/SLI layer, no SLOs or degraded-mode runbook, no
   key-rotation runbook, and no DSAR/retention/deletion path for auth artifacts (sessions, MFA secrets, audit
   rows). This is the production-maturity gap an enterprise expects; full detail in
   [`10-operations-and-compliance.md`](10-operations-and-compliance.md).

### What to plan next — highest-value settings (full detail in `07-recommended-settings.md`)
- **Admin:** password policy (length + breached-list screening + reuse block); per-method MFA enforcement and a
  *require phishing-resistant / passkey-first* toggle; adaptive/risk rules → step-up; idle + absolute session
  timeout and concurrent-session cap; SCIM deprovisioning behavior; CAEP/Shared-Signals; sign-in/security
  alerts; SSO test-connection + "enforced with break-glass"; OAuth-app & PAT management.
- **User (the biggest experience gap):** the `/account/security` page itself — passkey & MFA enrollment,
  recovery-code regeneration, **own** active sessions + device list + revoke, trusted devices, login history,
  and sign-in-alert preferences.

### Roadmap at a glance (full detail in `08-roadmap.md`)
- **P0 — correctness:** regression-test the already-fixed cross-tenant selector and `platform_audit_log` RLS;
  emit the missing password-reset audit events.
- **P1 — enforcement + self-service:** enforce auth policy on login (forced MFA enrollment, methods, IP
  allowlist, session timeout); build the `/account/security` UI; complete the `requireWorkspaceRole` coverage
  review and wire the workspace Members API (the `requireOrgRole`/`requireStaffRole` guards and the
  `org_role`/`platform_staff` migrations already ship).
- **P2 — enterprise federation:** real OIDC/SAML adapters + setup wizard + domain DNS-TXT verification worker;
  SCIM 2.0 endpoints + deprovisioning.
- **P3 — modern / zero-trust:** WebAuthn/passkeys + passkey-first enforcement; adaptive/risk + step-up;
  CAEP/Shared-Signals; sign-in alerts; platform-admin expansion (login-as, staff RBAC UI, audit export).
