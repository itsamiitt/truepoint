-- 0119_enable_all_flags.sql — production-wide global flag enablement (operator-directed, 2026-08-18).
-- SEED/DATA ONLY (0088 precedent). Two steps, both idempotent:
--   1. Define the five flag keys that shipped constants but no seed migration — without a
--      feature_flags row, evaluateFlag fail-closes ("unknown"), so these features could never be
--      enabled even per-tenant (the tenant-override route 404s on an undefined key).
--   2. Enable every defined flag globally (global_enabled = true; per-tenant overrides still win).
--
-- Three flags are DELIBERATELY held off — enabling them here would be wrong, not conservative:
--   channels_read / account_read_from_child — READ-CUTOVER flags: reads move to the channel/domain
--     child tables, which are only populated by dual-write + backfill. Cutting reads over before the
--     backfill sweeps converge (completeness = 0, drift = 0) serves contacts/accounts with missing
--     emails/phones/domains. Their WRITE halves (channels_dual_write, account_domains_dual_write)
--     ARE enabled below, which is what starts convergence.
--   entitlements_enforced — with the ENTITLEMENTS_ENABLED env half on, flag-off = SHADOW mode
--     (computes + logs, never rejects). Flipping it to REFUSE with no per-tenant entitlement rows
--     provisioned could hard-block active users mid-session. Turn it on deliberately, per rollout.

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES
  ('crm_sync_enabled', 'Per-tenant L2 gate for CRM bidirectional sync (L1 = CRM_SYNC_ENABLED env; L3 = per-connection sync_mode, default shadow). Moving real data additionally needs provider OAuth app config + webhook secrets.', true, false)
ON CONFLICT (key) DO UPDATE SET global_enabled = true;
--> statement-breakpoint

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES
  ('enrichment_waterfall_v2', 'Per-tenant gate for enrichment waterfall v2 (per-field cascade, workspace provider priority). Effective only with WATERFALL_V2_ENABLED env on; inert per provider until its API key is configured.', true, false)
ON CONFLICT (key) DO UPDATE SET global_enabled = true;
--> statement-breakpoint

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES
  ('bulk_reveal_enabled', 'Per-tenant gate for async bulk reveal (confirm-before-spend money path). Effective only with BULK_REVEAL_ENABLED env on.', true, false)
ON CONFLICT (key) DO UPDATE SET global_enabled = true;
--> statement-breakpoint

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES
  ('reply_classification_enabled', 'Per-tenant gate for inbound email reply classification.', true, false)
ON CONFLICT (key) DO UPDATE SET global_enabled = true;
--> statement-breakpoint

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES
  ('email.send', 'Per-tenant gate for the outreach email send queue (M9/M12).', true, false)
ON CONFLICT (key) DO UPDATE SET global_enabled = true;
--> statement-breakpoint

UPDATE feature_flags
SET global_enabled = true, updated_at = now()
WHERE key NOT IN ('channels_read', 'account_read_from_child', 'entitlements_enforced');

-- DOWN (manual): UPDATE feature_flags SET global_enabled = false;
--   DELETE FROM feature_flags WHERE key IN ('crm_sync_enabled','enrichment_waterfall_v2','bulk_reveal_enabled','reply_classification_enabled','email.send');
