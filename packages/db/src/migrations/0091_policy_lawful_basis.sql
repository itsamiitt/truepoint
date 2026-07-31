-- 0091_policy_lawful_basis.sql — the configurable half of lawful-basis resolution (09-compliance rule 4:
-- "Every ingestion path tags a lawful basis; anything untaggable doesn't enter the graph"; human decision D6).
-- EXPAND ONLY, nullable, no backfill: NULL means "use the platform default", so every existing row keeps
-- behaving exactly as it does today and nothing reads these columns until the resolver ships.
--
-- WHY A COLUMN AND NOT A CONSTANT
-- provenance_event.lawful_basis is NOT NULL (0089), but before this nothing in the codebase derived one:
-- source_records.lawful_basis_snapshot is written NULL by its only writer, and ingestion.ts's consentContext
-- requires a basis for CAPTURE sources (extension, web form) while marking it optional for
-- admin_upload/enrichment/crm on the grounds that those "carry their basis elsewhere" — an elsewhere that did
-- not exist. This is that elsewhere. 09 asks for regional gating "behind config, not code forks", and a legal
-- basis hardcoded in TypeScript is exactly the code fork it warns about.
--
-- SCOPE: per WORKSPACE, not per tenant, because that is the grain both shipped policy objects already use and
-- the finer of the two — a tenant configures its workspaces. The vocabulary is the same four values as
-- consent_records and provenance_event; one lawful-basis vocabulary across the product, never a second.
--
-- KNOWN LIMIT, recorded rather than left to be discovered: this resolves basis by WORKSPACE, not by the data
-- subject's jurisdiction. contacts.jurisdiction and contacts.region exist and a per-jurisdiction resolver is
-- the correct end state (09 § Regional gating), but that belongs with the Phase 5 compliance work and its
-- counsel review. A workspace-level default is honest for a single-jurisdiction workspace and explicitly
-- insufficient for a multi-jurisdiction one — which is why the column is nullable and the default is the
-- conservative B2B business-contact basis rather than 'consent'.

ALTER TABLE import_policy
  ADD COLUMN IF NOT EXISTS lawful_basis varchar(30);
--> statement-breakpoint
ALTER TABLE import_policy
  DROP CONSTRAINT IF EXISTS import_policy_lawful_basis_enum;
--> statement-breakpoint
ALTER TABLE import_policy
  ADD CONSTRAINT import_policy_lawful_basis_enum CHECK (
    lawful_basis IS NULL OR lawful_basis IN ('legitimate_interest','consent','contract','public_record'));
--> statement-breakpoint

ALTER TABLE enrichment_policy
  ADD COLUMN IF NOT EXISTS lawful_basis varchar(30);
--> statement-breakpoint
ALTER TABLE enrichment_policy
  DROP CONSTRAINT IF EXISTS enrichment_policy_lawful_basis_enum;
--> statement-breakpoint
ALTER TABLE enrichment_policy
  ADD CONSTRAINT enrichment_policy_lawful_basis_enum CHECK (
    lawful_basis IS NULL OR lawful_basis IN ('legitimate_interest','consent','contract','public_record'));

-- DOWN (manual — safe while nothing reads the columns):
--   ALTER TABLE import_policy DROP COLUMN IF EXISTS lawful_basis;
--   ALTER TABLE enrichment_policy DROP COLUMN IF EXISTS lawful_basis;
