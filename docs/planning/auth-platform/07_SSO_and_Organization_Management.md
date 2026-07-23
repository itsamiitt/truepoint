# 07 — SSO & Organization Management

> Document 7 of 12 · TruePoint Centralized Authentication Platform. Enterprise SSO (SAML/OIDC), SCIM provisioning, domain
> verification, JIT, org branding/portals, and role/group mapping. Extends `Authentication plan/07-recommended-settings.md`
> + `08-roadmap.md` and the threat model (doc 09). The **AUTH-001 real-SAML-validator** item is this document's critical
> long-pole.
>
> **Research note:** the enterprise-SSO/SCIM research agent was interrupted; the SAML-vulnerability and build-vs-buy guidance
> below draws on the partial deep-research run (WorkOS/Auth0 pricing, Ory Polis, the 2025 SAML CVE class) plus standards and
> current patterns. Full live-source citations land in doc 02 once the sweep re-runs.

## Executive summary

TruePoint has the **scaffolding** for enterprise SSO — per-org config storage, transactions, callbacks, JIT, home-realm
discovery — wrapped around a **hollow core**: the real SAML and OIDC adapters **throw in production** (`arctic`/`@node-saml`
unwired); only a dev mock IdP works. SCIM **Users** is genuinely built (bearer-gated, tenant-scoped, deprovision revokes
sessions within a bounded window), but **Groups + group→role mapping** and **instant deprovision** are not, and **domain
DNS-TXT verification** is deferred. This document specifies the enterprise SSO/SCIM/org story and — most importantly — the
**security gates that must be ship-blockers**, because getting SAML validation wrong is the difference between selling to
enterprises and shipping an authentication-bypass.

## 1. Organizations model (maps onto TruePoint's two-tier tenancy)

TruePoint already has the right shape: **one global identity** (`users`) with **membership** (`tenant_members`) into orgs,
and a **two-tier tenant/workspace** hierarchy. This matches the Auth0/Clerk/WorkOS "Organizations" model. Per-org:

- **Auth policy overrides** (strictest-wins) — allowed methods, MFA-required, session/password overrides (docs 03/09).
- **Branding + login portal** — org logo/colors, a portal slug (`auth.truepoint.in/<org-slug>`) or vanity domain (doc 04).
- **SSO connections** — one or more IdPs per org (`auth_providers`).
- **Membership** — multi-org users (one identity, many orgs); invitations (expiring, role-carrying, `invitations.ts`);
  verified-domain **auto-join** with hijack safeguards.
- **Hierarchy** — org → workspaces/teams (the existing `workspace_members`).

**Verified-domain auto-join hijack risk:** capturing users by email domain is powerful and dangerous — a domain must be
**DNS-verified** before auto-join is honored, and `join_policy` (`sso_only | auto_join | request_access`) governs what
verification unlocks. This is why the deferred DNS-TXT worker (`AUTH-041`) is a real gap, not a nicety.

## 2. Enterprise SSO — the security-critical build

### 2.1 SAML 2.0 (AUTH-001, the only Critical)

`@node-saml` is planned but unwired; the adapter throws in production. Wiring it is **not** the hard part — **validating
assertions correctly is**, and the 2025 SAML CVE class makes this non-negotiable:

- **Signature-wrapping / XSW** — the classic SAML attack; an attacker wraps a forged assertion around a validly-signed one.
- **Signature confusion / assertion forgery** — the "SAMLStorm" class (e.g. CVE-2025-29775 / CVE-2025-29774 in xml-crypto and
  downstream libraries; CVE-2025-54419 signature-verification bypasses) that let an attacker forge SAML responses and bypass
  authentication across major SAML libraries in 2025. This is precisely why the register lists AUTH-001 as a **ship-blocker
  with negative-test suites**, not a follow-up.
- **XXE** — external-entity injection in the XML parser.
- **Missing checks** — audience / recipient / destination / `NotOnOrAfter` / clock skew; **reject-unsigned** assertions and
  responses.

**Ship gates (from doc 09, must all pass before enablement):** anti-XXE, anti-signature-wrapping, reject-unsigned,
audience/recipient/destination validation, replay defense, and — since the library ecosystem itself has been the vulnerability
— a **pinned, patched, monitored** SAML dependency with a negative-test suite (samltest.id + crafted malicious assertions).
**Build-vs-buy is a live decision** (doc 02): a maintained SAML bridge (e.g. **Ory Polis**, the Apache-2.0 continuation of
BoxyHQ Jackson, which converts SAML→OIDC so TruePoint's IdP consumes it as an ordinary OIDC provider and keeps minting its
own tokens) can move the assertion-validation risk to a specialized, maintained component — attractive given the CVE history
of DIY SAML in Node/TS.

- **IdP-initiated SSO (AUTH-035):** default to **SP-initiated**; if IdP-initiated is supported, bind to a pre-registered ACS
  and add replay defense.
- **SP metadata + cert rotation:** publish SP metadata; support IdP cert rotation without downtime.

### 2.2 OIDC (AUTH-008)

`arctic` planned but unwired. Real code-flow with **id_token validation**: signature (against the IdP's JWKS,
**SSRF-guarded** fetch, `AUTH-009`), `iss`/`aud`/`nonce`/`exp`, PKCE, and `state`. Federation to external IdPs (Okta, Entra,
Google Workspace) as provider instances in the registry — no bespoke code per IdP.

### 2.3 Home-realm discovery & domain verification

Identifier-first routing (`domainResolver`, ADR-0017) maps an email domain → the org's IdP. **Domain verification via DNS
TXT** (`AUTH-041`, deferred) must ship so a claimed domain is proven before it routes logins or auto-joins users — the same
flow WorkOS/Auth0/Entra use. Until verified, a domain sits `pending` and grants nothing.

### 2.4 The no-lockout guard (AUTH-031)

`require_sso` **cannot be enabled** while the org's real adapter returns the throwing stub — only a passing **test-connection**
against the real adapter unlocks the flip, and a documented, audited **break-glass** owner local-login always remains. This
is the #1 delivery risk (org-wide lockout) and its mitigation is mandatory.

## 3. SCIM 2.0 provisioning

- **Users — Implemented** (`features/scim/*`, `/scim/v2`, RFC 7643/7644): bearer-gated (SHA-256 hash-only `scim_tokens`,
  tenant-scoped, rate-limited), tenancy from the token never the body, RFC-7644 error envelope, idempotent, deprovision
  revokes membership + all sessions.
- **Deprovision timing (AUTH-010/066):** currently bounded — the deny-list **fails open** on Redis (≤15-min residual) + a
  ~30s refresh grace. Enterprises expect **immediate** off-boarding; close this with deny-list observability + a CAEP signal
  (doc 03 §8) and state the bound honestly.
- **Groups + group→role mapping — TODO** (`identityRoutes.ts:18`): `/scim/v2/Groups` CRUD + mapping directory groups to
  TruePoint roles (the enterprise "manage access from our directory" requirement).
- **Conformance to build out:** PATCH semantics, filter support, ETag/optimistic concurrency, and the deprovision→session-
  revoke path with a **tested stale-access bound**.

## 4. JIT provisioning & role/group mapping

- **JIT (Implemented, `sso/jit.ts`):** create-on-first-SSO-login → `joinOrg` at a default role, idempotent; reused by SCIM.
- **Role/group mapping (target):** map IdP claims / SCIM groups → TruePoint `org_role`/`workspace_members.role`, with a
  **mass-assignment allowlist** — no `org_role`/`is_platform_admin` settable from an IdP claim (`AUTH-034`).

## 5. Org branding & login portals

Per-org branding + a login portal (org-slug URL or vanity domain), config-driven (doc 04, `auth_branding`). The self-service
**SSO setup wizard** (the WorkOS admin-portal pattern — the customer's IT admin configures their own SSO/SCIM) is the
deal-winning UX; it includes test-connection so the customer can validate before enabling.

## 6. The "SSO tax" checklist (what enterprises demand)

Audit logs (✓ via auth events + `platform_audit_log`), SCIM deprovisioning (partial), session controls (mostly built,
flagged), MFA enforcement (built, flagged), SSO enforcement (needs the no-lockout guard + real adapter), multi-IdP per org
(target), back-channel logout/SLO (`AUTH-016`, target). This document's roadmap items (doc 12 Phase 4) close the gaps.

## 7. API specification (representative)

```
# SSO/SCIM admin (Management API, staff/tenant-admin RBAC)
GET/POST/PUT/DELETE /auth-admin/providers[/{id}]      SAML/OIDC connections (+/test, /metadata)
GET/POST /auth-admin/domains[/{id}/verify]            claim + DNS-TXT verify
POST /auth-admin/scim/tokens                          mint/list/revoke (shown-once)
# SSO runtime (IdP)
GET  /auth/sso/{oidc,saml}/start                      SP-initiated
POST /auth/sso/{oidc,saml}/callback                   assertion/id_token validation → JIT → session
# SCIM (RFC 7644, outside /api/v1, own bearer + error envelope)
/scim/v2/Users   (list/get/post/put/patch/delete)     Implemented
/scim/v2/Groups  (…)                                  TODO
```

## 8. Security considerations

- **SAML validation is the crown-jewel gate** — anti-XXE / anti-signature-wrapping / reject-unsigned / audience-recipient-
  destination / replay, with a pinned+patched library and negative tests (`AUTH-001`). Getting this wrong is an auth bypass.
- **SSRF-guard** all IdP metadata/JWKS/discovery fetches (`AUTH-009`).
- **No-lockout guard** on `require_sso` + break-glass (`AUTH-031`).
- **Mass-assignment allowlists** on JIT/SCIM role mapping (`AUTH-034`).
- **Domain verified before it routes/auto-joins** (`AUTH-041`).
- **Deprovision revokes sessions promptly**; state the ≤15-min fail-open bound (`AUTH-010/066`); emit CAEP for downstream.
- **SCIM tokens** hash-only, tenant-scoped, revocable, rate-limited (Implemented).

## 9. Non-functional, testing, migration, risks

- **Testing:** SAML negative suite (XSW/XXE/unsigned/forged — must all FAIL to authenticate); OIDC id_token validation
  suite; SCIM deprovision→session-revoke within the stated bound; domain-verify gates routing; no-lockout guard blocks
  enabling against the stub; cross-tenant isolation on provider/config tables.
- **Migration:** ship the no-lockout guard first; wire the real adapters (or adopt a SAML bridge) behind test-connection;
  add DNS-TXT worker; add SCIM Groups; add SLO/back-channel logout — per doc 12 Phase 4.
- **Risks (register Part 2):** SSO-against-stub org lockout (guarded), SAML-validation flaws (ship-gates + build-vs-buy),
  deprovision residual window (observability + CAEP).
- **Future:** multi-IdP per org, encrypted assertions, CAEP/SSF transmitter, SCIM Groups→fine-grained roles (with the
  separate IAM track), automated SP-cert rotation.
