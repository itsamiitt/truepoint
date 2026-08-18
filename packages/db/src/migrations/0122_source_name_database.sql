-- 0122_source_name_database.sql — admit 'database' into the source_imports vocabulary [A-01][C-01]
-- (the 0115/0120 pattern verbatim). A contact materialized from the TruePoint database ("Add to workspace"
-- from the global search / extension in-database hit) appends one source_imports provenance row with
-- source_name = 'database' — vendor-neutral by construction (never "database:<vendor>", which would leak the
-- provider into the customer-visible source facet). The enum member and the CHECK move together with the
-- @leadwolf/types sourceName zod.

ALTER TABLE "source_imports" DROP CONSTRAINT IF EXISTS "source_imports_source_name_enum";
--> statement-breakpoint
ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_source_name_enum"
  CHECK ("source_name" IN ('apollo','zoominfo','linkedin','sales_navigator','hubspot','salesforce','clearbit','manual','pdl','coresignal','linkedin_api','chrome_extension','database'));
