-- 0071_seed_forge_voyager_parser.sql — SEED ONLY (the 0067/0069 flag-seed precedent). Registers the ONE built-in
-- voyager profile parser into forge.parsers + forge.parser_versions so forge.parsed_records.parser_version_id (a
-- uuid FK to forge.parser_versions) RESOLVES. P-01.1: the in-memory ParserRegistry previously wrote a string id
-- ("voyager-profile-1-0-0") into that uuid FK against an empty table, so every production parse upsert failed on
-- both a uuid cast and an FK violation. The uuids below MUST match VOYAGER_PROFILE_PARSER_ID /
-- VOYAGER_PROFILE_VERSION_ID in packages/forge-core/src/parsers/voyagerProfile.ts — the in-memory registry uses
-- the SAME version uuid, so the runtime write and this seeded row can never disagree. Idempotent (re-runnable);
-- this is the sole seeder of these rows, so ON CONFLICT keeps the fixed uuids consistent across re-runs.
INSERT INTO forge.parsers (id, source, endpoint)
VALUES ('a0000000-0000-4000-8000-000000000001', 'chrome_extension', 'voyager/identity/profiles')
ON CONFLICT (source, endpoint) DO NOTHING;
--> statement-breakpoint
INSERT INTO forge.parser_versions (id, parser_id, version, status, published_at)
VALUES ('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', '1-0-0', 'active', now())
ON CONFLICT (id) DO NOTHING;

-- DOWN (manual — safe while Forge is dark / nothing parsed):
--   DELETE FROM forge.parser_versions WHERE id = 'a0000000-0000-4000-8000-000000000002';
--   DELETE FROM forge.parsers         WHERE id = 'a0000000-0000-4000-8000-000000000001';
