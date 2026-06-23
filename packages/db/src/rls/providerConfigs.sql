-- providerConfigs.sql — provider_configs is PLATFORM-global enrichment-provider settings (13 §3.6). It holds
-- NO secrets (provider API keys live in env/KMS). The customer app role may READ it (it is global config the
-- enrichment budget breaker consults — not tenant data) but must never WRITE it; only the owner /
-- withPlatformTx path mutates it. ENABLE (not FORCE) so the owner writer is exempt; a SELECT-only policy
-- (USING true — the rows are global, not tenant-scoped) lets leadwolf_app read, and the absence of any write
-- policy denies its INSERT/UPDATE/DELETE even though the blanket grant hands it the table privilege.
-- Idempotent — safe to re-run on every migrate. The table is created by the Drizzle migration.

ALTER TABLE provider_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_configs_read ON provider_configs;
CREATE POLICY provider_configs_read ON provider_configs FOR SELECT USING (true);
