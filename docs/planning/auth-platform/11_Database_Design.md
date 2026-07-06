# 11 — Database Design

> Document 11 of 12 · TruePoint Centralized Authentication Platform. The auth data model: what exists today (migration
> `0052`), the net-new tables the centralized/configurable platform needs, RLS treatment, indices, and the migration/snapshot
> debt that gates all of it. Grounded in the inventory + token/security audits; schema lives in `packages/db/src/schema/`.

## Executive summary

The existing auth schema is solid and already covers global identity, membership, sessions, MFA, SSO config, domains, auth
policy, invitations, email tokens, SCIM tokens, and the append-only audit logs. The redesign **adds a config-driven layer**
(login-method/provider/branding/email-template config, allowed-origin/callback config, rate-limit and risk policy) plus the
**developer-platform tables** (OAuth clients, grants/consents, API keys/PATs, webhooks), **WebAuthn credentials** for
passkeys, and **impersonation/risk** tables. Two pre-existing issues must be fixed as part of this: a **`WITH CHECK`
asymmetry** on `tenant_members`/`invitations` RLS, and **Drizzle snapshot debt** (`meta/` stops at `0028`, journal runs to
`0052`) that blocks clean additive migrations.

## 1. Existing auth tables (verified, `packages/db/src/schema/{auth,scim,platformOps}.ts`)

| Table | Purpose | Notes / RLS |
|---|---|---|
| `tenants` | Org/tenant root | tenant-scoped RLS |
| `users` | **Global identity** — unique email/username, `password_hash` **nullable** (SSO/passkey-only), `scim_external_id`, `is_platform_admin`, `is_bootstrap_admin` | auth-service-owned (not tenant-RLS-scoped) |
| `tenant_members` | Membership + `org_role` + `status` + `last_workspace_id` | RLS **USING only — no `WITH CHECK`** (fix §5) |
| `platform_staff` | `staff_role` (super_admin/support/…) | deny-all to `leadwolf_app` |
| `workspaces` / `workspace_members` | Workspace + `role` | tenant/workspace RLS |
| `user_sessions` | Durable session — `refresh_token_hash`, `rotated_from`, `expires_at`, `last_seen_at`, `revoked_at`, `device_id` | partial-unique live-hash index `WHERE revoked_at IS NULL` |
| `user_mfa_methods` | `type` (`totp\|sms\|email\|webauthn`), `secret_enc` | encrypted (dev-derived key → KMS, AUTH-013) |
| `trusted_devices` | 30-day MFA-skip (schema-only today, AUTH-049) | **no runtime usage** |
| `tenant_domains` | `domain`, `join_policy` (`sso_only\|auto_join\|request_access`), `status` | DNS-TXT verify deferred (AUTH-041) |
| `tenant_sso_configs` | Per-org SAML/OIDC connection | secret write-only, encrypted |
| `tenant_auth_policies` | mfa/methods/ip/timeouts/`enforcement_enabled` (strictest-wins) | **subsumed by the effective-policy store (§3)** |
| `invitations` | Email invite (expiring, role-carrying) | RLS **USING only** (fix §5) |
| `auth_email_tokens` | verify/magic/otp/reset tokens | hashed at rest, single-use, TTL |
| `scim_tokens` | SCIM bearer (`token_hash` unique) | tenant-scoped, hash-only |
| `platform_audit_log` | Tenant-less auth audit | deny-all RLS + append-only trigger |
| `audit_log` | Tenant-resolved auth audit | append-only |

## 2. Net-new tables (the centralized/configurable platform)

Grouped by the document that owns them. All tenant-scoped tables are `tenant_id NOT NULL` + FORCE-RLS + a cross-tenant
isolation itest. Config tables that hold **platform defaults** carry a nullable `tenant_id` (NULL = platform scope) with a
policy that only `withPlatformTx` may write the NULL-tenant rows.

### Config layer (docs 03 §11, 04, 06)

- **`auth_login_methods`** — the method registry. `(scope, tenant_id?, method, enabled, priority, config jsonb, org_restrictions jsonb, updated_by, version)`. `scope ∈ {platform, org}`; strictest-wins resolution.
- **`auth_providers`** — SSO/OIDC/SAML connections (supersedes/extends `tenant_sso_configs`): `(tenant_id, protocol, metadata, client_id, client_secret_enc, attribute_map jsonb, jit_default_role, status, cert_fingerprints)`.
- **`auth_policies`** — the generalized effective-policy rows (subsumes `tenant_auth_policies`): `(scope, tenant_id?, workspace_id?, domain, key, value jsonb, version, updated_by)` for password/MFA/session/IP/geo/risk knobs. Platform default → org → workspace, strictest-wins for security keys.
- **`auth_branding`** — per-org login-portal branding: `(tenant_id, logo_url, colors jsonb, custom_domain, portal_slug)`.
- **`auth_email_templates`** — per-org overridable templates: `(scope, tenant_id?, template_key, subject, html, text, locale, version)`.
- **`auth_allowed_origins`** — managed allow-list for callbacks/origins (env as floor): `(scope, tenant_id?, origin, kind)`.
- **`auth_rate_limits`** — per-tenant knobs: `(tenant_id?, endpoint, limit, window)`.

### Developer / OAuth platform (docs 08 §7, 10)

- **`oauth_clients`** — first-party + third-party clients: `(tenant_id?, client_id, client_secret_hash?, name, type, grant_types[], redirect_uris[], scopes[], token_ttls jsonb, sender_constraining, status)`. Drives the per-client policy matrix (doc 08 §5).
- **`oauth_grants`** — user consents to third-party apps: `(user_id, client_id, tenant_id, scopes[], granted_at, revoked_at)` — powers self-service connected-apps (AUTH-017, doc 05).
- **`oauth_authorization_codes`** — short-lived auth-code store (or Redis): PKCE challenge, redirect, scope, expiry.
- **`api_keys`** — scoped keys / PATs: `(tenant_id, user_id?, name, key_hash, scopes[], last_used_at, expires_at, revoked_at, created_by)`. Hash-only, shown-once. Service-account keys have `user_id NULL`.
- **`service_accounts`** — machine identities: `(tenant_id, name, scopes[], status)` — client-credentials principals.
- **`auth_webhooks`** / **`auth_webhook_deliveries`** — signed outbound auth-event subscriptions + delivery log (SSRF-guarded), mirroring the M12 webhook infra.

### MFA / passkeys / risk (docs 05, 09)

- **`webauthn_credentials`** — passkeys: `(user_id, credential_id, public_key, aaguid, sign_count, transports[], attestation_type, rp_id, created_at, last_used_at, name)`. The primary factor target (AUTH-024).
- **`mfa_recovery_codes`** — already implied by TOTP flow; formalize `(user_id, code_hash, used_at)` if not a column set on `user_mfa_methods`.
- **`auth_risk_signals`** / **`device_fingerprints`** — adaptive auth: `(user_id, session_id?, signal jsonb, score, decision, created_at)` + `(user_id, fingerprint_hash, first_seen, last_seen, trusted)`. Consent-gated (AUTH-060).
- **`trusted_devices`** — wire the existing schema-only table to the 30-day skip (AUTH-049).

### Staff / lifecycle

- **`impersonation_sessions`** — time-boxed, audited staff impersonation (repo exists, table planned): `(staff_user_id, target_user_id, tenant_id, reason, started_at, expires_at, ended_at, jit_elevation_id)`.
- **`auth_events`** (or reuse `event_outbox`) — the transactional outbox rows feeding webhooks/SIEM/CAEP (doc 03 §8).

## 3. The effective-policy resolution model

`auth_policies` + `auth_login_methods` are read through a **resolver** that composes
`platform default (tenant_id NULL) → org override → workspace override` and returns a **versioned** decision, cached in Redis
keyed by `(tenant, workspace, version)` with invalidation on any write. **Security keys are strictest-wins** — an org can
tighten (require MFA, shorter session) but never loosen a platform minimum; the write path rejects a loosening attempt. This
generalizes today's `tenant_auth_policies` strictest-wins logic to arbitrary config.

## 4. RLS treatment

- **Tenant-scoped config/dev tables:** FORCE-RLS, `USING (+WITH CHECK) tenant_id = current_setting GUC`, fail-closed
  `NULLIF`. Isolation itest per table.
- **Platform-default rows** (`tenant_id NULL`): readable by `leadwolf_app` (they are the defaults), writable **only** via
  `withPlatformTx` (owner role) — a policy that denies `leadwolf_app` writes to NULL-tenant rows.
- **Secret columns** (`client_secret_enc`, `secret_enc`, `key_hash`, `token_hash`): encrypted or hashed at rest; the at-rest
  key moves to KMS with versioning (AUTH-013). Never selected into a normal read model.
- **Audit tables:** append-only trigger + deny-all to `leadwolf_app`, unchanged.

## 5. Integrity fixes (pre-existing, in-scope)

1. **`WITH CHECK` asymmetry (AUTH-adjacent).** `tenant_members` and `invitations` have `USING`-only RLS while sibling auth
   tables have `USING + WITH CHECK`. Since SCIM/membership writes go through these tables, add the `WITH CHECK` clause so the
   write-side tenant constraint matches the read-side — closing an asymmetry a future direct-write path could exploit.
2. **Drizzle snapshot debt.** `meta/` snapshots stop at `0028_snapshot.json` while the journal runs to `0052`
   (`migrations/_MAIN_MERGE_TODO.md`); the runtime migrator works but `drizzle-kit generate` cannot safely diff and a naive
   generate would drop 14 hand-written seed INSERTs. **Stitch the snapshots before authoring the net-new tables** (Phase 1,
   doc 12) so every new migration is a clean, reversible, seed-preserving addition.

## 6. Indices (hot paths)

- `user_sessions`: partial-unique on live `refresh_token_hash WHERE revoked_at IS NULL` (exists); index `(user_id)` for
  family-revoke + concurrent-session count; `(device_id)`.
- `auth_email_tokens`: index on `token_hash` (single lookup), `(user_id, purpose)`, TTL cleanup on `expires_at`.
- `api_keys`: unique `key_hash`; `(tenant_id, revoked_at)`.
- `oauth_grants`: `(user_id, client_id)`; `webauthn_credentials`: unique `credential_id`, `(user_id)`.
- `auth_policies` / `auth_login_methods`: `(scope, tenant_id, key/method, version)` for the resolver.
- `audit_log` / `platform_audit_log`: `(tenant_id, created_at)` / `(created_at)` for SIEM export + retention sweeps.

## 7. Retention & residency

- **Sessions:** revoked rows retained for audit N days then swept (worker); `last_seen_at` drives idle expiry.
- **Audit:** retention policy + SIEM export (AUTH-038); the immutable-audit-vs-erasure tension (DSAR, AUTH-014) resolved by
  pseudonymizing PII in audit rows on erasure while preserving the event record.
- **Residency:** enterprise tenants route to dedicated clusters / region-pinned storage (target); a residency map for auth
  artifacts (AUTH-039) documents where each table's data lives (India DPDP / APAC).

## 8. Security considerations

- All new tenant tables carry `tenant_id NOT NULL` + FORCE-RLS + isolation itest (non-negotiable).
- Secrets hashed/encrypted at rest, KMS-managed, never in a read model or log.
- Config writes are `withPlatformTx`/staff-RBAC-gated and cannot loosen a security minimum (poisoned-config is a threat, doc
  09).
- Mass-assignment allowlists: no `org_role`/`is_platform_admin` settable from an IdP/SCIM claim (AUTH-034).

## 9. Migration & testing strategy

1. Stitch snapshot debt (§5.2) + add the `WITH CHECK` clauses (§5.1) — Phase 1 prerequisites.
2. Additive, reversible migrations per net-new table, each with up+down and preserved seeds.
3. Cross-tenant isolation itest per new tenant-scoped table (prove a query without the GUC returns nothing).
4. Resolver correctness tests: platform default → org → workspace, strictest-wins, version invalidation.

## 10. Risks & future enhancements

- **Snapshot-debt stitch is delicate** — a wrong stitch could drop seeds; do it first, reviewed, before net-new tables.
- **The config layer is a lockout/escalation surface** — versioning + audit + strictest-wins + default-OFF flips mitigate.
- **Future:** per-tenant dedicated clusters + region pinning (residency); partitioning `audit_log`/`auth_events` by time at
  scale; a read-model/materialized view for the `/account/security` dashboard.
