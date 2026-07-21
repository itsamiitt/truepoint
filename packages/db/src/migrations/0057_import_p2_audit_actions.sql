-- 0057_import_p2_audit_actions.sql — S-I9's P2 audit-action CHECK extension (import-and-data-model-redesign
-- 15 §M-SEQ seq 40; ruling M1: "the CHECK is extended once per phase, with exactly the actions that phase's
-- verbs write"). ADDITIVE ONLY — the 0054 technique re-issued: drop + re-ADD the closed enum with ALL current
-- actions plus exactly the two P2 SYSTEM-terminal actions their writers were deferred on (doc 16 drift rows
-- 2026-07-05 / 2026-07-06):
--   • 'import.av_infected'  — the copy drive's infected terminal (13 §2.2/§2.3; writer: runBulkImport's
--     failInfected, in-tx with the failed transition; actor = system/null, facets = jobId + signature label);
--   • 'import.draft_reaped' — the S-I8 draft reaper's TTL delete (08 §2.1 "reaped (sweep; row deleted,
--     audited)"; writer: importReaperSweep job 4, in-tx with the draft-pinned row DELETE; facets = jobId + age).
-- No other action joins here: 08 §7's remaining lifecycle verbs shipped in 0054 (P1), 05 §7's channel_* are
-- P3's, contact.merge is P4's (M1). The pre-existing types-enum 'mfa.enroll' drift stays EXCLUDED (doc 16
-- 2026-07-05 row — owned by the auth track, not this train). Mirrors: packages/types/src/billing.ts
-- auditAction (source of truth) + packages/db/src/schema/billing.ts CHECK.
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_enum";--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_enum" CHECK ("audit_log"."action" IN (
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
        'import.policy_updated',
        'import.committed','import.cancelled','import.retry_created','import.template_saved','import.artifact_downloaded',
        'import.av_infected','import.draft_reaped'
      ));

-- DOWN (manual, per 15 §R-P2 — additive; safe once the two writers are reverted with it, since any committed
-- 'import.av_infected'/'import.draft_reaped' rows would violate a re-narrowed CHECK — delete or exclude them first):
--   ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_enum;
--   -- then re-ADD the 0054 list (without the two P2 'import.*' actions above)
