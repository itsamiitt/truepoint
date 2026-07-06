# TruePoint Centralized Authentication Platform — Design Suite

> **Product:** TruePoint · **Code identity:** `@leadwolf/*` (both correct, by design). **Target service:**
> `auth.truepoint.in` — the single identity provider for `app.` / `admin.` / `api.truepoint.in`, the MV3 Chrome
> extension, and future mobile/internal/partner surfaces.
> **Status:** in progress — see the status table below. **Effort model:** multi-agent (see `docs/planning/main-agent-prompt.md`).

This suite designs a production-ready, centralized authentication platform: a standalone IdP that is the single source of
truth for identity, sessions, permissions, and authentication policy across every TruePoint surface, configurable by a
platform administrator **without code changes**.

It is written to be implemented by a senior engineering team and to hold up to enterprise scrutiny (SOC 2 / ISO 27001 /
GDPR / India DPDP), reflecting Auth0/Okta/WorkOS-class expectations for scalability, security, maintainability, and
extensibility.

## Relationship to the existing `Authentication plan/` tree

The repo already contains a mature `Authentication plan/` tree (11 docs + implementation tasks, 2026-06-26) with a canonical
**`AUTH-###` gap register** (60 rows). **This suite extends that work; it does not replace it.** We reuse the `AUTH-###` IDs
(confirming or updating each against today's code) and mint new findings from **`AUTH-061` upward** — never renumbering.
Where this suite corrects an older doc, it is flagged as a **stale-doc** correction. The audit (doc 01) reconciles the two.

## The 12 documents

| # | Document | Scope | Status |
|---|---|---|---|
| 01 | [`01_Current_System_Audit.md`](./01_Current_System_Audit.md) | Live-code audit; root-cause of the three reported failures; updated `AUTH-###` register (adds `AUTH-061…078`); what's solid | ✅ **authored** |
| 02 | [`02_Enterprise_Authentication_Research.md`](./02_Enterprise_Authentication_Research.md) | Benchmark of Auth0, Clerk, Keycloak, FusionAuth, Okta, Entra, Cognito, Supabase, Firebase, Zitadel, Ory, WorkOS; standards; best-practice register (`BP-001…022`); build-vs-buy | ✅ **authored** · live-source deepening pending (see below) |
| 03 | [`03_Authentication_Architecture.md`](./03_Authentication_Architecture.md) | Target architecture: auth/authz/identity/session/token lifecycles; service topology; events, queues, Redis, HA/DR; sequence diagrams | ✅ **authored** |
| 04 | [`04_Platform_Admin_Authentication.md`](./04_Platform_Admin_Authentication.md) | The admin console: configure every auth feature without code (login methods, policies, providers, callbacks, branding, email, webhooks, rate limits, risk) | ✅ **authored** |
| 05 | [`05_User_Security_Settings.md`](./05_User_Security_Settings.md) | User self-service: password, MFA, passkeys, sessions, trusted devices, connected apps, API keys, recovery, notifications, privacy, export/deletion | ✅ **authored** |
| 06 | [`06_Login_Methods.md`](./06_Login_Methods.md) | The configurable login-method matrix (password, passwordless, OTP, social, SSO, LDAP/AD, passkeys/WebAuthn) with per-method config + org restrictions | ✅ **authored** |
| 07 | [`07_SSO_and_Organization_Management.md`](./07_SSO_and_Organization_Management.md) | Enterprise SSO (SAML/OIDC), SCIM, domain verification, JIT, org branding/portals, role/group mapping, multi-domain | ✅ **authored** |
| 08 | [`08_Callback_URL_and_OAuth.md`](./08_Callback_URL_and_OAuth.md) | Redesigned callback/redirect architecture; PKCE; cookies/JWT/refresh; CSRF; allowed origins; extension/admin/org callbacks | ✅ **authored** |
| 09 | [`09_Security_Policies.md`](./09_Security_Policies.md) | MFA/adaptive/risk, device fingerprinting, IP/country restrictions, CAPTCHA, brute-force, anomaly detection, lockout, notifications | ✅ **authored** |
| 10 | [`10_API_and_Token_Management.md`](./10_API_and_Token_Management.md) | OAuth authorization server, JWT/refresh strategy, token rotation, service accounts, API keys/PATs, webhooks, SDKs, audit/identity APIs | ✅ **authored** |
| 11 | [`11_Database_Design.md`](./11_Database_Design.md) | Full auth schema (existing + net-new config/clients/keys/webauthn/branding/webhooks tables), RLS, indices, migration/snapshot debt | ✅ **authored** |
| 12 | [`12_Implementation_Roadmap.md`](./12_Implementation_Roadmap.md) | Sequenced delivery waves (P0 hotfix → platform build), effort (S/M/L/XL), lockout-safe rollout, testing/migration strategy, risks | ✅ **authored** |

Each document carries: executive summary · research findings · best practices · functional & non-functional requirements ·
UI/UX recommendations · API specifications · database design · security considerations · implementation phases · testing
strategy · migration strategy · risks & mitigations · future enhancements — applied where they fit the document's subject.

## Conventions (inherited across all 12 docs)

- **Status vocabulary:** exactly `Implemented | Partial | Stub | Planned | Absent`.
- **Evidence discipline:** every TruePoint claim carries a `file:line` anchor; every external claim a source URL.
- **IDs:** `AUTH-###` gap IDs are stable and extended, never renumbered; new best-practice items use `BP-###`.
- **Tenancy:** every new tenant-scoped table is `tenant_id NOT NULL` + FORCE-RLS with a cross-tenant isolation test.
- **Precedence** (`CLAUDE.md`): security has final say on safety; platform owns RLS/API/scale; data owns the model.
- **Brand/scope split:** "TruePoint" (user-facing) and `@leadwolf/*` (code) are both correct and intentional.

## Current status & the outstanding follow-up

- **Delivered:** all 12 documents + this index, plus the raw evidence in [`_evidence/`](./_evidence/) — four deep audits
  (forgot-password, security-settings, callbacks, token-session) and the existing-plan digest.
- **One interrupted input:** the 20-agent live-source enterprise-platform research sweep was killed mid-run by an
  **account-level block** — a required Consumer-Terms re-acceptance in `claude.ai` plus a usage-limit reset. Doc 02 was
  therefore assembled from the repo's existing cited enterprise benchmark + the partial deep-research run + standards
  knowledge, with per-platform claims needing a live citation marked `[verify]`. Its standards baseline and `BP-###`
  register are stable and safe to build against now.
- **Follow-up to deepen (optional):** accept the updated terms in `claude.ai` (with the account email in `/status`) and
  re-run the research sweep to resolve the `[verify]` markers with primary sources and deepen the per-platform admin/token/
  pricing detail. No other document depends on this.

## The headline finding (for anyone skimming)

The core auth engine is sound and well-built. The three reported failures are deployment/wiring defects on top of it: two
share one root cause — **constructed auth URLs omit the `/auth` basePath** (404s the reset/magic links *and* the
security-settings deep links) — and the forgot-password flow additionally ships **MailHog as the production mail transport**,
so reset emails are never delivered. A small **P0 hotfix bundle** (doc 01, Part F) turns all three failures off without
rebuilding anything. See doc 01 for the full evidence and the updated register.
