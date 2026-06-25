# Gap Register & Delivery Risks

This is the consolidated, traceable index for TruePoint's authentication plan: one stable `AUTH-###` ID per
distinct reviewed gap, each pointing to **where it is addressed now** (the doc + section that resolves it) and
its current **status**. It is the cross-reference spine that ties the gap analysis in
[`06-gap-analysis.md`](./06-gap-analysis.md), the recommended settings in
[`07-recommended-settings.md`](./07-recommended-settings.md), and the sequenced waves in
[`08-roadmap.md`](./08-roadmap.md) together — plus the threat model in [`09-threat-model.md`](./09-threat-model.md)
and the operate-and-comply work in [`10-operations-and-compliance.md`](./10-operations-and-compliance.md). Status
vocabulary is exactly `Implemented | Partial | Stub | Planned | Absent`; every TruePoint claim carries a
`file:line` anchor and every external claim a source URL.

It has three parts:

1. **Part 1 — the consolidated gap register**: every distinct gap with a stable ID, type, severity, where it is
   addressed, and whether it is fixed-in-place, resolved in a new section, or a recorded decision (every former
   open decision is now `Decided`).
2. **Part 2 — the delivery-risk register**: the ways building this work can go *wrong* (lockout, runaway cost,
   key compromise), with likelihood, impact, mitigation, owner, and the roadmap item each binds to.
3. **Part 3 — the effort & sequencing note**: the S/M/L/XL sizing scale used in [`08-roadmap.md`](./08-roadmap.md)
   and the XL long-poles called out explicitly.

> **Two priority axes — do not conflate them.** Throughout the plan, [`07-recommended-settings.md`](./07-recommended-settings.md)
> ranks **business priority** (how badly an enterprise needs a setting), while [`08-roadmap.md`](./08-roadmap.md)
> ranks **delivery wave** (the dependency-sequenced order it can ship in). They are different axes: passkeys are
> **P0 business priority** yet land in the **P3 delivery wave**, because self-service passkey enrollment depends
> on the P1b `/account/security` wizard existing first. The **Severity** column in Part 1 below is the
> enterprise-deal severity from doc 06 (`Critical/High/Medium/Low`) — a third, independent thing again. Read all
> three for what they are.

> **A note on the three re-baselined findings.** Three earlier "open gaps" are recorded here as **closed /
> corrected** rather than open work, because the working tree already ships them: the `platform_audit_log`
> tamper-resistance (remediated — schema + deny-all RLS + append-only trigger + `leadwolf_app` REVOKE,
> `packages/db/src/rls/platform.sql:16-49`), the `provider_configs` API + staff RBAC (Implemented and
> write-capable, `apps/api/src/features/admin/providerConfigs.ts:29-94`, mounted
> `apps/api/src/features/admin/routes.ts:248`, gated `requireStaffRole('super_admin')`), and the
> `requireOrgRole`/`requireStaffRole` guards + `org_role`/`platform_staff` migrations (Implemented in `apps/api` /
> `packages/db` — `apps/api/src/middleware/requireOrgRole.ts`, `requireStaffRole.ts`, `roleGuards.test.ts`;
> `packages/db/src/schema/auth.ts:79`; `packages/db/src/migrations/0006_kind_tomorrow_man.sql`). They appear in
> the register so the delta is legible, scored at their **real** status, not re-litigated as missing.

---

## Part 1 — Consolidated gap register

**Columns.** `ID` — the stable `AUTH-###` handle. `Gap (short)` — the one-line gap. `Type` — the class of
finding: `coverage` (a missing capability), `accuracy` (a stale/incorrect claim corrected against source),
`consistency` (a status-word or severity disagreement reconciled across docs), `executability` (a plan that
couldn't be acted on without more — effort, rollout, tests), `threat` (a security/abuse gate), or `compliance`
(a standards/regulatory obligation). `Severity` — the enterprise-deal severity (`Critical/High/Medium/Low`).
`Where addressed now` — the doc + section that resolves it today. `Status` — `Fixed-in-place` (an existing doc
was corrected), `New-section` (resolved by net-new content in 08/09/10/this doc), or `Decided` (a build-or-defer
call that has now been recorded — the outcome is stated inline; formerly `Open-decision`, of which there are now
none).

Rows are grouped by severity (Critical first), then by ID.

### Critical

| ID | Gap (short) | Type | Severity | Where addressed now (doc + section) | Status |
|---|---|---|---|---|---|
| AUTH-001 | Real SAML validator must ship with anti-XXE / anti-signature-wrapping / reject-unsigned gates as ship-blockers, not follow-ups | threat | Critical | [09](./09-threat-model.md) §"SAML validation"; [08](./08-roadmap.md) P2 "Real SAML adapter" | New-section |

### High

| ID | Gap (short) | Type | Severity | Where addressed now (doc + section) | Status |
|---|---|---|---|---|---|
| AUTH-002 | `platform_audit_log` carried as an open tamper-resistance gap — re-baselined to Implemented (remediated; `packages/db/src/rls/platform.sql:16-49`) | accuracy | High | [06](./06-gap-analysis.md) §(k) "Tamper-resistance / append-only" + "Closed since the last baseline"; [08](./08-roadmap.md) P0 "Confirm `platform_audit_log` lockdown" | Fixed-in-place |
| AUTH-003 | `provider_configs` carried as "missing"/read-only — re-baselined to Implemented + write-capable (`apps/api/src/features/admin/providerConfigs.ts:29-94`, mounted `routes.ts:248`) | accuracy | High | [06](./06-gap-analysis.md) §(i) "Platform/staff governance"; [08](./08-roadmap.md) phase-mapping "Phase 2 — Provider-Configs API" | Fixed-in-place |
| AUTH-004 | README / doc 02 "guards & migrations Planned" stale — `requireOrgRole`/`requireStaffRole` + `org_role`/`platform_staff` are Implemented in `apps/api`/`packages/db` | accuracy | High | [00](./00-README.md) §"top gaps" #7 + roadmap-at-a-glance; [08](./08-roadmap.md) snapshot-reconciliation table | Fixed-in-place |
| AUTH-005 | Two P0–P3 axes (business priority vs delivery wave) collided — disambiguated, with a mapping column added to doc 07 | consistency | High | [00](./00-README.md) two-axes note; [07](./07-recommended-settings.md) §2 + "Delivery wave (08)" column; [08](./08-roadmap.md) §"How the waves are ordered" | Fixed-in-place |
| AUTH-006 | No migration / rollout / backout + feature-flag discipline for enforcement flips — added (default-OFF per-tenant flag + staged rollout + break-glass) | executability | High | [08](./08-roadmap.md) P1 "Lockout-capable enforcement rule" + per-row Migration/rollout notes | New-section |
| AUTH-007 | No threat model or per-feature security acceptance criteria existed — authored | threat | High | [09](./09-threat-model.md) (whole doc); [08](./08-roadmap.md) per-row "Security ACs →" pointers | New-section |
| AUTH-008 | OIDC `id_token` validation threats (sig/iss/aud/nonce/exp/PKCE/state) uncovered | threat | High | [09](./09-threat-model.md) §"OIDC id_token validation"; [08](./08-roadmap.md) P2 "Real OIDC adapter" | New-section |
| AUTH-009 | SSRF on IdP-metadata / JWKS / discovery / DNS fetch uncovered | threat | High | [09](./09-threat-model.md) §"SSRF on metadata/JWKS fetch"; [08](./08-roadmap.md) P2 OIDC/SAML/domain rows | New-section |
| AUTH-010 | SCIM deprovision-vs-active-session race + bearer-token scope/abuse + replayed directory events uncovered | threat | High | [09](./09-threat-model.md) §"SCIM deprovisioning race & token abuse"; [08](./08-roadmap.md) P2 "SCIM 2.0 endpoints" + "Deprovisioning automation" | New-section |
| AUTH-011 | MFA downgrade + untrusted self-enrollment (enrollment trust) uncovered | threat | High | [09](./09-threat-model.md) §"MFA integrity (downgrade & enrollment trust)"; [08](./08-roadmap.md) P1 "Forced in-login MFA enrollment" | New-section |
| AUTH-012 | No auth observability / SLIs / alerts before enforcement flips | coverage | High | [10](./10-operations-and-compliance.md) §"Auth observability & SLIs"; [08](./08-roadmap.md) operate-and-comply wave | New-section |
| AUTH-013 | No signing-key-rotation / key-compromise runbook **and** KMS-custody inconsistency — KMS custody is Partial (`packages/auth/src/secrets.ts:9` runs the dev key), reconciled across 06/02 | accuracy · coverage | High | [10](./10-operations-and-compliance.md) §"Key management & rotation"; [06](./06-gap-analysis.md) §(l) "Secret encryption at rest" + §(m) "Signing-key rotation…" | Fixed-in-place + New-section |
| AUTH-014 | DSAR / retention / deletion of auth artifacts punted; immutable-audit-vs-erasure tension unresolved | compliance | High | [10](./10-operations-and-compliance.md) §"DSAR, retention & deletion of auth artifacts"; [06](./06-gap-analysis.md) §(l)/(m) DSAR rows | New-section |

### Medium

| ID | Gap (short) | Type | Severity | Where addressed now (doc + section) | Status |
|---|---|---|---|---|---|
| AUTH-015 | Social / OAuth login is a dead path — needs an explicit build-or-remove decision, not silent omission | executability | Medium | [06](./06-gap-analysis.md) §(m) "Social / OAuth login decision"; [08](./08-roadmap.md) P3+ "Social-login: build-or-remove decision" | Decided — hide the dead button now (`apps/auth`); build the full OAuth login flow in a later wave (P3 delivery) |
| AUTH-016 | SSO/OIDC lifecycle — Single Logout, metadata refresh, cert rotation, encrypted assertions, multi-IdP — unbuilt | coverage | Medium | [06](./06-gap-analysis.md) §(m) "SSO/OIDC lifecycle"; [08](./08-roadmap.md) P2 "SAML/OIDC lifecycle" | New-section |
| AUTH-017 | Machine / API authentication (PAT, service accounts, client-credentials, signed webhooks, mTLS) absent | coverage | Medium | [06](./06-gap-analysis.md) §(m) "Machine / API auth"; [07](./07-recommended-settings.md) §3 "OAuth-app & service-account / PAT"; [08](./08-roadmap.md) P3+ "Machine / API authentication" | New-section |
| AUTH-018 | No self-serve verified email-change flow (re-auth, verify new + notify old, revoke sessions) | coverage | Medium | [05](./05-planned-not-built.md) / [07](./07-recommended-settings.md) §4 "Secure email-change flow"; [08](./08-roadmap.md) P1b "Email-change flow" | New-section |
| AUTH-019 | Account-recovery edge cases (code exhaustion, lost-device, reset-token replay/rate-limit, enumeration) under-specified | threat | Medium | [05](./05-planned-not-built.md) / [09](./09-threat-model.md) §"Account-recovery abuse"; [08](./08-roadmap.md) P3+ "Account-recovery edge cases" | New-section |
| AUTH-020 | WCAG 2.2 AA + i18n of the auth/MFA/recovery surfaces not treated as a ship gate | compliance | Medium | [03](./03-current-state-flows-frontend.md) / [06](./06-gap-analysis.md) §(m) "Accessibility + i18n"; [08](./08-roadmap.md) P1b A11y/i18n ship gates | New-section |
| AUTH-021 | Staff-app hardening (mandatory phishing-resistant MFA + IP allowlist + step-up before impersonation) unbuilt | threat | Medium | [06](./06-gap-analysis.md) §(m) "Staff-app hardening"; [07](./07-recommended-settings.md) §3 "Staff-app hardening"; [08](./08-roadmap.md) P3 "Staff-app hardening" | New-section |
| AUTH-022 | No SLOs / error budget / degraded-mode for the login path | coverage | Medium | [06](./06-gap-analysis.md) §(m) "SLO / error budget"; [10](./10-operations-and-compliance.md) §"SLOs & degraded mode" | New-section |
| AUTH-023 | Password-policy severity understated — reconciled to High and sequenced P0 (delivery wave) across 06/07/08 | consistency | Medium | [06](./06-gap-analysis.md) §(a) password-policy rows; [07](./07-recommended-settings.md) §3 "Full password policy"; [08](./08-roadmap.md) P0 "Enforced password policy" | Fixed-in-place |
| AUTH-024 | Passkeys priority/legend contradiction (legend said Critical, row said High) reconciled to High in doc 06 | consistency | Medium | [06](./06-gap-analysis.md) §(b) "WebAuthn / passkey as an offered factor" + §"How to read the severity column" | Fixed-in-place |
| AUTH-025 | SMS / email-OTP / WebAuthn status word unified to Stub (a routed seam returning a placeholder) across 02/04/05/06/08 | consistency | Medium | [06](./06-gap-analysis.md) §(c) SMS/Email/WebAuthn rows; [08](./08-roadmap.md) P3 "Additional MFA methods" | Fixed-in-place |
| AUTH-026 | The operations skill was never handed an explicit workstream — added as a parallel operate-and-comply wave | executability | Medium | [10](./10-operations-and-compliance.md) (whole doc); [08](./08-roadmap.md) "Operations & compliance readiness" wave | New-section |
| AUTH-027 | No effort estimates on roadmap items — an Effort (S/M/L/XL) column added | executability | Medium | [08](./08-roadmap.md) per-wave Effort column; Part 3 below | New-section |
| AUTH-028 | No consolidated gap register / 06→07→08 traceability existed | executability | Medium | **This doc** (Part 1) | New-section |
| AUTH-029 | Acceptance criteria too thin — abuse-case "Must FAIL" ACs added per item | executability | Medium | [08](./08-roadmap.md) per-row "Must FAIL"; [09](./09-threat-model.md) abuse-case ACs | New-section |
| AUTH-030 | No per-item test / isolation-test strategy | executability | Medium | [08](./08-roadmap.md) per-row "Verification" lines (incl. cross-tenant isolation tests) | New-section |
| AUTH-031 | `require_sso` sequenced ahead of safety — fixed (no-lockout guard: can't enable against a Stub adapter) | executability | Medium | [08](./08-roadmap.md) P1a "`require_sso` enforcement" + sequencing callouts | Fixed-in-place |
| AUTH-032 | No per-item data-model / API-contract list on roadmap items | executability | Medium | [08](./08-roadmap.md) per-row "New contract" lines | New-section |
| AUTH-033 | No delivery-risk register | executability | Medium | **This doc** (Part 2) | New-section |
| AUTH-034 | Mass-assignment / field-allowlisting generalized (no `org_role`/`is_platform_admin` from an IdP claim) | threat | Medium | [09](./09-threat-model.md) §"Mass-assignment & field allowlisting"; [04](./04-settings-inventory.md) write-field allowlists | New-section |
| AUTH-035 | IdP-initiated SSO acceptance risks (bind to pre-registered ACS, replay defence; SP-initiated default) | threat | Medium | [09](./09-threat-model.md) §"IdP-initiated SSO"; [08](./08-roadmap.md) P2 "Real SAML adapter" | New-section |
| AUTH-036 | Open-redirect on new callbacks (`returnTo`/RelayState/post-login targets allowlisted, never reflected) | threat | Medium | [09](./09-threat-model.md) §"Open redirects" | New-section |
| AUTH-037 | No incident-response / breach-notification path for an auth incident | compliance | Medium | [10](./10-operations-and-compliance.md) §"Incident response & breach notification" | New-section |
| AUTH-038 | Auth-audit retention + SIEM export workflow absent | compliance | Medium | [06](./06-gap-analysis.md) §(k) "Export / access review"; [10](./10-operations-and-compliance.md) §"DSAR, retention & deletion of auth artifacts" + §"Auth observability & SLIs" | New-section |
| AUTH-039 | No data-residency map for auth artifacts | compliance | Medium | [06](./06-gap-analysis.md) §(l) "Data residency"; [10](./10-operations-and-compliance.md) §"Data residency map" | New-section |
| AUTH-040 | Transactional-email (reset/verify/OTP/alert) deliverability unmonitored | coverage | Medium | [10](./10-operations-and-compliance.md) §"Email & SMS deliverability" | New-section |
| AUTH-041 | Domain DNS-TXT verification worker deferred, so claimed domains sit `pending` | coverage | Medium | [06](./06-gap-analysis.md) §(i) "Domain verification + join policy"; [08](./08-roadmap.md) P2 "Domain DNS-TXT verification worker" | New-section |
| AUTH-042 | Concurrent-session cap absent (no limit on simultaneous sessions per user) | coverage | Medium | [06](./06-gap-analysis.md) §(f) "Concurrent-session limit"; [07](./07-recommended-settings.md) §3 "Concurrent-session cap…" | New-section |

### Low

| ID | Gap (short) | Type | Severity | Where addressed now (doc + section) | Status |
|---|---|---|---|---|---|
| AUTH-043 | Mobile / native client scope not stated | coverage | Low | [01](./01-enterprise-benchmark.md) scope statement | Decided — no native/mobile client in scope; a later native client would use system-browser OAuth/PKCE (ASWebAuthenticationSession) + secure storage + biometric/passkeys |
| AUTH-044 | Push-factor explicitly out of scope — stated, not silently dropped | coverage | Low | [01](./01-enterprise-benchmark.md) scope note | Decided — out of scope (no push infra); MFA direction is TOTP today + WebAuthn/passkeys next; revisited only if a push channel is built |
| AUTH-045 | Authorization-maturity (custom roles, field-level perms, separation-of-duties) scope note | coverage | Low | [06](./06-gap-analysis.md) §(i) governance + §(m) "Field-level permissions" handoff | Decided — out of scope for this auth plan; deferred to a separate IAM/RBAC track (truepoint-data + access-control); only access-review/certification stays auth-adjacent |
| AUTH-046 | Doc 01 mislabeled doc 07 as a "roadmap" — corrected (07 is the recommended-settings inventory; 08 is the roadmap) | accuracy | Low | [01](./01-enterprise-benchmark.md) cross-references; [00](./00-README.md) reading-order table | Fixed-in-place |
| AUTH-047 | Fuzzy acceptance criteria with no KPIs/SLOs — tightened to measurable ship gates | executability | Low | [08](./08-roadmap.md) Verification lines; [10](./10-operations-and-compliance.md) SLIs/SLOs | Fixed-in-place |
| AUTH-048 | Owners are skills, not named DRIs — recorded as a note (skill = accountable function, not a person) | executability | Low | [08](./08-roadmap.md) "Owning skill" columns; this note | Decided — keep skill-owner as the assignment model (the repo's multi-agent operating model); add a named DRI per item alongside the skill at delivery-team handoff |
| AUTH-049 | Trusted-device is a cross-wave forward-reference (P2 business view waits on the P3 backend) — made explicit | consistency | Low | [07](./07-recommended-settings.md) §4 "Trusted devices (user view)"; [08](./08-roadmap.md) P3 "Trusted-device 30-day skip" | Fixed-in-place |
| AUTH-050 | Audit-action vocabulary citation imprecise — pinned to the real enum (`packages/types/src/billing.ts:120-121`; mirrored `auditRepository.ts:18-19`) | accuracy | Low | [02](./02-current-state-backend.md) audit-action citation | Fixed-in-place |
| AUTH-051 | `password.reset` enum-name fix — `password.reset.request`/`.complete` are the real members; past-tense `.requested`/`.completed` would fail the Zod enum | accuracy | Low | [08](./08-roadmap.md) P0 "Password-reset audit events" | Fixed-in-place |
| AUTH-052 | JWKS endpoint `/auth` basePath note (the JWKS read lives under the auth origin, not the API root) | accuracy | Low | [03](./03-current-state-flows-frontend.md) JWKS basePath note | Fixed-in-place |
| AUTH-053 | CSRF invariant not asserted for the new auth surfaces | threat | Low | [09](./09-threat-model.md) §"Session / CSRF / CSP / cookie invariants" | New-section |
| AUTH-054 | Field-level permissions handoff note (owned with the data + security skills, not built in auth today) | coverage | Low | [06](./06-gap-analysis.md) §(m) "Field-level permissions" | Decided — tracked as a requirement owned by truepoint-data + truepoint-security (access-control), not built in auth today; auth surfaces returning PII apply per-role response shaping |
| AUTH-055 | CSP no-regression assertion for the new account/SSO routes | threat | Low | [09](./09-threat-model.md) §"Session / CSRF / CSP / cookie invariants" | New-section |
| AUTH-056 | Refresh-cookie attributes (HttpOnly / Secure / SameSite / path-scoped) invariant not asserted | threat | Low | [09](./09-threat-model.md) §"Session / CSRF / CSP / cookie invariants" | New-section |
| AUTH-057 | Account-recovery social-engineering + session-fixation edges uncovered | threat | Low | [09](./09-threat-model.md) §"Account-recovery abuse" + §"Session / CSRF / CSP / cookie invariants" | New-section |
| AUTH-058 | SMS telephony cost / operational burden unaddressed | coverage | Low | [10](./10-operations-and-compliance.md) §"Email & SMS deliverability" + §"FinOps" | New-section |
| AUTH-059 | Auth FinOps (per-tenant metered-auth cost attribution + runaway-spend alert) absent | coverage | Low | [10](./10-operations-and-compliance.md) §"FinOps" | New-section |
| AUTH-060 | Consent / lawful basis for risk/device/geo profiling not registered before profiling ships | compliance | Low | [07](./07-recommended-settings.md) §3 consent notes; [10](./10-operations-and-compliance.md) §"Consent & lawful basis" | New-section |

**Tally.** 60 rows — 1 Critical, 13 High, 28 Medium, 18 Low — across `coverage`, `accuracy`, `consistency`,
`executability`, `threat`, and `compliance` types. Of these, **14** are `Fixed-in-place` corrections to existing
docs (plus AUTH-013, which is both — a `Fixed-in-place` reconciliation *and* a `New-section` runbook), the **6**
former `Open-decision` rows are now all **`Decided`** (0 open) — the build-or-defer calls have been recorded for
social-login (AUTH-015), mobile/native scope (AUTH-043), push-as-a-factor (AUTH-044), authorization-maturity
(AUTH-045), the DRI/skill-owner assignment (AUTH-048), and field-level permissions (AUTH-054) — and the remaining
**39** are resolved by net-new sections in docs 08/09/10 or here.

---

## Part 2 — Delivery-risk register

These are not gaps in the design; they are the ways *building it* can fail. Each is the kind of failure that
locks tenants out, runs up an unbudgeted bill, or widens the blast radius of a compromise. Likelihood and
impact are coarse (`Low/Medium/High`). The **Owner** is the accountable skill (per `CLAUDE.md` precedence;
security has final say on whether a mitigation is safe). The **Linked roadmap item** anchors each risk to the
[`08-roadmap.md`](./08-roadmap.md) work it constrains.

| Risk | Likelihood | Impact | Mitigation | Owner | Linked roadmap item |
|---|---|---|---|---|---|
| **Enforced SSO against a broken / Stub adapter = org-wide lockout.** Flipping `require_sso` ON while the tenant's real adapter throws (`packages/auth/src/sso/providers.ts:16-47`) blocks every login. | High | High | Per-tenant **default-OFF** flag; the API **rejects enabling `require_sso` while `getSsoProvider(protocol)` returns the throwing Stub** — only a passing **test-connection** against the real adapter unlocks the flip; a documented, audited **break-glass** local-login for `owner`. | truepoint-security · truepoint-platform | [08](./08-roadmap.md) P1a "`require_sso` enforcement"; P2 "SSO setup wizard + test-connection tool" |
| **Enforcement-flag lockout for session-timeout / allowed-methods / IP-allowlist.** A stored knob suddenly enforced (e.g. a too-tight IP-allowlist or a misread CIDR) locks a tenant out of its own login. | Medium | High | Every lockout-capable control ships behind a **per-tenant default-OFF flag** with a **staged rollout** (observe-only → soft-fail → enforce) and a **break-glass disable** that re-opens password login without a deploy; CIDR-match (not string-equality) + a client-IP-spoofing guard. | truepoint-security · truepoint-platform | [08](./08-roadmap.md) P1a "Allowed-methods gate", "IP-allowlist gate", "Session-timeout enforcement" |
| **Forced MFA with no enrollment screen locks members out.** A required-MFA org whose members have no enrolled method are thrown out, not enrolled (`packages/auth/src/flow.ts:152-160` throws `mfa_required`). | High | High | **Ship the in-login forced-enrollment step first** — route an un-enrolled forced-MFA user into a TOTP enroll that completes the login, before (or atomically with) turning the gate hard; bind the enrollment to the authenticating user. | truepoint-security · truepoint-architecture · truepoint-design | [08](./08-roadmap.md) P1a "Forced in-login MFA enrollment"; P1b MFA enrollment wizard |
| **SMS / OTP metered cost + push-bombing.** An OTP factor is both a metered telephony spend and an abuse target (OTP-bombing / toll-fraud pumping). | Medium | Medium | **Rate-limit** OTP issuance per identifier/IP and cap per-tenant spend; keep SMS a **discouraged fallback only** (never a primary authenticator, per [ASVS V6.6.1](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md)); single-use + short-TTL codes; runaway-spend alert. | truepoint-security · truepoint-operations | [08](./08-roadmap.md) P3 "Additional MFA methods (SMS / email OTP)"; [10](./10-operations-and-compliance.md) §"FinOps" |
| **External breached-password (HIBP) dependency.** Breach screening on set/change is a normative SHALL ([NIST SP 800-63B-4 §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html)) but adds an outbound dependency that can be slow or down. | Medium | Medium | Use the **k-anonymity range API** (the candidate password is never sent in cleartext); **cache** prefixes and define a **fallback posture** (fail-open to a local top-N blocklist on outage, never block legitimate set/change); attribute the lookup cost in FinOps. | truepoint-security · truepoint-data | [08](./08-roadmap.md) P0 "Breached-password screening on set"; [10](./10-operations-and-compliance.md) §"FinOps" |
| **Signing-key compromise.** A leaked JWT/session signing key forges access tokens until expiry; no rotation runbook exists today. | Low | High | A **rotation runbook** (overlapping `kid`s, no-downtime cutover — the `kid` rotation seam already exists, `packages/auth/src/token.ts`), a **token deny-list** to revoke in-flight sessions within seconds (the deny-list primitive exists, `packages/auth/src/session.ts:71-81`), and the move from the dev-derived at-rest key (`packages/auth/src/secrets.ts:9`) to **KMS-managed custody**. | truepoint-security · truepoint-operations | [10](./10-operations-and-compliance.md) §"Key management & rotation"; [08](./08-roadmap.md) operate-and-comply wave "Signing-key rotation runbook" |

---

## Part 3 — Effort & sequencing note

[`08-roadmap.md`](./08-roadmap.md) sizes every item with a coarse **S/M/L/XL** scale — a build estimate, not a
commitment, meant to separate "wire an existing primitive" from "implement a protocol":

- **S** — ≤ ½ day. Reuse an existing primitive/sink; no new table, no new external dependency (e.g. emitting the
  missing `password.reset.request`/`.complete` audit events into the existing sink).
- **M** — 1–2 days. A bounded new endpoint or gate over existing data; at most a small additive schema change or
  a config-only seam (e.g. wiring an already-resolved policy knob onto the login/refresh path).
- **L** — ~1 week. A net-new feature with its own table(s), API surface, and isolation tests (e.g. the workspace
  members API, deprovisioning automation, machine/API auth).
- **XL** — multi-week / specialist. Protocol-correctness or ceremony work where the [`09-threat-model.md`](./09-threat-model.md)
  security ACs are the ship gate, not an afterthought.

**The XL long-poles** — the items that dominate the critical path and need specialist review:

- **Real OIDC adapter** (`arctic`) — authorize → code → `id_token` signature/nonce/PKCE → attribute map → JIT,
  behind the existing `SsoProvider` interface (`packages/auth/src/sso/providers.ts:16-26`).
- **Real SAML adapter** (`@node-saml/node-saml`) — signed-assertion validation against IdP metadata with the
  anti-XXE / anti-signature-wrapping / reject-unsigned gates (AUTH-001), SP- and IdP-initiated + RelayState
  (`packages/auth/src/sso/providers.ts:28-38`).
- **SCIM 2.0 (`/Users` + `/Groups`) + deprovisioning automation** — RFC 7644 CRUD plus the directory-event-driven
  session-revoke + record-reassignment that is the enterprise deprovisioning asymmetry.
- **WebAuthn / passkeys** — registration + assertion ceremony with origin/RP-ID binding, attestation, and
  counter/replay defences; sequenced after the P1b `/account/security` wizard it enrolls through.
- **CAEP / Shared-Signals (SSF)** — a transmitter/receiver emitting and consuming standardized cross-service
  revocation signals ([OpenID CAEP 1.0 final](https://openid.net/specs/openid-caep-1_0-final.html)).
- **The `/account/security` build** — the net-new user account-security surface on the auth origin (route shell,
  password change, MFA/recovery management, own-session list, login history); Absent today and the spine that
  several P1a/P3 items depend on.

Everything else in the plan is S/M/L — wiring strong, already-built primitives (the resolver, the session
lifecycle, the audit sink, the staff RBAC guards) onto the real surfaces, behind the lockout-safe rollout
discipline in Part 2.

---

## Sources

- NIST SP 800-63B-4 (final, Jul 2025): https://pages.nist.gov/800-63-4/sp800-63b.html
- OWASP ASVS 5.0 V6 Authentication: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md
- OpenID CAEP 1.0 (final 2025): https://openid.net/specs/openid-caep-1_0-final.html
- SCIM 2.0 — RFC 7644: https://www.rfc-editor.org/rfc/rfc7644
- Companion docs: [`06-gap-analysis.md`](./06-gap-analysis.md) (severity source), [`07-recommended-settings.md`](./07-recommended-settings.md)
  (business priority), [`08-roadmap.md`](./08-roadmap.md) (delivery wave + effort), [`09-threat-model.md`](./09-threat-model.md)
  (threat ACs), [`10-operations-and-compliance.md`](./10-operations-and-compliance.md) (operate-and-comply).
