# Digest of the Existing Authentication Plan — Ground Truth for the New 12-Doc Centralized-IdP Suite

**Purpose.** This digest lets the team writing the NEW 12-document centralized-IdP design suite build on the
existing `Authentication plan/` tree (repo root) plus its planning-doc and ADR substrate **without re-reading
everything**. Everything below is sourced from those docs as of 2026-07-06. Conventions the new suite MUST
inherit: status vocabulary is exactly `Implemented | Partial | Stub | Planned | Absent`; every codebase claim
carries a `file:line` anchor; every external claim a source URL; gaps carry stable `AUTH-###` IDs from
`Authentication plan/11-gap-register.md` (extend the register, never renumber or re-litigate).

---

## 1. What each existing document covers

### `Authentication plan/` (repo root)

| Doc | Covers |
|---|---|
| `00-README.md` | Hub + executive summary: what's solid (crypto/session core, TOTP, rate-limiting, RLS tenancy, admin settings surfaces), the 8 top gaps, roadmap-at-a-glance, and the two-priority-axes warning. |
| `01-enterprise-benchmark.md` | The external yardstick (NIST SP 800-63B-4, OWASP ASVS 5.0, FIDO/CISA passkeys, OpenID CAEP/SSF, Okta/Entra/WorkOS admin catalogs) with per-domain "expected settings/knobs" lists. Records AUTH-043 (no mobile) and AUTH-044 (no push) scope decisions. |
| `02-current-state-backend.md` | As-built backend (`packages/auth`, `packages/db`) by capability with status words. |
| `03-current-state-flows-frontend.md` | As-built flows/screens (`apps/auth`, `apps/web`, `apps/admin`), incl. the JWKS-under-`/auth` basePath note. |
| `04-settings-inventory.md` | Every auth setting that exists today, admin-side and user-side, with write-field allowlists. |
| `05-planned-not-built.md` | Designed-but-unbuilt inventory (sections A–K): real OIDC/SAML, SCIM protocol, policy enforcement, MFA methods, members API, `/account/security`, platform-admin tail, machine/API auth, lifecycle edge cases. Corrects the record: role guards + `org_role`/`platform_staff` migrations (D) and both Phase-0 security fixes (I) are **already built**. |
| `06-gap-analysis.md` | Benchmark-vs-TruePoint scoring by severity (Critical/High/Medium/Low = enterprise-deal impact). Headline: primitives are strong; the enterprise-touching edges (real SSO, SCIM deprovision, self-service, policy *enforcement*) are the blockers. "A stored knob that does not gate a real login is not an enforced control." |
| `07-recommended-settings.md` | Net-new admin-side (§3) and user-side (§4) settings to plan, each with **business priority** P0–P3 + a mapping column to the delivery wave, skill owner, and enterprise precedent. |
| `08-roadmap.md` | The **delivery-wave** sequencing P0→P3 (+P3+ build-or-decide, + a parallel operate-and-comply wave), each row with status, S/M/L/XL effort, dependency, owning skill, "Must FAIL" acceptance criteria, new-contract and verification lines. |
| `09-threat-model.md` | Per-surface security **ship gates** (negative-test suites): SAML validation (XXE/XSW/unsigned/replay/C14N/alg-downgrade), OIDC id_token validation, SSRF on metadata/JWKS fetch, SCIM deprovision race + token abuse, MFA integrity (downgrade/enrollment trust), IdP-initiated SSO, open redirects, mass-assignment, session/CSRF/CSP/cookie invariants, account-recovery abuse. |
| `10-operations-and-compliance.md` | Operate-and-comply layer: auth SLIs + alert thresholds, SLOs + the documented Redis fail-open degraded mode, signing-key rotation + compromise runbooks, KMS data-key custody gap (`secrets.ts:9` runs a dev-derived key), DSAR/retention of auth artifacts (pseudonymize audit, don't delete), IR + GDPR-72h/DPDP breach clocks, email/SMS deliverability, residency map, FinOps, consent/lawful basis for risk profiling. |
| `11-gap-register.md` | The traceability spine: 60 `AUTH-###` rows (1 Critical, 13 High, 28 Medium, 18 Low), all 6 former open decisions now `Decided`; Part 2 = the delivery-risk register; Part 3 = S/M/L/XL sizing + the XL long-poles. |

### `Authentication plan/implementation/` (apply-ready specs)

| Spec | Covers / status |
|---|---|
| `00-README.md` | Wave-status table + mandatory gates (`bun run typecheck`, `biome check`, `lint:boundaries`, named tests). Code authored without a runtime — gates must be run before commit. AUTH-015's near-term action (remove dead Google button) is done. |
| `P0-01` | Pre-tenant auth audit events: `password.reset.request` → `platform_audit_log` (tenant-less, no row for unknown email), `password.reset.complete` → `audit_log` when exactly one tenant resolves else platform log; implements ADR-0031 + a new closed `platformAuditAction` Zod enum (ADR-0032, Accepted). Code written, gates pending. |
| `P0-02` | Password policy (12-char floor, 128 max, NO composition rules) + HIBP k-anonymity breach screening, **fail-open**, single server-side gate in `packages/auth/src/passwordPolicy.ts`/`breachCheck.ts` used by registration + reset. Code written. |
| `P1-01` | Auth-policy **enforcement** on login: forced in-login TOTP enrollment (`mfa_enroll` LoginStep → `/mfa/enroll`), allowed-methods gate (txn carries `method`, enforced at `finalizeLogin` post tenant-resolution), IP-allowlist CIDR gate (fail-closed per malformed entry), idle+absolute session timeout on refresh. All AND-ed behind a per-tenant `tenant_auth_policies.enforcement_enabled` (staff-set, default OFF) × an `AUTH_POLICY_ENFORCEMENT_ENABLED` master arm, with an audited super_admin break-glass at `POST /api/v1/admin/tenants/:id/auth-enforcement`. `require_sso` enforcement deliberately deferred to P2 adapters. Code written. |
| `P1-02` | `/account/security` on the auth origin (`apps/auth`, per ADR-0016 — never `apps/web`): password change (step-up + revoke-all-but-current), TOTP enroll + recovery codes (shown once), own-session list/revoke, login history; WCAG 2.2 AA + i18n + CSP-no-regression are ship gates. Code written, needs browser verification. |
| `P1-03` | Workspace Members API (list/invite/role/remove) mirroring the shipped `sessionRoutes.ts` pattern (`authn`→`tenancy`→`requireRole("owner","admin")`), role allowlist, owner-unremovable, idempotent invite, `member.*` audit PENDING→WRITTEN. Code written. |
| `P2-01`/`P2-02` (no files, README rows) | Real OIDC/SAML **blocked** in the authoring env (`arctic`/`@node-saml` not installed) — hand-off = the spec + doc 09. SCIM 2.0 `/scim/v2/Users` with bearer-token auth + deprovision-revokes-sessions is code-written. |

### Substrate planning docs (`docs/planning/`)

| Doc | Covers |
|---|---|
| `17-authentication.md` | The original auth design: dedicated origin `auth.truepoint.in` as internal IdP/BFF, progressive identifier-first login, the Lucia/arctic/@oslojs/@node-saml/argon2 library stack, multi-tenancy auth model, MFA/SSO/SCIM designs. Partially stale — the plan tree corrects it against code. |
| `28-enterprise-readiness-audit.md` | Full-corpus enterprise audit (`G-…` gap IDs); source of G-AUTH-10 (one owner bit blocks delegated admin) that produced ADR-0030. |
| `29-settings-administration-architecture.md` | The settings registry model: typed registry in `packages/types`, scopes `platform → tenant → workspace → team → user`, **security-class settings resolve strictest-wins / preference-class nearest-wins**, effective-value API (`GET /settings/effective`), `settings.update` audit on every mutation. **This is the closest existing thing to "centralized config-driven" and the new suite should build its config engine on it.** |
| `admin-auth-buildout-plan.md` | The 4-phase admin/auth-admin buildout (Phase 0 security → roles → provider API → admin expansion). Historical in places: its Phase-0 "live vuln" and Phase-1 guards are already fixed/built in the tree — read status from `08-roadmap.md`'s snapshot-reconciliation table, not from this doc. |

---

## 2. Canonical decisions already made (the ADRs — do not re-decide these)

| ADR | Decision (one line) |
|---|---|
| **ADR-0016** | `auth.truepoint.in` is a dedicated internal IdP/BFF: the durable (Lucia-style) refresh-backed session lives ONLY on the auth origin; the app gets tokens via a single-use, 60-s, Redis-held, PKCE+IP+origin-bound authorization code exchanged for a ~15-min EdDSA JWT verified against a published JWKS. Tokens never appear in URLs; the app holds the access token in memory only. |
| **ADR-0017** | Login is progressive **identifier-first**: email entered first, email **domain → tenant/SSO routing** via a `tenant_domains` table (claim + DNS-TXT verify), exactly one Step-2 path (password/SSO/magic/passkey/social). |
| **ADR-0018** | Auth policy at two scopes (`tenant_auth_policies` + workspace subset) resolved **strictest-wins** — a child scope may only tighten, never loosen; effective policy computed at login and refresh. |
| **ADR-0019** | **Global identity + membership**: `users` is one global row per person (global UNIQUE email/username; credentials/MFA/sessions hang off it, NOT tenant-RLS-scoped); org membership lives in `tenant_members`; the person authenticates first, then picks org → workspace. Per-workspace data isolation (ADR-0006) unchanged. |
| **ADR-0020** | The identifier step **deliberately reveals account existence** (exists → correct step-2; not exists → signup), the Google/Slack pattern — an explicitly accepted deviation from strict anti-enumeration, mitigated by Turnstile + per-IP/per-identifier rate limits + progressive lockout + audit ("throttled, not hidden"). |
| **ADR-0030** | **Granular org roles**: `tenant_members.org_role ∈ owner | billing_admin | security_admin | compliance_admin | member` (delegated administration); workspace roles and team roles remain orthogonal — three separate role tiers, never one enum. |
| **ADR-0031** | **Auth-event audit tenancy**: tenant-resolved auth events → tenant `audit_log`; pre-tenant/tenant-less events (`login.failure`, `password.reset.request`, `mfa.challenge`, `signup`) → `platform_audit_log`; auth audit is best-effort/swallow-on-failure by design (never throws into the auth flow). |
| **ADR-0034** | **Bootstrap platform admin** (interim): `users.is_platform_admin` flag on the global customer identity → signed `pa` JWT claim → deny-by-default `platformAdmin` guard on `/api/v1/admin/*`; cross-tenant reads/writes only via the audited `withPlatformTx` owner path writing `platform_audit_log`; `.env` is the provisioning source of truth (repeatable, not one-shot). |
| **ADR-0040** | **Source of truth + session hardening**: the durable `user_sessions` row is authoritative for {user, active org, active workspace, validity}; access-token claims (`tid`/`wid`/`sid`/`pa`) are a ≤15-min projection; `role` is derived per-request from `workspace_members` (never stored in a token); plus the hardening set (pa-on-refresh, revocation deny-list, revoke-on-reset, brute-force lockout, refresh-reuse family revocation, clientIp fix). |
| **ADR-0043** | (context) The Chrome extension is MV3, service-worker-as-hub, least-privilege, thin-producer — explicitly NOT the Apollo-style Voyager-API harvesting posture; `externally_connectable` reserved for `app.truepoint.in`. |
| **ADR-0045** | **Extension auth = companion window**: interactive login opens the real web login in a popup window + `externally_connectable` handoff (supersedes ADR-0044's `launchWebAuthFlow` Model A, which provably cannot work against this IdP); no refresh token is ever held by the extension client. |

Changing any of these requires a superseding ADR, not a redesign-in-place (repo convention: decision-log row + ADR status + doc update).

---

## 3. The two priority axes + the S/M/L/XL sizing (inherit verbatim)

- **Business priority (doc 07)** = how badly an enterprise needs a setting (P0 deal-blocking → P3 nice-to-have).
- **Delivery wave (doc 08)** = dependency-sequenced ship order (P0 correctness → P1 enforcement+self-service → P2 federation → P3 modern/zero-trust).
- These are **independent axes** and can disagree — the canonical example: **passkeys are P0 business priority but P3 delivery wave**, because self-service passkey enrollment depends on the P1b `/account/security` wizard. Doc 07 carries a mapping column so both are visible.
- **Severity** (docs 06/11: Critical/High/Medium/Low) is a **third** independent thing — enterprise-deal impact of a gap.
- **Effort scale (docs 08/11):** **S** ≤ ½ day (reuse an existing primitive/sink) · **M** 1–2 days (bounded endpoint/gate, at most a small additive schema change) · **L** ~1 week (net-new feature with its own tables/API/isolation tests) · **XL** multi-week/specialist (protocol-correctness or ceremony work where the doc-09 security ACs are the ship gate).

Any new doc that assigns P0–P3 labels MUST say which axis it means, or it recreates the collision AUTH-005 fixed.

---

## 4. The six recorded build-or-defer decisions (register shows 0 open)

| ID | Decision |
|---|---|
| **AUTH-015 (social login)** | Decided: hide the dead "Continue with Google" button now (done in `apps/auth`); build the full OAuth social login later, in the **P3 delivery wave with the federation work** (it reuses the SSO seam + id_token validation): `/oauth/*` routes, social-provider config surface, email-verified account-linking, `disableSocial` enforcement. |
| **AUTH-043 (mobile/native)** | Decided: **no native/mobile client in scope** for the existing plan — the cross-domain code + HttpOnly refresh-cookie model assumes a browser origin. A future native client is a separate workstream that must use system-browser OAuth/PKCE (`ASWebAuthenticationSession`), Keychain/Keystore token storage, biometric unlock, and passkeys on mobile. |
| **AUTH-044 (push MFA)** | Decided: push-as-a-factor is **out of scope** (no push infrastructure exists); MFA direction is TOTP today → WebAuthn/passkeys next; revisit only if a push channel is ever built (then with number-matching + anti-push-bombing per ASVS V6.6.4). |
| **AUTH-045 (authorization maturity)** | Decided: custom roles, field-level permissions, separation-of-duties, JIT elevation are **out of scope for the auth plan** — deferred to a separate IAM/RBAC track owned by truepoint-data + the access-control workstream; only access-review/certification stays auth-adjacent. |
| **AUTH-048 (DRI model)** | Decided: items are assigned to **owning `truepoint-*` skills, not named people** (the repo's multi-agent operating model); add a named DRI per item alongside the skill at delivery-team handoff. |
| **AUTH-054 (field-level perms)** | Decided: per-field read/write permissions are owned by truepoint-data + truepoint-security (access control), not built in the auth subsystem — but auth surfaces returning PII (login history, active sessions) must apply per-role response shaping. |

The new suite may **supersede** these (mobile in particular — see §7) but must do it explicitly, citing the ID.

---

## 5. The XL long-poles (the critical path; specialist work with doc-09 ship gates)

1. **Real OIDC adapter (`arctic`)** — authorize → code → id_token sig/iss/aud/nonce/exp + PKCE + state → attribute map → JIT, behind the existing `SsoProvider` interface (today `packages/auth/src/sso/providers.ts:16-26` **throws**; prod fails closed). JWKS/discovery fetch through the SSRF guard.
2. **Real SAML adapter (`@node-saml/node-saml`)** — with **AUTH-001 (the plan's only Critical)** as ship-blocking gates: a checked-in known-malicious negative-test suite (XXE/DOCTYPE reject, every XSW variant, unsigned + Response-only-signed reject, `Conditions`/audience/recipient/`InResponseTo` + replay cache, exclusive-C14N, algorithm allowlist) must ALL fail before SAML is enabled for any tenant. Note `@node-saml`'s CVE history (CVE-2025-29774/29775). IdP-initiated SSO is out of the first release by default.
3. **SCIM 2.0 (`/Users` + `/Groups`) + deprovisioning automation** — RFC 7644 CRUD behind `scim_tokens` bearer auth, group→role mapping, and the enterprise-defining asymmetry: IdP deactivate → `revokeAllSessionsForUser` + record reassignment, with a **documented, tested stale-access bound** (seconds healthy; worst case ≤15-min access-token TTL when the Redis deny-list fails open). Groups + deprovision are what the code-written P2-02 Users spec does not fully cover.
4. **WebAuthn/passkeys** — registration + assertion ceremony (origin/RP-ID binding, attestation policy, counter-regression/clone + challenge-replay rejection), a `webauthn_credentials` FORCE-RLS table; sequenced after the P1b wizard it enrolls through; then passkey-first/phishing-resistant enforcement (synced-vs-device-bound policy for privileged roles).
5. **CAEP / Shared Signals (SSF)** — transmitter + receiver for standardized cross-service revocation signals (OpenID CAEP 1.0 final); lowest urgency of the XLs.
6. **The `/account/security` build** — the net-new user self-service spine on the auth origin (route shell, password change, MFA/recovery management, own sessions, login history); Absent today (the customer-app `SecurityPanel` deep-links to a 404 and fakes `enrolled:false`); P1-02 spec is code-written but browser-unverified. Several P1a/P3 items dead-end without it.

---

## 6. The delivery-risk register (11 Part 2) — the six ways building this goes wrong

| Risk | Mitigation the plan mandates |
|---|---|
| **`require_sso` flipped ON against the Stub adapter = org-wide lockout** (prod `getSsoProvider` returns the throwing adapter). Likelihood High / Impact High. | Per-tenant **default-OFF** flag; the API **rejects enabling `require_sso` while the adapter is the Stub** — only a passing test-connection against the real adapter unlocks the flip; a documented, audited **break-glass** local login for `owner`. |
| **Enforcement-flag lockout** (session-timeout / allowed-methods / IP-allowlist suddenly enforced; a misread CIDR locks the tenant out). | Every lockout-capable control ships behind a per-tenant default-OFF flag with a **staged rollout (observe-only → soft-fail → enforce)** and a break-glass disable that needs no deploy; **CIDR-match, never string equality**, plus a client-IP-spoofing guard. |
| **Forced MFA with no enrollment screen locks members out** (`flow.ts` throws `mfa_required`). Likelihood High / Impact High. | Ship the **in-login forced-enrollment step first** (or atomically with the hard gate); bind enrollment to the authenticating user's partially-authenticated transaction. |
| **SMS/OTP metered cost + OTP-bombing/toll-fraud pumping.** | Rate-limit OTP issuance per identifier/IP; per-tenant spend caps + runaway-spend alert; SMS stays a **discouraged fallback only** (never primary, per ASVS V6.6.1); single-use short-TTL codes. |
| **HIBP breach-screening external dependency** (a SHALL per NIST, but an outbound service that can be slow/down). | k-anonymity range API (candidate never leaves the server), prefix caching, **fail-open to a local top-N blocklist on outage** (never block a legitimate set/change), cost attributed in FinOps. |
| **Signing-key compromise** (a leaked EdDSA key forges tokens until expiry). | Rotation runbook (overlapping `kid`s, publish-before-sign, ≥15-min propagation, drain, retire); emergency procedure skips the drain (rotate + remove key + deny-list all sessions + force global re-auth + 72-h breach clock); move at-rest custody off the dev-derived key (`secrets.ts:9`) to KMS envelope encryption. |

General rule inherited from these: **every control that can lock a tenant out of its own login ships default-OFF per tenant with a break-glass**, and no enforcement flip goes live without its observability dashboard (doc 10).

---

## 7. Where the NEW 12-doc request EXCEEDS the existing plan — net-new scope the docs must add

The existing plan is a **gap-closure plan for the current IdP**: it wires enforcement, self-service, federation, and ops onto strong primitives. The new request is a **product-ization of the IdP itself**. Net-new scope, per pillar:

1. **Centralized, config-driven IdP.** The existing plan enforces policy via per-feature gates and per-tenant flags; there is **no single declarative configuration engine** that drives all auth behavior. The new suite must design one — and should build it on the doc-29 settings-registry model (typed registry in `packages/types`, `platform → tenant → workspace → user` scopes, strictest-wins for security-class settings, effective-value API, `settings.update` audit) rather than inventing a parallel mechanism. It must subsume, not replace, `tenant_auth_policies` + `resolveEffectivePolicy` (ADR-0018).
2. **Platform-admin auth console (configure everything without code).** Today the platform console has tenants/flags/provider-configs/staff-RBAC/audit, and P1-01 adds exactly one staff auth toggle (per-tenant enforcement + break-glass). There is **no platform-level console for login methods, MFA policy, SSO/SCIM, branding, or rollout of auth features across tenants**. Net-new surface in `apps/admin`; every write via `withPlatformTx` + `platform_audit_log` + `requireStaffRole` (ADR-0034), with the staff-app hardening items (mandatory phishing-resistant staff MFA, IP allowlist, step-up before high-blast-radius actions — AUTH-021) as prerequisites.
3. **Full login-methods matrix.** Existing plan: password + magic + TOTP live; SSO/SMS/email-OTP/WebAuthn Stub; social decided-deferred (AUTH-015). The new suite must specify the **complete configurable matrix** (password, magic link, email/SMS OTP, TOTP, WebAuthn/passkeys, social OAuth providers, enterprise SAML/OIDC, and their per-tenant/per-role enable-disable + strength targets) as data-driven config — honoring the ladder in doc 01 (email is never an authenticator, ASVS V6.3.6; SMS fallback-only) and the allowed-methods/strictest-wins semantics already built.
4. **Org white-label / login portals.** **Entirely absent** from the existing plan — no per-tenant branded login page, custom login domain/vanity URL, theming, or per-org portal exists or is specced. Net-new: must respect ADR-0016 (all credential surfaces stay on the auth origin), ADR-0017 (domain → tenant routing via verified `tenant_domains` is the natural hook), the strict nonce-CSP invariant (doc 09), and open-redirect allowlisting for any new per-org origin.
5. **User self-service dashboard.** The existing plan covers this **partially**: P1-02/`/account/security` (password, TOTP, recovery codes, own sessions, login history) is code-written, and doc 07 §4 plans passkeys, trusted devices, connected accounts, sign-in alerts, email change, recovery setup. The new suite extends this to a full account dashboard — it must **build on the P1-02 spec** (auth-origin-only, step-up on every mutation, WCAG 2.2 AA + i18n + CSP as ship gates), not respec it.
6. **Developer platform: OAuth server + webhooks + SDKs.** Existing plan has only a P3+ "machine/API authentication" build-or-decide item (scoped PATs, service accounts, OAuth2 **client-credentials**, HMAC-signed webhooks with replay windows, an explicit mTLS decision — doc 05 §J, doc 08 P3+). It does **not** include TruePoint acting as a **third-party OAuth 2.0/OIDC authorization server** (authorization-code grant for external apps, consent screens, app registry, scopes), an auth-events webhook product, or client SDKs. All net-new; the token-lifecycle discipline (hash-at-rest, shown-once, revocable, last-used) is already patterned by the SCIM token. |
7. **Mobile.** Explicitly **decided out of scope** (AUTH-043). Bringing mobile in means the new suite must formally **supersede AUTH-043** with the pattern that decision already prescribes: system-browser OAuth/PKCE (`ASWebAuthenticationSession`/Custom Tabs), Keychain/Keystore token storage, biometric unlock, passkeys on mobile — and reconcile it with the browser-assuming code-exchange model of ADR-0016 (the extension companion-window work, ADR-0045, is the precedent for extending that model to a new client class). |

**Constraints the doc authors must honor across all seven:** the doc-09 threat gates are ship-blockers (esp. AUTH-001 for SAML); lockout-capable config ships default-OFF + break-glass (Part 2 register); security has final say and platform owns RLS/API contract/scale (CLAUDE.md precedence); code identity stays `@leadwolf/*` while the brand is TruePoint; new tenant-scoped tables are `tenant_id NOT NULL` + FORCE-RLS with cross-tenant isolation tests; auth events route per ADR-0031; and every new doc uses the exact status vocabulary, `file:line` citations, `AUTH-###` traceability, and the two-axes priority convention.
