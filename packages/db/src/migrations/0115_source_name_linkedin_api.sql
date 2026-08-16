-- 0115_source_name_linkedin_api.sql — admit 'linkedin_api' into the source_imports vocabulary [A-01]
-- (hand-authored; the 0111 lines 31-34 pattern verbatim).
--
-- Without this, a winning linkedin_api enrichment gets NO source_imports provenance row (the
-- appendSourceImports skip posture) — the enum member and the CHECK must move together with the
-- @leadwolf/types sourceName zod.

ALTER TABLE "source_imports" DROP CONSTRAINT IF EXISTS "source_imports_source_name_enum";
--> statement-breakpoint
ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_source_name_enum"
  CHECK ("source_name" IN ('apollo','zoominfo','linkedin','sales_navigator','hubspot','salesforce','clearbit','manual','pdl','coresignal','linkedin_api'));
