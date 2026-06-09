# ADR-0017 — Progressive identifier-first login + domain-based tenant/SSO routing

- **Status:** Accepted
- **Date:** 2026-06-08
- **Context doc:** [17-authentication.md](../17-authentication.md), [03-database-design.md](../03-database-design.md), [12-settings.md](../12-settings.md)

## Context

The login screen must serve a multi-tenant base where different tenants use different methods (password,
SSO, magic link, passkey, social) and some **enforce SSO**. Asking for a password up front is wrong for
SSO-only orgs and leaks which methods/accounts exist. The corpus had **no tenant-resolution-from-email
mechanism** — tenant identity was only known *after* authenticating a user — so the login screen had no way
to route by organization. We need a single entry that adapts to the email's organization without leaking
account existence.

## Decision

Adopt a **progressive, identifier-first** login at `auth.truepoint.in/login`: the user enters an email
first; the system resolves the email's **domain → tenant** and routes to exactly one Step-2 path
(password / SSO handoff / magic link / passkey / social). Domain resolution uses a new **`tenant_domains`**
table — a tenant **claims** a domain and **verifies** it (DNS-TXT) to associate that domain with the tenant
and its `tenant_sso_configs`. Unclaimed/personal domains fall through to password/social/magic.

- **No account enumeration:** identifier, password, reset, and magic-link responses are indistinguishable
  for existing vs non-existing accounts; errors are generic ("check your credentials").
- **Routing precedence:** claimed-domain + SSO-enforced → SSO; claimed-domain + password allowed →
  password (with passkey prompt if registered); passwordless/no-password → magic link.
- Full flow + state machine: [17 §2](../17-authentication.md#2-progressive-identifier-first-login),
  [§4](../17-authentication.md#4-multi-tenancy-auth-model). Domain claiming UI: [12 §4](../12-settings.md#4-tenant-settings-tenant-owner--billing--tier-as-noted).

> **No-enumeration clause amended by [ADR-0020](./ADR-0020-existence-revealing-identifier-first-and-registration.md)
> (2026-06-09):** the identifier step now accepts an email **or username**, **reveals** whether an account
> exists to branch login-vs-**registration**, and mitigates enumeration with Cloudflare Turnstile +
> per-IP/per-identifier rate-limiting (the *credential* step stays uniform). Identifier-first + verified-domain
> SSO routing below are **unchanged**.

## Rationale

Identifier-first is the standard enterprise pattern (Google/Okta/Microsoft) because the right second step
depends on the organization. Resolving the tenant by verified domain lets the screen route to SSO/JIT
without a separate org-picker, and DNS-TXT verification prevents a tenant from claiming a domain it doesn't
control (which would otherwise hijack that domain's SSO routing). Generic responses at every step close the
account-enumeration hole that a password-first form opens.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Identifier-first + verified-domain tenant routing (this ADR) | Chosen | Adapts the second step per org; enables enforced SSO; no enumeration; no org-picker. |
| Password-and-email on one screen | Rejected | Breaks SSO-only orgs; leaks account existence; no per-tenant routing. |
| Tenant subdomain per customer (`acme.auth.truepoint.in`) | Rejected | Heavy routing/cert/onboarding cost; a single `auth.truepoint.in` with domain lookup is simpler and matches the cross-domain token model ([ADR-0016](./ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md)). |
| Unverified domain→tenant mapping | Rejected | Lets a tenant claim someone else's domain and capture its SSO routing. |

## Consequences

- **Positive:** one adaptive entry point; enforced-SSO orgs never see a password box; closes enumeration;
  domain claiming also feeds SSO/JIT and SCIM.
- **Negative:** an extra round trip (email → lookup → step 2); a domain-claiming/verification flow to build
  and operate; ambiguity when several tenants share a public email domain (e.g. `gmail.com`).
- **Mitigation:** cache domain lookups; treat public/free email domains as **unclaimed** (route to
  password/social/magic, never to a tenant's SSO); require DNS-TXT verification before a claim takes effect.

## Revisit if

A large customer requires a fully branded per-tenant auth subdomain, or domain-based routing proves
insufficient for shared-domain conglomerates (add explicit org selection as a fallback step).
