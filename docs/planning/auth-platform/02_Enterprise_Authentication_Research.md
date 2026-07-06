# 02 — Enterprise Authentication Research

> Document 2 of 12 · TruePoint Centralized Authentication Platform. Benchmarks the enterprise IdP landscape and the standards,
> and distills a **best-practice register (`BP-###`)** the other 11 documents cite.
>
> **Provenance & honesty note.** The 20-agent live-source research sweep planned for this document was **interrupted by an
> account-level block** (Consumer-Terms re-acceptance + a usage-limit reset). This doc is therefore assembled from three
> solid sources: (1) the repo's existing, heavily-cited `Authentication plan/01-enterprise-benchmark.md` (standards +
> leading-IdP surfaces); (2) the **partial deep-research run** that *did* complete (WorkOS/Auth0 pricing, Ory Polis, the 2025
> SAML CVE class, Okta India residency); and (3) standards/vendor knowledge current to early 2026. Where a platform-specific
> claim needs a live citation it is marked **[verify]**; re-running the sweep after the block clears deepens those. The
> standards content (NIST/ASVS/RFC/FIDO/CAEP) is fully cited from the existing benchmark.

## Executive summary

The enterprise IdP field splits into three archetypes, and TruePoint should borrow deliberately from each: **developer-first
SSO/SCIM layers** (WorkOS, Clerk, Stytch, Descope, PropelAuth, Scalekit) that make enterprise connections a self-service,
per-connection product; **full IdP suites** (Auth0/Okta, Entra, Cognito, Firebase/GCIP) with deep policy/admin surfaces and
Conditional-Access-style risk engines; and **self-hostable OSS** (Keycloak, Ory, Zitadel, FusionAuth, SuperTokens, Authentik)
that TruePoint most resembles, since it runs its own IdP. The consistent lessons: **organizations are first-class**, **SSO/
SCIM are the enterprise deal-gate**, **passkeys are the MFA direction**, **the admin console configures everything without
code**, and **deprovisioning (not login) is the hard enterprise requirement**. The `BP-###` register (§4) turns these into
concrete, stack-specific practices; the build-vs-buy analysis (§5) frames the one genuinely open decision — DIY SAML vs a
maintained bridge — against a 2025 CVE class that makes DIY SAML validation a specialist, high-risk undertaking.

## 1. Standards baseline (fully cited)

The yardstick (from the existing benchmark; sources inline):

- **NIST SP 800-63B-4** (final, Jul 2025) — AALs. **AAL2 is the realistic B2B floor** and requires a phishing-resistant option
  be *available*; **AAL3 forbids syncable authenticators** (hardware keys for privileged staff).
  <https://pages.nist.gov/800-63-4/sp800-63b.html>
- **Password guidance (the modern inversion):** ≥8 (MFA) / 15 (single-factor) min, allow ≥64, **no composition rules, no
  forced rotation**, **breach-screen** every new secret, no truncation/case-folding.
  (SP 800-63B §3.1.1.2; ASVS 5.0 V6.2) <https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md>
- **OWASP ASVS 5.0 V6** (May 2025) — documented+testable rate-limiting/anti-automation/**adaptive response**; TOTP ≤30 s;
  **SMS restricted, email prohibited as an authenticator**; push needs anti-bombing+number-matching (push out of scope for
  TruePoint, AUTH-044).
- **OAuth 2.0 Security BCP — RFC 9700** — code+PKCE everywhere; **refresh rotation + reuse detection → family revoke**.
  <https://datatracker.ietf.org/doc/html/rfc9700#section-4.14>
- **FIDO passkeys / CISA phishing-resistant MFA** — WebAuthn is the strongest tier; synced passkeys for staff, hardware keys
  for privileged. <https://fidoalliance.org/passkeys/> · <https://www.cisa.gov/sites/default/files/publications/fact-sheet-implementing-phishing-resistant-mfa-508c.pdf>
- **OpenID CAEP / Shared Signals** (final 2025; adopted by Google/Apple/Okta) — real-time cross-service revocation; the part
  most products lack. <https://openid.net/specs/openid-caep-1_0-final.html>
- **SCIM 2.0 — RFC 7643/7644** — `/Users`+`/Groups` CRUD; **deprovision is the enterprise-critical half**.
- **WebAuthn L3 / FIDO2 CTAP 2.2**, **DPoP RFC 9449**, **mTLS RFC 8705**, **PAR RFC 9126**, **RAR RFC 9396**, **Resource
  Indicators RFC 8707**, **Token Exchange RFC 8693**, **Device Grant RFC 8628** — the modern OAuth surface (doc 10).

## 2. Platform comparison matrix

> Rows = capability areas; cells = one-clause characterizations. `[verify]` marks a claim to re-confirm with a live source
> once the research sweep re-runs. Scroll horizontally.

<div style="overflow-x:auto">

| Capability | WorkOS | Auth0 / Okta CIC | Clerk | Entra ID | Cognito | Keycloak (OSS) | Ory | Zitadel (OSS) | FusionAuth |
|---|---|---|---|---|---|---|---|---|---|
| Archetype | SSO/SCIM layer | full IdP suite | dev-first B2B | enterprise suite | AWS-native | self-host suite | API-first components | self-host suite | self-host suite |
| Organizations | first-class | Organizations | Organizations | tenants/directory | user pools | realms + Orgs | projects/orgs | orgs/projects | tenants/apps |
| Login methods | bundled in AuthKit | broad | broad | broad | moderate | broad | Kratos flows | broad | broad |
| Token/session | issues OIDC assertion | JWT+refresh, rotation | JWT+refresh | JWT+refresh | JWT | JWT+refresh | Hydra OAuth2 | JWT+refresh | JWT+refresh |
| SSO/SCIM | **core product**, self-serve portal | full | add-on | full | limited SCIM | full | via Polis/Hydra | full | full |
| Admin console | connection-focused | deep | polished | deep (Conditional Access) | basic | deep, complex | sparse (API-first) | good | good |
| Branding / white-label | strong | strong | strong (components) | limited | limited | themeable | headless | good | good |
| API/SDK design | excellent | excellent | excellent (React-first) | complex | AWS SDK | verbose | excellent (API-first) | good | good |
| Risk / adaptive | basic [verify] | **Adaptive MFA** | basic | **Conditional Access + Identity Protection** | basic | via extensions | via Oathkeeper | basic | moderate |
| Pricing model | **per-connection** SSO/SCIM + MAU | tiered + per-SSO-conn | MAU + add-ons | per-user licensing | per-MAU | OSS/self-host | OSS + Network | OSS + cloud | license/self-host |

</div>

**Pricing landmines (from the completed deep-research run):**
- **WorkOS** — SSO is **$125/connection/mo** (1–15), scaling to $50 (101–200), custom at 201+; **Directory Sync (SCIM) is
  priced identically and separately** — an enterprise needing both pays *two* per-connection charges. AuthKit MAU is **free
  to 1M**, then $2,500/mo per additional 1M, with passkeys/MFA/magic/social/SSO bundled. Source: <https://workos.com/pricing>.
- **Auth0 (B2B self-serve)** — Essentials **$150/mo** (3 SSO connections), Professional **$800/mo** (5); extra connections
  **$100/mo each, hard-capped at 30** — 100/500 connections force a custom Enterprise contract. Source: <https://auth0.com/pricing>.
- **Okta** positions **India data residency** explicitly for **DPDP** compliance (GA timing early 2026 [verify]). Source:
  <https://www.okta.com/newsroom/press-releases/okta-brings-data-residency-and-enhanced-disaster-recovery-to-india/>.

The pricing shape validates the build decision for TruePoint: at India-market scale with many enterprise connections, a
per-connection SSO/SCIM vendor bill grows fast — self-hosting the IdP (which TruePoint already does) avoids it, provided the
**SAML-validation risk** (§5) is handled by a maintained component.

## 3. What each archetype teaches TruePoint

- **WorkOS / dev-first SSO layers** → the **self-service SSO/SCIM admin portal** (the customer's IT admin configures their
  own connection, with test-connection) is the deal-winning UX; model SSO/SCIM as first-class, per-org, test-gated.
- **Auth0 / Okta / Entra** → the **admin console configures everything**; **Conditional Access** (if-then over user × risk ×
  location × device → grant/step-up/block) + **named authentication strengths** are the risk model to emulate (doc 09);
  **Adaptive MFA** is the friction-minimizing default.
- **Keycloak / Ory / Zitadel / FusionAuth (OSS, TruePoint's peers)** → realms/orgs as config, themeable branding, and the
  operational reality of running your own IdP (key rotation, upgrades, HA) — the work docs 03/10/12 make explicit.
- **Clerk / Stytch / Descope / PropelAuth** → **end-user self-service** polish (sessions, devices, passkeys, sign-in alerts)
  and component-level DX (doc 05).

## 4. Best-practice register (`BP-###`)

> Each is self-contained and cited by the other docs. Format: **practice** — why (standard/platform) — TruePoint application
> (with the `AUTH-###` delta where relevant).

### Organizations & tenancy
- **BP-001 — Organizations are first-class; one identity, many memberships.** Every major IdP models orgs as the unit of
  policy/branding/SSO. *TruePoint already has this* (`users` + `tenant_members`, two-tier tenant/workspace) — preserve it
  (doc 07).
- **BP-002 — Per-org policy as platform-default → org override, strictest-wins.** An org tightens, never loosens.
  *Generalize `tenant_auth_policies` into the effective-policy engine* (doc 03 §11).
- **BP-003 — Verified-domain auto-join is DNS-gated.** Capturing users by email domain requires DNS-TXT proof first.
  *Ship the deferred worker (AUTH-041).*

### Login methods & MFA
- **BP-004 — Passkeys/WebAuthn are the MFA direction; synced for staff, hardware for privileged.** (FIDO/CISA.) *Absent
  today (AUTH-024) — the primary MFA build (docs 05/09).*
- **BP-005 — SMS is fallback-only, email is not an authenticator.** (ASVS V6.6/V6.3.6.) *Guides doc 06's method policy.*
- **BP-006 — Modern password policy: length over composition, no forced rotation, breach-screen every secret.** (NIST/ASVS.)
  *TruePoint has Argon2id + HIBP — keep; expose min-length + breach-toggle as config (doc 04).*
- **BP-007 — Login methods are configuration, not code** (enable/priority/credentials/scopes/org-restrict/test/health).
  *The method registry (docs 04/06).*

### SSO / SCIM
- **BP-008 — Deprovisioning, not login, is the enterprise requirement.** SCIM must revoke sessions + reassign owned records
  promptly. *SCIM Users built; close Groups + the ≤15-min fail-open residual (AUTH-010/066).*
- **BP-009 — Self-service SSO/SCIM setup portal with test-connection.** (WorkOS.) *The deal-winning UX (docs 04/07).*
- **BP-010 — Never enable `require_sso` against an unvalidated adapter; always keep break-glass.** *The no-lockout guard
  (AUTH-031).*
- **BP-011 — SAML validation is a security ship-gate, not a wiring task** (anti-XXE/anti-signature-wrapping/reject-unsigned/
  audience-recipient-destination/replay). *AUTH-001 Critical; §5 build-vs-buy.*

### Tokens & sessions
- **BP-012 — Short access token + rotating refresh with reuse-detection family-revoke.** (RFC 9700.) *TruePoint meets/exceeds
  this — preserve.*
- **BP-013 — Immediate revocation via a per-request check, not token expiry.** *Deny-list exists; make fail-open observable
  and bound it (AUTH-066).*
- **BP-014 — Dual-key JWKS for zero-downtime rotation + a compromise runbook.** *Single-key today (AUTH-013) — add the `next`
  slot (docs 03/10).*
- **BP-015 — Sender-constrain public-client tokens (DPoP).** *The structural fix for the extension-token exfiltration risk,
  complementing scope enforcement (AUTH-065).*
- **BP-016 — CAEP/Shared Signals for cross-service revocation.** (OpenID CAEP.) *The enterprise "actually out of every app
  immediately" capability (AUTH-016 long-pole).*

### Admin, self-service, risk, ops
- **BP-017 — The admin console configures everything without code**, every write audited + RBAC-gated + versioned +
  reversible. *The largest net-new scope (doc 04).*
- **BP-018 — Full end-user self-service** (password, MFA/passkeys, sessions, devices, connected apps, API keys, history,
  alerts). *Built but unreachable (AUTH-062) + gaps (docs 05).*
- **BP-019 — Conditional-Access-style risk engine** (if-then over user×risk×location×device → allow/step-up/deny) + named
  authentication strengths. (Entra/Okta.) *Target (doc 09).*
- **BP-020 — Security-notification emails are the takeover tripwire.** *Absent (AUTH-067).*
- **BP-021 — Auth observability + SLIs before any enforcement flip.** *AUTH-012/022.*
- **BP-022 — Every lockout-capable control ships default-OFF, staged, break-glass.** *The delivery-risk discipline (doc 12).*

## 5. Build-vs-buy analysis

TruePoint already **builds** its IdP (ADR-0016), and the audit shows the core is sound — so the question is not "build the
whole IdP vs buy one," but **which high-risk components to build vs embed**:

- **SAML validation — the one genuinely open decision.** The 2025 CVE class (**SAMLStorm — CVE-2025-29775 / CVE-2025-29774
  in xml-crypto and downstream; CVE-2025-54419** signature-verification bypasses) let attackers forge SAML responses and
  bypass authentication across *major* SAML libraries — DIY SAML validation in Node/TS is a specialist, high-risk,
  ongoing-maintenance undertaking. **Option A (build):** `@node-saml` behind the AUTH-001 negative-test ship-gates, pinned +
  patched + monitored. **Option B (embed):** a maintained SAML→OIDC bridge — **Ory Polis** (the Apache-2.0 continuation of
  BoxyHQ Jackson; <https://github.com/ory/polis>) converts enterprise SAML into a standard OIDC flow so TruePoint's IdP
  consumes it as an ordinary OIDC provider and **keeps minting its own tokens** — moving the assertion-validation risk to a
  specialized component while preserving the first-party session model. **Recommendation:** strongly evaluate Option B for
  SAML specifically; it isolates the highest-risk code without giving up the self-hosted IdP or the token model. OIDC
  federation (arctic) is lower-risk to build.
- **Everything else — build.** Organizations, sessions/tokens, MFA/TOTP, SCIM Users, the admin console, and the OAuth server
  are already built or are standard to build on the existing stack; a per-connection vendor (WorkOS/Auth0) would add a
  growing per-connection bill (§2) and a second identity source of truth without removing the operational work TruePoint
  already does well.
- **Do not** adopt a vendor that becomes the identity source of truth — it fractures the RLS tenancy model and the global-
  identity design (ADR-0019). A **bridge** (Polis) or a **library** is compatible; a **replacement IdP** is not.

## 6. Anti-patterns (do not copy)

- **DIY SAML assertion validation without negative-test ship-gates** — the CVE class makes this the most dangerous shortcut
  (§5).
- **`require_sso` without a no-lockout guard** — the #1 way to lock out a whole org (BP-010).
- **Forced MFA without an enrollment path** — locks factor-less members out (AUTH-069).
- **Fail-open revocation with no alert** — a silent ≤15-min access window during a Redis blip (AUTH-066).
- **A named token scope no resource server enforces** — decorative security (AUTH-065).
- **Silent email failure** — telling the user "sent" when nothing was (AUTH-063).
- **Adopting a vendor as the identity source of truth** — fractures RLS tenancy (§5).

## 7. Standards index

| Spec | Relevance |
|---|---|
| NIST SP 800-63B-4 | AALs, password + reauth policy |
| OWASP ASVS 5.0 V6/V8 | authentication + self-service controls, adaptive response |
| RFC 9700 | OAuth 2.0 Security BCP (rotation, reuse detection) |
| RFC 6749/6819 + OAuth 2.1 draft | core OAuth + hardening |
| RFC 7636 | PKCE |
| RFC 9449 (DPoP) / 8705 (mTLS) | sender-constrained tokens |
| RFC 9126 (PAR) / 9396 (RAR) / 8707 (resource indicators) | high-assurance authorization |
| RFC 8693 (token exchange) / 8628 (device grant) | delegation, CLI/device |
| RFC 7009 (revocation) / 7662 (introspection) / 7591 (dynamic registration) | token + client management |
| RFC 7643 / 7644 | SCIM 2.0 provisioning |
| WebAuthn L3 / FIDO2 CTAP 2.2 | passkeys |
| OpenID CAEP 1.0 / Shared Signals | cross-service revocation |
| SAML 2.0 (+ 2025 CVE class) | enterprise SSO + its validation hazards |

## 8. How this document is used

Docs 03–12 cite the `BP-###` items as their "best practices," and the pricing/build-vs-buy analysis (§2/§5) informs the
SSO decision in doc 07 and the roadmap in doc 12. **Follow-up:** re-run the 20-agent live-source research sweep once the
account block clears to (a) resolve the `[verify]` markers with primary-source citations, (b) deepen the per-platform admin/
token/pricing detail, and (c) confirm the current maintenance status of the SAML/SCIM libraries named in §5. The standards
baseline (§1) and best-practice register (§4) are stable and safe to build against now.
