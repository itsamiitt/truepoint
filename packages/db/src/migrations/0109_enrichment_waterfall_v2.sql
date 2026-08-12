-- 0109_enrichment_waterfall_v2.sql — waterfall v2 substrate [S-04][S-08][A-01] (hand-authored).
--
-- 1) THE LEDGER FIX. provider_calls was unique on (workspace_id, request_hash) while the hash is
--    provider-independent (core requestHash.ts) and enrichContact records one row PER ATTEMPT under the
--    same hash with onConflictDoNothing — so on any multi-attempt run every row after the first was
--    silently dropped: a miss-then-hit run lost the hit's cost (spendSince undercounted) AND its cache
--    row (findCached filters status='hit'), so the same request re-paid the missing provider forever.
--    The unique becomes (workspace_id, request_hash, provider_name): every attempt persists, concurrent
--    duplicates still collapse per provider.
--    Existing rows can't violate the WIDER unique (any (ws,hash) group has at most one row), so this is
--    a safe in-place swap.
-- 2) Per-field cache + telemetry columns (filled_fields / latency_ms / verification) — nullable; a null
--    filled_fields marks a legacy whole-request row and is honored as covering every requested field.
-- 3) source_imports CHECK gains 'pdl'/'coresignal' (new sub-processors; adapters land DARK — no API key
--    in production until the DPA + sub-processor listing + ToS review are recorded, 08-compliance §10).
-- 4) enrichment_policy.provider_prefs — the per-workspace provider priority + verification knobs
--    (validated by @leadwolf/types providerPrioritySchema/verificationPolicySchema at the edge).
-- 5) audit_log CHECK gains 'enrichment.policy_updated' (written in-tx by applyPartial).

DROP INDEX IF EXISTS "uniq_provider_calls_ws_hash";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_calls_ws_hash_provider"
  ON "provider_calls" ("workspace_id", "request_hash", "provider_name");
--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN IF NOT EXISTS "filled_fields" jsonb;
--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN IF NOT EXISTS "latency_ms" integer;
--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN IF NOT EXISTS "verification" jsonb;
--> statement-breakpoint
ALTER TABLE "source_imports" DROP CONSTRAINT IF EXISTS "source_imports_source_name_enum";
--> statement-breakpoint
ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_source_name_enum"
  CHECK ("source_name" IN ('apollo','zoominfo','linkedin','sales_navigator','hubspot','salesforce','clearbit','manual','pdl','coresignal'));
--> statement-breakpoint
ALTER TABLE "enrichment_policy" ADD COLUMN IF NOT EXISTS "provider_prefs" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_action_enum";
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_enum"
  CHECK ("action" IN (
    'reveal','reveal.blocked','export','send','enroll','unsubscribe',
    'suppression.add','suppression.remove','consent.record','consent.withdraw',
    'dsar.access','dsar.delete','dsar.rectify','member.add','member.update','member.remove',
    'apikey.use','credit.adjust',
    'contact.create','contact.update','contact.delete','account.create','account.update','account.delete',
    'list.create','list.update','list.delete','sequence.create','sequence.update','sequence.delete',
    'template.create','template.update','template.delete','settings.update',
    'automation.rule.create','automation.rule.update','automation.rule.delete',
    'custom_field.create','custom_field.update','custom_field.delete',
    'tag.create','tag.update','tag.delete','tag.assign','tag.unassign',
    'pipeline_stage.create','pipeline_stage.update','pipeline_stage.delete','pipeline_stage.assign',
    'saved_search.create','saved_search.update','saved_search.delete',
    'automation.rule.enable','automation.rule.disable','automation.rule.run',
    'ai.config.update','ai.draft.approve','ai.draft.reject',
    'mailbox.connect','mailbox.disconnect','sending_domain.add','sending_domain.verify',
    'login.success','login.failure','login.locked','mfa.challenge','mfa.success','mfa.failure',
    'password.reset.request','password.reset.complete','sso.initiated','sso.callback',
    'token.issued','token.refresh','token.revoke','device.trusted','device.revoked','session.revoked',
    'code.issued','code.exchanged','signup','oauth.link',
    'import.policy_updated','enrichment.policy_updated',
    'import.committed','import.cancelled','import.retry_created','import.template_saved','import.artifact_downloaded',
    'import.av_infected','import.draft_reaped',
    'channel_added','channel_promoted','channel_deleted','channel_primary_demoted',
    'contact.merge',
    'crm.connect','crm.disconnect','crm.sync','crm.mapping.update','crm.erase'
  ));
