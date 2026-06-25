# Operations & Compliance Readiness

The rest of this plan covers **building** TruePoint authentication. This document covers **running and
complying with it** — the operate-and-comply layer an enterprise expects but the earlier docs omit.
`auth.truepoint.in` is the single point of entry: it holds credentials (Argon2id hashes,
`packages/db/src/schema/auth.ts:50`), MFA secrets (`user_mfa_methods.secret_enc`,
`packages/db/src/schema/auth.ts:201`), durable sessions (`user_sessions`,
`packages/db/src/schema/auth.ts:162-193`), and the PII tied to every identity. When that origin degrades,
every customer is locked out; when it leaks, every customer is breached. Neither risk is addressed by the
build plan alone — they are operational and compliance properties of the running system.

Ownership routes through the `truepoint-operations` skill (incident response, runbooks, breach
notification, FinOps), backed by `truepoint-platform` (the observability and SLO machinery this layer
operates against), `truepoint-security` (the breach *obligations* and residency controls), and
`truepoint-data` (the retention/deletion mechanics). The division is consistent throughout:
**platform builds the emission/capability, operations owns the dashboards/alerts/runbooks, security owns
whether it satisfies an obligation, data owns the deletion mechanics.**

Status vocabulary is exactly `Implemented | Partial | Stub | Planned | Absent`. Every codebase claim
carries a `file:line` anchor; every external/standards claim carries a source URL. This document is a
planning artifact — it specifies what to operate and comply with, it is not itself a code change.

The real domain `truepoint.in` and the EU/UK footprint of an enterprise buyer mean **both** the EU GDPR
and **India's DPDP Act 2023** apply across every section below.

---

## Auth observability & SLIs

You operate what you can see, and today the auth origin emits almost nothing an operator could alert on.
The audit sink that exists (`recordAuthEvent`, `packages/auth/src/auditEvent.ts:10-28`) is **observational
by design** — it is swallow-on-failure and explicitly "must NEVER throw into the auth flow" (`auditEvent.ts:3`)
— so it is a forensic record, **not** a metric stream. The one signal already on the right footing is
`login.success`, which `finalizeLogin` emits **off the critical path** in a detached `Promise.allSettled`
that does not gate the issued code or redirect (`packages/auth/src/flow.ts:209-240`). That detached
emission point, and the audit actions enumerated in `packages/types/src/billing.ts:114-134`, are the seams
to build metrics on — counters derived from the audit events, not a second instrumentation path that can
drift from them.

The Service Level Indicators below are the minimum an auth origin needs. **Platform builds the emission**
(a metric per event, labelled by tenant where cardinality allows); **operations owns the dashboard and the
alert thresholds.**

| Concern | What to build/measure | Owner | Notes |
|---|---|---|---|
| Login-success % | `login.success ÷ (login.success + login.failure + login.locked)` over a rolling window, from the audit actions at `packages/types/src/billing.ts:114-116`. | platform emits, operations dashboards | A sharp drop is the primary **outage** signal (a backend dependency, a key-load failure, a bad deploy). |
| MFA challenge / abandon rate | `mfa.challenge` vs `mfa.success`/`mfa.failure` (`packages/types/src/billing.ts:117-119`); abandon = challenge with no terminal event. | platform emits, operations dashboards | A spike in abandons after a release flags a broken MFA step or enrollment UX regression. |
| Credential-lockout rate | `login.locked` count and the credential-lockout limiter trips (`packages/auth/src/rateLimit.ts:112-118`). | platform emits, operations dashboards | **A lockout-rate spike is the credential-stuffing signal** — wire it as the detection trigger for the incident runbook below. |
| Token-refresh failure % | Refresh rejections from the reuse-detection path (`packages/auth/src/session.ts:106-123` throws `InvalidTokenError`); surface refresh 4xx rate. | platform emits, operations dashboards | A rise can mean clock skew, a deploy that invalidated cookies, or an active token-theft family-revocation wave. |
| SSO-callback error % | `sso.callback` outcomes (`packages/types/src/billing.ts:123`) split success vs error once real OIDC/SAML lands (today the adapters are Stub — `packages/auth/src/sso/providers.ts:16-38`). | platform emits, operations dashboards | Per-tenant: one tenant's IdP misconfig must be visible without drowning in another's. |
| JWKS 5xx / availability | HTTP status + latency of `GET /auth/.well-known/jwks.json` (`apps/auth/src/app/.well-known/jwks.json/route.ts:5-8`). | platform emits, operations dashboards | If JWKS 5xxes, **every** `apps/api` token verification fails (`packages/auth/src/token.ts:64-74`) — a JWKS outage is an API-wide outage. |
| Auth-origin request latency | p50/p95/p99 of the login, code-exchange, and refresh endpoints. | platform emits, operations dashboards | Feeds the login-latency SLO below. |

**Alert thresholds (operations-owned).**

| Signal | Threshold (starting point, tune to baseline) | Means |
|---|---|---|
| Login-success % | drops > 20 percentage points below 7-day baseline for 5 min | Probable **outage** — page on-call, treat as SEV2+ |
| Credential-lockout rate | > 5× baseline over 10 min | **Credential-stuffing wave** — trigger the incident runbook |
| JWKS endpoint | any sustained 5xx, or p95 latency > 1 s | API-wide auth failure imminent |
| Token-refresh failure % | > 10× baseline | Mass session invalidation or token-theft family-revocation |

Tie these to `truepoint-platform` observability (the SLO-burn machinery they consume) and route the
lockout-rate alert into `truepoint-security` api-security abuse signals — a cost/abuse spike and a security
event are frequently the same event.

---

## SLOs & degraded mode

The auth origin and its token endpoints are a tier-1 dependency: their SLO **is** the floor on every
authenticated surface in the product. Targets below are the contract operations holds the build to; the
error budget is what governs whether to ship or freeze.

| Concern | What to measure | Target (starting point) | Owner | Notes |
|---|---|---|---|---|
| Auth-origin availability | Successful-response ratio on login + code-exchange + refresh | 99.9% monthly | platform (SLO), operations (budget) | Below this the whole product is effectively down for affected users. |
| JWKS availability | Success ratio of `GET /auth/.well-known/jwks.json` | 99.95% monthly | platform, operations | Stricter than the origin: a JWKS outage fails **all** `apps/api` verification (`packages/auth/src/token.ts:64-74`). |
| Token-refresh success | Non-error refresh ratio (excluding genuine reuse-detection revocations) | 99.9% monthly | platform, operations | Silent refresh runs on every cold app load (`packages/auth/src/session.ts:101-105`). |
| Login latency | p95 of credential login (Argon2id verify dominates) | p95 ≤ 600 ms | platform, operations | Argon2id is deliberately costly; the budget must account for it, not flag it as slow. |

**Degraded-security posture under a Redis outage — document it, do not discover it.** Two security
controls **fail OPEN by design**, and that is the correct availability trade-off, but it must be an
*alarmed, time-bounded* degradation, not a silent one:

| Control | Behaviour on Redis error | Anchor | Compensating alert that MUST fire |
|---|---|---|---|
| Rate-limiting + credential lockout | Consumes/locks become no-ops (fail open) so a cache blip can't brick auth | `packages/auth/src/rateLimit.ts:54-55,103-105` | Redis-down alert ⇒ **brute-force/credential-stuffing protection is OFF** — page on-call; this is a security-degraded state, not just an infra blip |
| Access-token revocation deny-list | `isRevoked` returns `false` (fail open) | `packages/auth/src/revocation.ts:42-48`, relied on at `apps/api/src/middleware/authn.ts` | Redis-down alert ⇒ **logout / forced-logout / workspace-switch revocation is not enforced**; a revoked session's token stays usable until its ≤15-min TTL (`ACCESS_TOKEN_TTL_SECONDS=900`, `packages/config/src/env.ts:54`) |

The compensating alert is the whole point: fail-open is safe **only** if an operator is told the protective
window is open and for how long. The runbook entry is "Redis unreachable ⇒ auth is in degraded-security
mode; rate-limit and revocation are bypassed until Redis recovers; restore Redis as a security incident,
not just an availability one." The durable `user_sessions` row remains the source of truth — refresh still
fails for a revoked session (`packages/auth/src/session.ts:113-119`) — so the deny-list outage only widens
the access-token window, it does not make a revoked session refreshable. Aligns with
[Google SRE — Service Level Objectives](https://sre.google/sre-book/service-level-objectives/).

---

## Key management & rotation

The auth origin signs every access token with one EdDSA key, selected by `kid`
(`packages/auth/src/token.ts:54`), and publishes the public half at the JWKS endpoint with
`Cache-Control: public, max-age=300` (`apps/auth/src/app/.well-known/jwks.json/route.ts:7`). `apps/api`
verifies against that set through `jose`'s `createRemoteJWKSet`, which caches the fetched set in-process
(~5 min, `packages/auth/src/token.ts:16,28-31`). Two distinct procedures are needed: **routine rotation**
and **compromise**.

### Signing-key rotation runbook (routine)

The hard constraint is the **overlap window** must exceed the **propagation delay**, or in-flight tokens
fail verification mid-rotation. Propagation delay = the 300 s JWKS `max-age` **plus** `createRemoteJWKSet`'s
in-process cache on each `apps/api` instance. The `getJwks` helper already anticipates publishing more than
one key ("current key; add next on rotation", `packages/auth/src/token.ts:76,79`).

| Step | Action | Anchor | Notes |
|---|---|---|---|
| 1. Publish next key | Add the new `kid` to the JWKS set **before** signing with it; keep the old key published | `packages/auth/src/token.ts:77-80` | Verifiers must be able to fetch the new key before they ever see a token signed by it |
| 2. Wait out propagation | ≥ `max-age` (300 s) + the `createRemoteJWKSet` cache TTL on every `apps/api` instance, with margin | `apps/auth/src/app/.well-known/jwks.json/route.ts:7`; `packages/auth/src/token.ts:16,28-31` | A 15-min overlap covers the documented caches with headroom |
| 3. Flip signing `kid` | Point `JWT_SIGNING_KID` / `setProtectedHeader.kid` at the new key | `packages/auth/src/token.ts:54` | New tokens now carry the new `kid`; old tokens still verify against the still-published old key |
| 4. Drain | Wait one full access-token TTL (≤15 min, `packages/config/src/env.ts:54`) so every old-`kid` token has expired | `packages/config/src/env.ts:54` | After this no live token references the retiring key |
| 5. Retire old `kid` | Remove the old key from the published JWKS | `packages/auth/src/token.ts:79` | Set is back to a single current key |

The boot self-test (`assertSigningKey`, `packages/auth/src/token.ts:88-103`) already fails the deploy loudly
if the active signing key is missing or malformed — the rotation runbook leans on it as the post-flip
verification gate. Owner: **platform** owns the rotation mechanism, **operations** owns the runbook and the
scheduled rotation cadence.

### Signing-key compromise (emergency)

A leaked private signing key means an attacker can mint valid tokens for any user. The routine overlap is
the wrong procedure — it optimizes for zero disruption, and here disruption is the goal.

| Step | Action | Anchor |
|---|---|---|
| Rotate `kid` immediately | Generate a fresh key, publish it, flip signing to it, and **remove the compromised key from JWKS now** (skip the drain — invalidating outstanding tokens is the objective) | `packages/auth/src/token.ts:54,79` |
| Expire outstanding tokens | Deny-list every active session id (`markManyRevoked`) so any token minted with the leaked key is rejected at `apps/api` | `packages/auth/src/revocation.ts:33-35`; `apps/api/src/middleware/authn.ts` |
| Force global re-auth | Revoke all durable sessions (`revokeAllSessionsForUser` per user, the same family-revocation primitive reuse-detection uses) so refresh fails and everyone re-authenticates | `packages/auth/src/session.ts:117` |
| Treat as a breach | Run the signing-key/secret-compromise incident runbook below and open the 72-h breach clock | see "Incident response & breach notification" |

Note the deny-list fail-open caveat (`packages/auth/src/revocation.ts:42-48`): if Redis is unreachable
during the emergency, deny-listing is a no-op — the durable-session revocation (source of truth) is the
control that still holds, and restoring Redis is part of containment.

### KMS data-key custody (resolve the gap)

At-rest secret **encryption** is Implemented — AES-256-GCM with a per-blob IV and auth tag
(`packages/auth/src/secrets.ts:11-26`) protects TOTP/SMS/OIDC client secrets. But **key custody** is
**Partial**: the encryption key is today derived from the dev blind-index key —
`const KEY = createHash("sha256").update(env.BLIND_INDEX_KEY).digest()` (`packages/auth/src/secrets.ts:9`)
— and the "production injects a dedicated KMS data key" line (`packages/auth/src/secrets.ts:8`) is an
aspirational comment, **not** the running path. The module is deliberately structured so the key source can
be swapped without changing callers (`packages/auth/src/secrets.ts:1-3`).

| Concern | What to build | Owner | Notes |
|---|---|---|---|
| Wire the KMS data key | Replace the `sha256(BLIND_INDEX_KEY)` derivation with a KMS-managed data key (envelope encryption) for `encryptSecret`/`decryptSecret` | platform (custody), security (sign-off) | The dev path must never run in prod; the same swap covers the provider-secret store the console flags as `WIRE` (`apps/api/src/features/admin/providerConfigs.ts:59`) |
| Data-key rotation policy | Define a rotation interval and a re-wrap procedure for stored ciphertext (`user_mfa_methods.secret_enc`, `tenant_sso_configs.oidc_client_secret_enc`) | operations (cadence), security | AES-256-GCM ciphertext is `iv|tag|ct` (`packages/auth/src/secrets.ts:15`); a key-id prefix enables staged re-wrap |
| Custody separation | The KMS key is not reusable as the blind-index key; separate keys, separate rotation | security | Sharing one secret across encryption and blind-indexing couples two unrelated rotation lifecycles |

Routing per CLAUDE.md: secrets/KMS custody is a `truepoint-security` and `truepoint-platform` concern;
operations owns the rotation cadence. Mechanism reference:
[NIST SP 800-57 Part 1 Rev. 5 — Key Management](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final).

---

## DSAR, retention & deletion of auth artifacts

The prospect dataset already has a DSAR/deletion path (`dsar_requests`, `createDsarRequest` —
`packages/core/src/compliance/dsarIntake.ts:10-20`; suppression on consent withdrawal —
`packages/core/src/compliance/consent.ts`). **Auth artifacts are a parallel, currently-unbuilt concern.**
A subject-access or erasure request must enumerate and act on every auth store, and a user/tenant deletion
must propagate into auth.

| Auth artifact | Table / store | DSAR export | Deletion / anonymization on user delete | On tenant delete |
|---|---|---|---|---|
| Identity | `users` (`packages/db/src/schema/auth.ts:44-62`) | Profile fields, `last_login_at`, `auth_provider` | Hard-delete or anonymize email/name; `password_hash` destroyed | Cascade via `tenant_members` ON DELETE CASCADE (`auth.ts:71-73`); a global user in no other tenant is anonymized/erased |
| Sessions | `user_sessions` (`auth.ts:162-193`) | List of devices/IPs/timestamps held | Hard-delete all rows (cascades on user delete, `auth.ts:166-168`); also deny-list live `sid`s | All tenant-scoped sessions hard-deleted |
| MFA secrets | `user_mfa_methods` (`auth.ts:195-206`) | Enrolled method types + labels (never the secret) | Hard-delete (`secret_enc` is encrypted; deletion destroys it) | n/a (user-scoped) |
| Trusted devices | `trusted_devices` (`auth.ts:208-224`) | Device names, last IP, last geo | Hard-delete (IP/geo are personal data) | n/a (user-scoped) |
| Auth email tokens | `auth_email_tokens` (`auth.ts:279-288`) | Outstanding verify/magic/reset/OTP tokens for the subject's email | Hard-delete; short-lived anyway (`expires_at`) | Delete tenant-linked tokens |
| Recovery codes | (no table yet — `matchRecoveryCode` awaits "the recovery-code table", `packages/auth/src/mfaVerify.ts:2-3`) | Count remaining (never the codes) | Hard-delete once the store is built — **Planned** | n/a |
| Auth audit | `audit_log` (auth slice, `packages/db/src/repositories/auditRepository.ts:11-32`) and `platform_audit_log` (`packages/db/src/rls/platform.sql:16-49`) | Subject's own auth events | **Pseudonymize, do not delete** — see tension below | Retained per policy; subject pseudonymized |

**Resolving the immutable-audit vs right-to-erasure tension.** The auth audit trail is deliberately
**append-only and tamper-evident**: `platform_audit_log` has a `BEFORE UPDATE OR DELETE` trigger that
raises on any mutation (`packages/db/src/rls/platform.sql:42-49`), and the tenant `audit_log` exposes no
mutation helper for the same reason (`packages/db/src/repositories/auditRepository.ts:1-3`). A
right-to-erasure request cannot be honoured by deleting those rows — that would both break the tamper-evident
chain and destroy the accountability record. The resolution, consistent with the data skill's "audit
survives without the PII" principle ([`truepoint-data` retention-and-deletion]), is **pseudonymization of
the subject, not deletion of the record**: the audit row holds IDs and actions, not personal contents, so
replacing the `actor_user_id`/subject reference with an irreversible tombstone token leaves "an auth event
of this type occurred at this time" intact while the person is no longer identifiable. Because the existing
trigger blocks an in-place `UPDATE`, this is implemented as a controlled, owner-connection re-issue (a
documented administrative path that preserves the chain), not an app-role mutation — and is itself audited.

**Retention durations** (reconcile with `truepoint-data` retention-and-deletion, which defines retention
per data class enforced by scheduled idempotent sweeps):

| Artifact class | Suggested retention | Rationale |
|---|---|---|
| `user_sessions` (revoked/expired) | Prune shortly after expiry (the schema already calls for it — `packages/db/src/schema/auth.ts:186-188,194`) | A never-pruned append-only session table degrades the silent-refresh hot path |
| `auth_email_tokens` | Delete on consume or expiry | Single-use, short-lived by design |
| Auth `audit_log` / `platform_audit_log` | Retain for the security/compliance window (e.g. 1–2 years), then pseudonymize/age out | Accountability + breach reconstruction; survives PII deletion because it never held PII |
| Trusted devices | Expire at `trusted_until` + a grace window | The 30-day MFA-skip window (`auth.ts:219`) bounds usefulness |

Both **GDPR** ([Art. 15 access](https://gdpr-info.eu/art-15-gdpr/),
[Art. 17 erasure](https://gdpr-info.eu/art-17-gdpr/)) and **India's DPDP Act 2023**
([Sections 11–12, rights of access & erasure](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf))
apply. Owner: **data** owns the deletion/anonymization mechanics, **security** signs off on completeness,
**operations** runs the sweep and the DSAR fulfillment workflow.

---

## Incident response & breach notification

Each runbook below names a **detection signal** (built in "Auth observability & SLIs"), **containment
steps** (using the levers the code already provides), and the **notification obligation**. The breach clock
starts at *awareness*, not resolution — assessment runs in parallel with mitigation.

### Credential-stuffing wave

| Phase | Action | Anchor |
|---|---|---|
| Detect | **Credential-lockout-rate spike** ( > 5× baseline) and elevated `login.failure`/`login.locked` | `packages/auth/src/rateLimit.ts:112-118`; `packages/types/src/billing.ts:114-116` |
| Contain | Confirm Redis is healthy (lockout fails open if not — `packages/auth/src/rateLimit.ts:54-55`); tighten the credential limiter points/window; raise the Turnstile challenge; consider IP/ASN blocks at the edge | `packages/auth/src/rateLimit.ts:73-96` |
| Notify | A stuffing wave with no confirmed account takeover is **not** a personal-data breach — no clock. If accounts were taken over, switch to the session/credential-breach runbook | see below |

### IdP / SSO outage (operationalize break-glass)

The plan recommends a break-glass for SSO-enforced tenants; this is the runbook that operationalizes it.
Today SSO is Stub (`packages/auth/src/sso/providers.ts:16-38`), so this is **Planned**, gated on real
OIDC/SAML landing.

| Phase | Action | Anchor |
|---|---|---|
| Detect | **SSO-callback error %** spike for a tenant (its IdP is down/misconfigured) | `packages/types/src/billing.ts:123` |
| Contain | Invoke the documented break-glass: a time-boxed, audited path that lets a tenant owner authenticate with a non-SSO factor while `require_sso` is bypassed for that account, every use written to audit | `packages/db/src/schema/auth.ts:255` (`require_sso`); `09-threat-model.md` ("IdP-initiated SSO") |
| Notify | Availability incident, not a breach (no data exposure) — status-page comms per `truepoint-operations` incident-response | — |

### Signing-key / secret compromise

| Phase | Action | Anchor |
|---|---|---|
| Detect | Key-leak report, anomalous token minting, or KMS/secret-store alert | "Key management & rotation" above |
| Contain | Run the **compromise** procedure: emergency `kid` rotation, deny-list all sessions, force global re-auth | `packages/auth/src/token.ts:54,79`; `packages/auth/src/revocation.ts:33-35`; `packages/auth/src/session.ts:117` |
| Notify | A signing-key leak enabling token forgery is access to personal data — **reportable**. Start the GDPR 72-h clock; assess DPDP obligation | see clock below |

### Session / credential breach (account takeover, hash exposure)

| Phase | Action | Anchor |
|---|---|---|
| Detect | Token-refresh-failure spike (mass family revocation), confirmed ATO reports, or hash-store exposure | `packages/auth/src/session.ts:106-123` |
| Contain | Revoke affected sessions + deny-list `sid`s; force password reset (re-hash + global logout — `completePasswordReset` already force-logs-out everywhere); rotate any exposed secret | `packages/auth/src/session.ts:78-87,117`; password-reset force-logout (doc 02 §2) |
| Notify | Exposure of credentials/PII for identifiable individuals is a personal-data breach | see clock below |

**The notification clock.** Under **GDPR Art. 33**, a personal-data breach that risks individuals' rights
is reported to the supervisory authority **without undue delay and within 72 hours of becoming aware**;
high-risk breaches also require notifying affected individuals (Art. 34). India's **DPDP Act 2023 (Section
8(6))** requires notifying the Data Protection Board and each affected Data Principal of a personal-data
breach. Honour the **stricter of legal and contractual** obligations; enterprise contracts often specify a
faster window and a named contact. Breach assessment — what data, whose, how many, what risk — runs in
parallel with the technical fix because the clock is already running. Sources:
[GDPR Art. 33](https://gdpr-info.eu/art-33-gdpr/), [GDPR Art. 34](https://gdpr-info.eu/art-34-gdpr/),
[DPDP Act 2023 (PDF)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf),
[CISA Incident-Response guidance](https://www.cisa.gov/topics/cybersecurity-best-practices). Routing:
`truepoint-operations` runs the response; `truepoint-security` owns the obligation determination.

---

## Email & SMS deliverability

Every passwordless and recovery flow depends on a message actually arriving: the magic link, the signup
verification code, the password-reset code, and the (planned) sign-in security alert all route through one
transactional-email seam (`apps/auth/src/lib/mailer.ts:27-45`). That seam is **Partial** for production: it
sends via `nodemailer` over `SMTP_URL` with a `From` of `no-reply@<auth host>`
(`apps/auth/src/lib/mailer.ts:20,38-44`), but when `SMTP_URL` is unset it logs-and-warns rather than
sending (`mailer.ts:32-37`) — silent non-delivery — and there is **no ESP, SPF/DKIM/DMARC, bounce
handling, or delivery monitoring** wired. If reset/verification mail lands in spam or is silently dropped,
users are locked out and there is no signal that it happened.

| Concern | What to build/measure | Owner | Notes |
|---|---|---|---|
| Domain authentication | Publish **SPF, DKIM, and a DMARC policy** (start `p=none`, move to `p=quarantine`/`p=reject`) for the sending domain so reset/magic-link/alert mail authenticates | operations (DNS), platform (sender config) | Without it, transactional auth mail is spam-foldered or rejected |
| ESP / reputation | Choose a reputable ESP for transactional auth mail (dedicated IP/subdomain so marketing volume never poisons auth deliverability) | operations | Replaces the bare `SMTP_URL` path (`mailer.ts:25,38`) |
| Bounce / complaint handling | Consume ESP bounce + complaint webhooks; suppress hard-bounced addresses; surface to support | platform (ingest), operations (process) | A hard-bounce on a reset address is a lockout signal |
| Delivery monitoring | Track delivery/open/failure rates for magic-link, signup-code, reset, and sign-in-alert classes; alert on a delivery-rate drop | operations | A deliverability dip is an auth-availability incident, not a marketing metric |

**SMS-OTP** is **Stub** today — the type exists (`user_mfa_methods.type` includes `sms`,
`packages/db/src/schema/auth.ts:200`) but `verifyMfaCode` routes every non-TOTP method to `return false`
(`packages/auth/src/mfaVerify.ts:16-22`). When SMS-OTP leaves its discouraged-fallback status (NIST SP
800-63B restricts SMS as a "restricted" authenticator —
[NIST SP 800-63B §5.1.3.3](https://pages.nist.gov/800-63-3/sp800-63b.html#sms)), the deliverability and
abuse surface below applies:

| Concern | What to build/measure | Owner | Notes |
|---|---|---|---|
| Telephony provider | Select an SMS provider with international reach and good carrier routes | operations | — |
| A2P / sender registration | Register the A2P sender / brand (e.g. US 10DLC, and per-country sender-ID rules) before sending | operations, security | Unregistered traffic is filtered/blocked by carriers |
| Per-message + international cost | Meter SMS cost per message and per destination country (FinOps below) | operations | International OTP is a top cost driver |
| SMS-pumping / toll-fraud controls | Rate-limit OTP sends per number/IP/tenant; geo-allowlist; anomaly-alert on a send spike to premium ranges | security, operations | SMS-pumping fraud inflates spend with no legitimate user — tie to the abuse signals in `truepoint-security` api-security |

---

## Data residency map

`truepoint.in` serving EU/UK and Indian customers means auth data has a **region**. The tenant already
carries a `region_default` (`packages/db/src/schema/auth.ts:38`), but no auth store is region-pinned yet —
region-pinning is **Planned** and must be coordinated with platform (the tenancy mechanism) and data (the
record model).

| Region-bound auth store | What it holds | Residency obligation / handoff | Owner |
|---|---|---|---|
| Postgres auth tables | `users`, `user_sessions`, `user_mfa_methods`, `trusted_devices`, `auth_email_tokens`, `tenant_sso_configs` (`packages/db/src/schema/auth.ts:44-288`) | Pin to the tenant's `region_default` (`auth.ts:38`); an EU/India tenant's identity + MFA data stays in-region | platform (tenancy), data |
| Redis | Session deny-list (`packages/auth/src/revocation.ts:20`), rate-limit counters (`packages/auth/src/rateLimit.ts:13-15`) | Co-locate with the auth origin's region; deny-list keys reference `sid`s (pseudonymous) but rate-limit keys include identifier/IP — treat as in-region | platform |
| Audit log | `audit_log`, `platform_audit_log` (`packages/db/src/rls/platform.sql:16-49`) | Holds IPs and actor IDs — region-bound personal data; pin with the Postgres tier | platform, security |
| Email provider | Transactional auth mail (`apps/auth/src/lib/mailer.ts`) | Choose an ESP with in-region processing / an appropriate transfer mechanism (SCCs) for EU recipients | operations, security |
| SMS provider | OTP delivery (when SMS leaves Stub) | Provider region + carrier routing must honour the recipient's jurisdiction | operations, security |

Cross-region transfer (e.g. an EU subject's auth data leaving the EU) needs a lawful transfer mechanism —
[GDPR Chapter V (Arts. 44–49)](https://gdpr-info.eu/chapter-5/). Routing: residency is a
`truepoint-security` compliance concern enforced on the `truepoint-platform` tenancy mechanism, with
`truepoint-data` owning where the record lives.

---

## FinOps

Auth is not free to run at scale. Each driver below needs a cost owner and, where a tenant can drive it, a
per-tenant control — consistent with the FinOps discipline that bounds metered spend per tenant
([`truepoint-operations` finops]).

| Cost driver | What to measure / control | Owner | Notes |
|---|---|---|---|
| SMS per-message | Per-message + per-country cost; **per-tenant and per-user OTP send caps** | operations, security | International SMS-OTP is the single most expensive auth path and the prime SMS-pumping target |
| Email volume | Transactional send volume per class; ESP tier; per-tenant send caps to bound a runaway loop | operations | A retry/loop bug on magic-link or alert mail is a silent cost (and reputation) hole |
| Redis memory | Deny-list + rate-limit key footprint at scale; TTLs already bound it (deny-list TTL = access-token lifetime, `packages/auth/src/revocation.ts:25`; rate-limit windows, `packages/auth/src/rateLimit.ts:26,34,75`) | platform | Memory grows with concurrent sessions + active identifiers; size the tier to peak login load |
| KMS operations | Encrypt/decrypt call volume once the KMS data key is wired (every MFA/OIDC-secret read) | platform | Cache the unwrapped data key in-process (envelope pattern) so KMS isn't called per secret op |

Per-tenant cost controls slot into the same plan-allowance + hard-cap + per-user-limit model the metered
enrichment path uses ([`truepoint-operations` finops]): an SMS-OTP send cap and an email send cap per
tenant, with a hard global backstop so a bug or a compromised session cannot run an unbounded bill. Tie the
spend dashboards to the abuse alerts in "Auth observability & SLIs" — a cost spike and an abuse spike are
usually the same event.

---

## Consent & lawful basis

The plan's risk-based and trusted-device features process personal data **beyond what authenticating the
user strictly requires**, so they need a lawful basis (and, where consent is the basis, a captured
consent) **before they ship**:

- **Device / IP / geo risk profiling** — adaptive/step-up auth profiles device fingerprints, IP, and
  geolocation. The schema already anticipates storing `last_ip` and `last_geo` on a device
  (`packages/db/src/schema/auth.ts:217-218`).
- **Trusted-device tracking** — the 30-day MFA-skip window persists a device fingerprint, IP, and geo per
  user (`trusted_devices`, `packages/db/src/schema/auth.ts:208-224`).

| Concern | What to build/measure | Owner | Notes |
|---|---|---|---|
| Lawful basis for risk profiling | Determine and document the basis (legitimate-interest assessment, or consent) for storing device/IP/geo for risk scoring **before** the feature ships | security (basis), operations (capture) | IP + geo + device fingerprint is personal data under GDPR/DPDP |
| Consent capture for trusted devices | If "remember this device" relies on consent, capture and record it the way the dataset's consent path already does (`recordConsent`, `packages/core/src/compliance/consent.ts:17-38`) | security, data | Reuse the existing consent ledger rather than a parallel store |
| Withdrawal honoured | Allow the user to revoke trusted-device tracking; revocation removes the stored fingerprint/IP/geo | data | Mirrors the suppression-on-withdrawal pattern (`packages/core/src/compliance/consent.ts`) |

Both regimes require a lawful basis for processing and transparency to the data subject —
[GDPR Art. 6 (lawfulness)](https://gdpr-info.eu/art-6-gdpr/),
[DPDP Act 2023 §§4–6 (grounds & consent)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf).
Routing: lawful basis and consent are `truepoint-security` compliance decisions, captured through the
`truepoint-data` consent mechanism, surfaced by operations before launch.

---

## Operational readiness summary

| Capability | Status today | Anchor |
|---|---|---|
| Auth SLI emission (`login.success` off critical path) | Partial — one signal emitted, no metrics/dashboards | `packages/auth/src/flow.ts:209-240` |
| Audit trail (tenant + platform, append-only) | Implemented | `packages/db/src/rls/platform.sql:16-49`; `packages/db/src/repositories/auditRepository.ts:1-32` |
| SLOs + degraded-mode runbook | Absent — fail-open behaviour exists but is undocumented/unalarmed | `packages/auth/src/rateLimit.ts:54-55`; `packages/auth/src/revocation.ts:42-48` |
| Signing-key rotation (mechanism) | Implemented — multi-key JWKS + boot self-test; runbook Absent | `packages/auth/src/token.ts:77-103` |
| At-rest secret encryption | Implemented (AES-256-GCM) | `packages/auth/src/secrets.ts:11-26` |
| KMS data-key custody | Partial — dev-derived key in the running path | `packages/auth/src/secrets.ts:9` |
| DSAR / deletion for auth artifacts | Planned — dataset DSAR exists, auth-artifact path does not | `packages/core/src/compliance/dsarIntake.ts:10-20` |
| Email deliverability (SPF/DKIM/DMARC, ESP, monitoring) | Partial — SMTP seam only | `apps/auth/src/lib/mailer.ts:27-45` |
| SMS-OTP deliverability + fraud controls | Stub (depends on SMS leaving fallback) | `packages/auth/src/mfaVerify.ts:16-22` |
| Data-residency pinning of auth stores | Planned | `packages/db/src/schema/auth.ts:38` |
| Per-tenant auth cost controls | Planned | `packages/auth/src/rateLimit.ts:73-96` |
| Consent / lawful basis for risk + trusted devices | Planned (consent ledger exists for the dataset) | `packages/core/src/compliance/consent.ts:17-38` |
