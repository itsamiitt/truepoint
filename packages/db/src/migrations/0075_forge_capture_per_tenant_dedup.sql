-- 0075_forge_capture_per_tenant_dedup.sql — scope raw-capture dedup to the tenant (P-01.12). The original
-- uniq_raw_captures_content_hash was GLOBAL: tenant A landing a content_hash silently deduped tenant B's
-- identical capture, which (a) leaks cross-tenant existence (an oracle) and (b) lets A poison B by pre-claiming a
-- hash. Combined with the server-side hash recompute (P-01.11), scoping the unique to (target_tenant_id,
-- content_hash) closes both. HAND-AUTHORED (drizzle-kit generate is forbidden). Safe to drop/recreate: Forge is
-- dark (FORGE_CAPTURE_ENABLED off) so raw_captures holds no rows.
DROP INDEX IF EXISTS forge.uniq_raw_captures_content_hash;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raw_captures_tenant_content_hash
  ON forge.raw_captures (target_tenant_id, content_hash);

-- DOWN (manual — safe while Forge is dark):
--   DROP INDEX IF EXISTS forge.uniq_raw_captures_tenant_content_hash;
--   CREATE UNIQUE INDEX uniq_raw_captures_content_hash ON forge.raw_captures (content_hash);
