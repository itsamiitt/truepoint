-- 0137_api_keys.sql — machine API credentials (09 §1 "Auth (machine/public)", §4; ADR-0049) [A-01]
-- HAND-AUTHORED, additive-only. No drizzle-kit generate: the meta/ snapshots have been sparse since 0107
-- (0108-0136 are all hand-authored with a journal entry and no snapshot), so a generate here would diff
-- against a stale snapshot and emit a migration that re-adds tables that already exist.
--
-- WHY NOW. The management UI for this table already shipped and has been dark since M10:
-- apps/web/src/features/settings-developer does create / rotate / revoke and the one-time secret reveal, and
-- degrades to "API keys connect once the developer API ships" because GET /api/v1/tenants/me/api-keys
-- answers 404. This is the missing half. The wire contract is therefore fixed by that shipped client.
--
-- WHY key_hash IS GLOBALLY UNIQUE AND NOT (tenant_id, key_hash). It is the authentication lookup key, and at
-- lookup time the tenant is not yet known — that is precisely what the lookup is for. A tenant-scoped unique
-- would permit the same hash under two tenants and make the pre-tenant resolution ambiguous, which is a
-- cross-tenant authentication bug rather than a collision nuisance. Same posture as scim_tokens.token_hash.
--
-- WHY workspace_id IS NOT NULL. tenancy.md: scope comes from the credential, never the request. A key with no
-- workspace would have to take one from an X-Workspace-Id header, reintroducing exactly the client-controlled
-- scope that rule forbids. This resolves 09 §11 open question 4 in favour of key→workspace binding.
--
-- ON DELETE CASCADE on both FKs: a deleted tenant or workspace must not leave a live credential behind. A key
-- whose workspace is gone can authenticate but has nothing to act on, which is a worse failure than deletion.
--
-- RLS + GRANT land via rls/apiKeys.sql on the same migrate (the watchlists/scim convention) — not here.
--
-- DOWN (manual; forward-only project): DROP TABLE api_keys.

CREATE TABLE IF NOT EXISTS api_keys (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                varchar(100) NOT NULL,
  -- SHA-256 hex of the plaintext key. The plaintext is shown once at creation and NEVER persisted.
  key_hash            varchar(255) NOT NULL,
  -- Non-secret display fragment ("tp_live_a1b2c3d4"). NOT unique, NOT an authentication input.
  key_prefix          varchar(32) NOT NULL,
  scopes              text[] NOT NULL,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  CONSTRAINT api_keys_scopes_non_empty CHECK (cardinality(scopes) > 0)
);
--> statement-breakpoint
-- Globally unique — see the header. A duplicate insert or a (vanishingly unlikely) hash collision is
-- rejected at the DB layer rather than producing two rows one lookup could match.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_api_keys_key_hash ON api_keys (key_hash);
--> statement-breakpoint
-- tenant_id leads, per tenancy.md — the management list reads (tenant_id, created_at desc).
CREATE INDEX IF NOT EXISTS api_keys_tenant_created_idx ON api_keys (tenant_id, created_at DESC);
--> statement-breakpoint
COMMENT ON TABLE api_keys IS
  'Machine API credentials (09 §4, ADR-0049). Tenant- and workspace-scoped; only the SHA-256 hash is stored.';
--> statement-breakpoint
COMMENT ON COLUMN api_keys.key_prefix IS
  'Non-secret display fragment for the management list. Never an authentication input.';
