-- 0120_source_name_chrome_extension.sql — admit 'chrome_extension' into the source_imports vocabulary
-- [A-01][C-01] (the 0115 pattern verbatim). The capture landing (extension-intelligence-loop slice A)
-- appends one source_imports provenance row per landed capture; the enum member and the CHECK move
-- together with the @leadwolf/types sourceName zod.

ALTER TABLE "source_imports" DROP CONSTRAINT IF EXISTS "source_imports_source_name_enum";
--> statement-breakpoint
ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_source_name_enum"
  CHECK ("source_name" IN ('apollo','zoominfo','linkedin','sales_navigator','hubspot','salesforce','clearbit','manual','pdl','coresignal','linkedin_api','chrome_extension'));
