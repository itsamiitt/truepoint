# ADR-0020 — Existence-revealing identifier-first + email/username + hybrid registration

- **Status:** Accepted
- **Date:** 2026-06-09
- **Context doc:** [17-authentication.md](../17-authentication.md), [03-database-design.md](../03-database-design.md), [12-settings.md](../12-settings.md)
- **Amends:** [ADR-0017](./ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md) (the *no-enumeration* clause only; identifier-first + domain routing stand)

## Context

[ADR-0017](./ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md) mandated **no account
enumeration**: the identifier step routed only by email **domain**, never by whether the account exists, and
all responses were uniform. The product now requires the **Google/Slack** pattern: the identifier accepts an
**email *or* username**; if the account **exists** it routes to the right second step (SSO / password /
passkey / magic); if it **does not exist** it starts a **registration** flow. Branching login-vs-register
inherently **reveals whether an account exists** — which directly conflicts with ADR-0017's no-enumeration
clause. The identifier-first entry and domain→SSO routing of ADR-0017 are otherwise kept.

## Decision

The identifier step **resolves existence and branches**, with enumeration **throttled, not hidden**:

- **Identifier:** accepts email **or** username. Username is an optional **global-unique alias**
  ([ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md)) that resolves to the identity; SSO
  domain-routing uses the identity's **canonical email** (a username has no domain).
- **Exists → step 2:** verified email domain enforces SSO → `/sso`; else `passwordHash` set → `/password`
  (passkey prompt if a credential exists); else → `/magic`.
- **Not exists → `/signup`** (registration).
- **Mitigation (replaces "hide existence"):** an invisible **Cloudflare Turnstile** challenge + **`rate-limiter-flexible`**
  counters **per-IP and per-identifier** + the existing security headers + audited `login.*` attempts and
  progressive lockout. Enumeration becomes slow/throttled, not impossible.
- **Credential step stays uniform:** the password/SSO/magic step never reveals *why* it failed
  ("check your credentials").
- **Hybrid registration** (after email verification — `auth_email_tokens`): the email's domain matches a
  verified **`tenant_domains`** row with `join_policy` → **`auto_join`** (create membership, default role) or
  **`request_access`** (pending); else a **pending `invitations`** row for the email → **accept**; else →
  **create a new org** (`provisionNewSignup`: tenant + default workspace + owner `tenant_member` + owner
  `workspace_member` + audit).

Full flow + screens: [17 §2](../17-authentication.md#2-progressive-identifier-first-login) and the
Registration section.

## Rationale

The "unregistered → register" branch the user wants **cannot** coexist with hiding account existence; every
mainstream product (Google, Slack, GitHub, Microsoft) reveals existence at the identifier step and mitigates
with bot-detection + rate-limiting. Throttling is the right trade for the far better onboarding UX. The
username alias is a convenience that doesn't break domain-SSO because routing resolves to the canonical email
first.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Reveal existence + Turnstile/rate-limit (this ADR) | Chosen | Real registration branch + SSO routing; enumeration throttled; standard enterprise UX. |
| Keep no-enumeration, "email a link either way" | Rejected | No visible branch, but a mandatory email round-trip on every login; clunky. |
| Username-first identity | Rejected | A username has no domain → breaks domain→tenant/SSO routing. |

## Consequences

- **Positive:** clear, familiar UX; registration + invite + domain-join become possible; SSO routing works.
- **Negative:** account enumeration is now **possible-but-throttled**; a Turnstile dependency; registration /
  invite / domain-join flows to build and operate.
- **Mitigation:** Turnstile + per-IP/per-identifier rate limits + lockout + audit; public/free email domains
  are always treated as **unclaimed** (never a tenant's SSO).

## Revisit if

Enumeration abuse becomes material despite throttling — fall back to the "email-a-link-either-way" identifier
step for unauthenticated probing.
