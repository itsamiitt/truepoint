-- 0066_contact_merge_audit_action.sql — S-C2's P4 audit-action CHECK extension (import-and-data-model-
-- redesign 15 §M-SEQ seq 61; ruling M1: "the CHECK is extended once per phase, with exactly the actions that
-- phase's verbs write"). ADDITIVE ONLY — the 0057/0058 technique re-issued: drop + re-ADD the closed enum
-- with ALL current actions plus exactly the ONE P4 action the merge engine writes:
--   • 'contact.merge' — the customer/Surface-1 true-merge event (04 §4; writer: the S-C4 merge executor,
--     in-tx with the loser tombstone + child re-points; metadata = survivor id, loser id, per-field decision
--     set, loser field_provenance map, re-point counts per child table — reconstructable from audit alone).
-- No other action joins here: channel_* shipped in 0058 (P3), the import.* lifecycle in 0054/0057 (P1/P2).
-- Written by NOBODY until S-C4 lands the engine AND the S-C3 dual gate is ON; landed with S-C2's DDL train so
-- the first writer never fails the DB CHECK. Mirrors: packages/types/src/billing.ts auditAction (source of
-- truth) + packages/db/src/schema/billing.ts CHECK.
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
        'import.av_infected','import.draft_reaped',
        'channel_added','channel_promoted','channel_deleted','channel_primary_demoted',
        'contact.merge'
      ));

-- DOWN (manual, per 15 §R-P4 — additive; safe once the merge writer is reverted with it, since any committed
-- 'contact.merge' rows would violate a re-narrowed CHECK — delete or exclude them first):
--   ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_enum;  -- then re-ADD the 0058 list (without 'contact.merge')
