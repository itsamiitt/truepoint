-- 0121_master_visibility_and_channel_source.sql — the READ-SIDE policy layer for Layer-0 [A-01][A-03][S-10]
-- (docs/planning: Layer-0 as THE product database, D2/D3). HAND-AUTHORED, idempotent.
--
-- Until now every co-op control (matchOnly, neverShareFields, contribution_policy) bound at MINT time and
-- Layer-0 had no customer read surface, so no read predicate was needed. The global database search + the
-- extension "in database" hit + the reveal channel fallback are customer READS over the shared graph, so the
-- policy must now exist on the read side. It is materialized as ONE column so every read is a cheap,
-- index-served predicate instead of an EXISTS(source_records) probe per row:
--
--   master_persons.visibility ∈ ('private','licensed','coop')
--     private  — minted by a workspace import/capture (MATCH-AGAINST); its facts are that workspace's, never
--                surfaced globally (the co-op boundary, ADR-0021). The default.
--     licensed — landed from a licensed provider (source_records.source_name = 'linkedin_api'); provider data
--                the platform holds a licence to serve every tenant. Set by landPerson.
--     coop     — RESERVED for the Phase-3 CONTRIBUTE-TO writer (contribution_policy.contribute_enabled);
--                nothing sets it today.
--   Every Layer-0 customer read = visibility IN ('licensed','coop') AND is_suppressed = false AND
--   merged_into_person_id IS NULL  (masterPersonReadRepository.MASTER_PERSON_VISIBLE).
--
--   master_emails.source_name / master_phones.source_name — WHO contributed the channel value. The reveal
--   fallback serves ONLY licensed-provider channels (source_name = 'linkedin_api'); a co-op/import channel
--   row (email_enc NULL today) is never revealable across workspaces.
--
-- Backfill: today only the linkedin_api landing writes email_enc/phone_enc into Layer-0 and only its
-- landings create source_records with that source_name, so both UPDATEs are exact. Ship BEFORE the origin
-- fleet is armed (source_records is empty in production) — the backfill is then free.

ALTER TABLE "master_persons" ADD COLUMN IF NOT EXISTS "visibility" varchar(10) NOT NULL DEFAULT 'private';
--> statement-breakpoint
ALTER TABLE "master_persons" DROP CONSTRAINT IF EXISTS "master_persons_visibility_enum";
--> statement-breakpoint
ALTER TABLE "master_persons" ADD CONSTRAINT "master_persons_visibility_enum"
  CHECK ("visibility" IN ('private','licensed','coop'));
--> statement-breakpoint
ALTER TABLE "master_emails" ADD COLUMN IF NOT EXISTS "source_name" varchar(50);
--> statement-breakpoint
ALTER TABLE "master_phones" ADD COLUMN IF NOT EXISTS "source_name" varchar(50);
--> statement-breakpoint
UPDATE "master_persons" p SET "visibility" = 'licensed'
 WHERE p."visibility" = 'private' AND p."is_suppressed" = false
   AND EXISTS (SELECT 1 FROM "source_records" sr
                WHERE sr."resolved_person_id" = p."id" AND sr."source_name" = 'linkedin_api');
--> statement-breakpoint
UPDATE "master_emails" SET "source_name" = 'linkedin_api'
 WHERE "source_name" IS NULL AND "email_enc" IS NOT NULL;
--> statement-breakpoint
UPDATE "master_phones" SET "source_name" = 'linkedin_api'
 WHERE "source_name" IS NULL AND "phone_enc" IS NOT NULL;

-- DOWN (manual): ALTER TABLE master_persons DROP COLUMN visibility; ALTER TABLE master_emails DROP COLUMN
--   source_name; ALTER TABLE master_phones DROP COLUMN source_name;
