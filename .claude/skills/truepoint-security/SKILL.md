---
name: truepoint-security
description: >
  Security standards and threat discipline for all TruePoint code. Use this skill
  whenever code touches authentication, authorization, user or customer data,
  database queries, external/outbound requests, file uploads, secrets or API keys,
  webhooks, third-party integrations, enterprise identity (SSO/SAML/SCIM), data
  residency, the dialer/telephony, or compliance (SOC 2, GDPR, DPDP). Also triggers
  on any question of the form "is this safe", "can a user access X", "how do we
  protect Y", "who can see this record", or any handling of PII. TruePoint is a
  multi-tenant CRM holding customer and prospect PII — every query is tenant-scoped
  and that scoping is enforced at the database (RLS), every external input is
  untrusted, every secret stays off the client. If a change could expose data,
  escalate privilege, trust attacker-controlled input, or affect compliance, this
  skill must be active.
---

# TruePoint Security Skill

TruePoint is a multi-tenant CRM. It holds customer accounts and the personal data
of their prospects — names, emails, phone numbers, company data, deal values.
Several organisations' data sits in the same system. A security failure here is not
a bug that annoys one user; it is one organisation seeing another's pipeline, or a
prospect's PII leaking. Security is therefore not a feature or a review gate — it is
a property every change must preserve.

> **Tooling note:** the gate commands referenced across these files are this repo's:
> `bun run typecheck` (Turbo), `biome check` / `biome format` (lint/format), and
> `bun run lint:boundaries` (dependency-cruiser module boundaries). The lockfile is
> `bun.lock`; install is `bun install`. The backend is `apps/api` (`@leadwolf/api`),
> a standalone Hono service on Bun (port 3001); the two frontend apps in the monorepo
> are `apps/web` (`@leadwolf/web`, the customer surface) and `apps/admin`
> (`@leadwolf/admin`, the internal/platform-admin surface).

This skill is the authority on *whether code is safe*. The platform skill builds the
mechanisms (tenancy/RLS, the API contract); the architecture and design skills build
the frontend; the data skill defines the model. This skill governs the threats,
access, identity, and compliance. Read it whenever a change touches data, identity,
input, external systems, or regulated obligations.

---

## Which Skill, When

TruePoint has nine skills — six platform skills plus three `truepoint-extension-*`
skills for the browser extension (see the root `CLAUDE.md` routing table). Most real
features touch several.

- **truepoint-security** (this skill) — WHETHER it is safe. Access control, IAM,
  input validation, data protection, secrets, API hardening, integrations, abuse,
  compliance.
- **truepoint-platform** — the backend, the tenancy *mechanism* (RLS), the API
  contract, queues, scale. This skill enforces; platform provides.
- **truepoint-data** — the data model, ownership/sharing semantics, enrichment.
- **truepoint-architecture / design** — the frontend.
- **truepoint-operations** — incident/breach *response* and FinOps.
- **truepoint-extension-{architecture,linkedin,auth}** — the browser extension
  (`apps/extension`); this skill keeps final say on its token/capture safety.

Take "add a prospect to a list":
- Security (this skill): the write verifies the user owns the list, is tenant-scoped
  (enforced by RLS), respects ownership/sharing, allowlists fields, and the list ID
  from the client is never trusted for authorization.
- Platform: the RLS policy, the API contract, the idempotency key.
- Data: the ListMembership row, the ownership/sharing model.
- Design/Architecture: the UI and where it lives.

---

## Step 0 — Security Is Part of the Pre-Build Pass

The architecture pre-build pass already asks the security questions: what can a bad
actor do, can a user reach another's data, is the endpoint protected, is input
trusted, what gets logged. This skill is *how you answer them correctly*. Before
building anything that touches data or identity, walk the threat checklist below. If
any answer is "I'm not sure," resolve it before writing code.

---

## The Threat Mindset

One assumption underlies everything:

**Everything outside the server is hostile until proven otherwise.**

The browser, the request body, URL params, headers, the uploaded file, the webhook
payload, the data returned from a third-party API — all of it can be forged,
tampered with, or crafted by an attacker. The server trusts none of it without
validation. The client enforces nothing — it is a convenience layer an attacker
bypasses by calling the API directly.

---

## Core Non-Negotiables

These apply to every change. Each has a reference file.

- **Tenant isolation is enforced at the database, not by discipline.** Every
  tenant-owned table has Row-Level Security; a query that forgets its tenant filter
  returns nothing, not another org's data. This is the structural fix for the single
  most common CRM vulnerability — see `references/access-control.md` (and
  **truepoint-platform** tenancy for the mechanism).
- **Within a tenant, visibility is owner-scoped with explicit sharing.** Seeing a
  record depends on ownership/sharing/role, not just being in the org — see
  `references/access-control.md` and **truepoint-data** ownership-and-sharing.
- **Identity is enterprise-grade.** SSO (SAML/OIDC), SCIM provisioning, org-defined
  roles, and field-level permissions — not a hardcoded three-role enum. See
  `references/enterprise-iam.md`.
- **Validate every input at the boundary.** Parse against a schema before use; never
  build a query, command, or path from raw input. See
  `references/input-and-injection.md`.
- **Never trust outbound URLs.** Enrichment makes outbound requests — an
  attacker-controlled URL can hit internal services or cloud metadata. Allowlist and
  validate. See `references/integrations.md`.
- **No secrets on the client; keys live in a KMS.** `NEXT_PUBLIC_` ships to the
  browser and is public; provider keys are server-side; encryption keys are managed
  in a KMS with rotation. See `references/secrets.md` and `references/data-protection.md`.
- **Never log PII, tokens, or secrets.** See `references/data-protection.md`.
- **The UI hiding something is not security.** Authorization lives on the server.
  See `references/access-control.md` and `references/frontend-security.md`.
- **Data residency, consent, and deletion are obligations, not options.** EU data
  stays where it must; deletion is real; consent is tracked. See
  `references/data-protection.md` and `references/compliance.md`.
- **The edge is defended.** WAF, DDoS mitigation, bot/scraping defence, and
  telephony (TCPA/DNC) compliance. See `references/abuse-and-edge.md`.

---

## Threat Checklist

Run this for any change touching data, identity, input, external systems, or
regulated data:

1. **Access** — Can a user reach data that isn't theirs by changing an ID? Is every
   query tenant-scoped (`tenant_id`, plus `workspace_id` where workspace-scoped),
   *and is that enforced by RLS* — not just an app filter? (`access-control.md`)
2. **Visibility** — Within the org, does the user actually have ownership/sharing/role
   to see *this* record? (`access-control.md`, data ownership-and-sharing)
3. **Authorization** — Is the action gated by a permission check *and* data scope? Is
   the route protected? (`access-control.md`, `enterprise-iam.md`)
4. **Identity** — For auth/provisioning changes: does it hold up for SSO/SCIM, and
   are roles data-driven, not hardcoded? (`enterprise-iam.md`)
5. **Input** — Is every external input schema-validated? Could any reach a query,
   command, path, or HTML unescaped? (`input-and-injection.md`)
6. **Outbound** — Any external request from an attacker-influenceable URL?
   (`integrations.md`)
7. **Secrets/keys** — Could any key/token reach the client, logs, or git? Are
   encryption keys KMS-managed? (`secrets.md`, `data-protection.md`)
8. **Data exposure** — Does the response return only allowed fields? Anything
   sensitive logged? (`data-protection.md`, `api-security.md`)
9. **Privilege** — Could a user change a field (owner, role, org) to escalate?
   (`access-control.md`, `api-security.md`)
10. **Abuse/edge** — Rate limiting on anything expensive/sensitive? Scraping/DDoS
    defended? Telephony compliant (TCPA/DNC)? (`api-security.md`, `abuse-and-edge.md`)
11. **Compliance** — Residency, consent, retention, deletion, audit — all satisfied?
    (`compliance.md`, `data-protection.md`)

---

## Reference Files

| Concern | Read |
|---|---|
| Tenant isolation (RLS); record-level visibility; IDOR; permissions | `references/access-control.md` |
| SSO/SAML/OIDC, SCIM, org roles, field-level permissions | `references/enterprise-iam.md` |
| Validating input; SQL/XSS/SSRF/command injection | `references/input-and-injection.md` |
| PII handling; logging; encryption; KMS; residency; consent; deletion | `references/data-protection.md` |
| SOC 2 / ISO 27001 / GDPR / DPDP; DSAR; audit program | `references/compliance.md` |
| API keys, tokens, env vars, secret storage, KMS, rotation | `references/secrets.md` |
| Rate limiting, mass assignment, field exposure, CORS | `references/api-security.md` |
| DDoS, WAF, bot/scraping defence; telephony TCPA/DNC | `references/abuse-and-edge.md` |
| npm audit, lockfiles, vetting packages | `references/dependencies.md` |
| Enrichment providers, webhooks, OAuth, outbound requests | `references/integrations.md` |
| Client-side trust, browser storage, CSP, dangerouslySetInnerHTML | `references/frontend-security.md` |

---

## Companion Skills

This skill governs whether code is safe. It enforces the tenancy mechanism that
**truepoint-platform** provides, protects the model that **truepoint-data** defines,
constrains the frontend that **architecture/design** build, and hands breach/abuse
response to **truepoint-operations**. A feature that handles data is governed by
several skills at once — this one says how it stays safe and compliant.
