-- 0055_import_template_sharing.sql — S-I2 (import-and-data-model-redesign 08 §3.1; 15 §M-SEQ seq 8).
-- ADDITIVE ONLY; every column here is UNREAD while the IMPORT_V2_ENABLED dual gate is off:
--   • import_mapping_templates.visibility ('private'|'workspace', DEFAULT 'workspace' — existing rows keep
--     their current workspace-visible semantics, byte-identical). Private templates are the Data Loader
--     .sdl-per-user analog; named WORKSPACE templates are the documented market whitespace (03 §1.1 [21]);
--   • the 08 §5 strategy block ON the template: merge_mode / preserve_populated — both NULLABLE (NULL =
--     "template doesn't pin a strategy; inherit the import_policy workspace default"), so templates saved
--     before this migration never silently pin a strategy — plus options jsonb (countryHint, delimiter…,
--     same shape as import_jobs.options). A template stores the mapping PLUS this block; "Save these
--     settings as a template" copies both (the HubSpot use-as-template equivalent, first-class + named).
ALTER TABLE "import_mapping_templates" ADD COLUMN IF NOT EXISTS "visibility" varchar(10) DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_mapping_templates" ADD COLUMN IF NOT EXISTS "merge_mode" varchar(20);--> statement-breakpoint
ALTER TABLE "import_mapping_templates" ADD COLUMN IF NOT EXISTS "preserve_populated" boolean;--> statement-breakpoint
ALTER TABLE "import_mapping_templates" ADD COLUMN IF NOT EXISTS "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_mapping_templates" ADD CONSTRAINT "import_mapping_templates_visibility_enum" CHECK ("import_mapping_templates"."visibility" IN ('private','workspace'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_mapping_templates" ADD CONSTRAINT "import_mapping_templates_merge_mode_enum" CHECK ("import_mapping_templates"."merge_mode" IN ('create_and_update','create_only','update_only'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- DOWN (manual, per 15 §R-P1 — all additive; safe while the dual gate is off):
--   ALTER TABLE import_mapping_templates DROP CONSTRAINT IF EXISTS import_mapping_templates_merge_mode_enum;
--   ALTER TABLE import_mapping_templates DROP CONSTRAINT IF EXISTS import_mapping_templates_visibility_enum;
--   ALTER TABLE import_mapping_templates DROP COLUMN IF EXISTS options;
--   ALTER TABLE import_mapping_templates DROP COLUMN IF EXISTS preserve_populated;
--   ALTER TABLE import_mapping_templates DROP COLUMN IF EXISTS merge_mode;
--   ALTER TABLE import_mapping_templates DROP COLUMN IF EXISTS visibility;
