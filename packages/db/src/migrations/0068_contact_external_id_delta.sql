-- 0068_contact_external_id_delta.sql — P5 DELTA / incremental imports substrate
-- (import-and-data-model-redesign 08 §9 "Incremental / delta" layer (3); 14 Phase 5 "external_id delta";
-- 15 §M-SEQ open P5 band / row 68+ "delta/`external_id` (additive unique, sketch 08 §9)").
--
-- ADDITIVE, DEAD-SCHEMA ONLY (07 §8: "Everything is additive; no column is renamed or dropped"). This is the
-- schema half of 08 §9's third delta layer: "an `external_id` upsert option (map a column as the caller's
-- stable key; needs a per-workspace `(workspace_id, external_id)` unique — schema sketch only, owned by a
-- future step in 14)". Nothing reads or writes `external_id` until the DELTA_IMPORTS dual gate is on AND a
-- caller maps an `externalId` column with the per-import `externalIdUpsert` option — three-way inert (env
-- kill-switch + per-tenant flag + the opt-in mapping), so a gate-off import is BYTE-IDENTICAL (the engine
-- never populates, matches, or writes the column). Layer (1) — the row-grain `content_hash` idempotent skip —
-- already shipped on `source_imports` (0-migration, `uniq_source_imports_ws_content`) and stays the internal
-- delta mechanism for re-imports (08 §9: "no platform exposes hashing as UX"); layer (2) upsert-on-declared-
-- key is S-I6's shipped merge triad. Only layer (3)'s column + unique are new here.
--
-- The `modified_since` filter (08 §9) is NOT a schema change: for the stored-object / scheduled re-import case
-- it is DELIVERED by the shipped `content_hash` skip (a row unchanged since a prior fire lands as `skipped`);
-- the timestamp-CURSOR variant is bound to CONNECTED sources, which are deferred (08 §9 / doc 16 P5 rows).
--
-- PARTIAL UNIQUE: mirrors the three shipped per-workspace dedup uniques (03 §5/§11 — uniq_contacts_ws_email /
-- _linkedin / _salesnav) exactly: unique only where the key is PRESENT and the row is LIVE, so a tombstoned
-- (DSAR-nulled, deleted_at set) contact never blocks a re-import re-using its external key. RLS is UNTOUCHED
-- (the column rides the existing contacts FORCE-RLS workspace wall; the unique is per-workspace by its leading
-- column). No down-migration risk: additive column + partial index only.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "external_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_ws_external_id" ON "contacts" USING btree ("workspace_id","external_id") WHERE "contacts"."external_id" IS NOT NULL AND "contacts"."deleted_at" IS NULL;--> statement-breakpoint

-- Per-tenant half of the P5 DELTA dual gate, off/off (fail-closed; the 0059/0060/0064 flag-seed precedent).
-- Effective external-id upsert = the global `DELTA_IMPORTS_ENABLED` env kill-switch (explicit-"true"-only)
-- AND this flag AND the per-import `externalIdUpsert` opt-in (a mapped `externalId` column). While ANY layer is
-- off, every import keeps its shipped email→linkedin→sales-nav ladder BYTE-IDENTICALLY and never touches
-- `external_id`. §R-P5: flipping any layer off reverts to the shipped ladder instantly; any external ids
-- already written stay INERT (the ladder never consults the column when the gate is off) and are never rolled
-- back by a flag.
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('delta_imports_enabled', 'Per-tenant rollout gate for P5 incremental/delta imports (import-and-data-model-redesign 08 §9). OFF by default (fail-closed): while off, imports keep the shipped dedup ladder and never read or write contacts.external_id. Effective only when the global DELTA_IMPORTS_ENABLED env kill-switch is also on AND the import maps an externalId column with the externalIdUpsert option; the external id then becomes the top dedup rung (upsert-on-external-id) and is stamped onto new contacts.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P5 — safe while the delta gate is off; additive schema is left in place):
--   DELETE FROM feature_flags WHERE key = 'delta_imports_enabled';
--   DROP INDEX IF EXISTS "uniq_contacts_ws_external_id";
--   ALTER TABLE "contacts" DROP COLUMN IF EXISTS "external_id";
