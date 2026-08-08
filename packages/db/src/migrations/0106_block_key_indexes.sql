-- 0106_block_key_indexes.sql — index the reserved ER blocking keys. This is the ONE schema change the
-- probabilistic tier of the identity-resolution ladder needs, and the columns were reserved at freeze
-- precisely so it could switch on without a destructive migration (masterGraph.ts "[RESERVED, leave
-- UNINDEXED]"). EXPAND ONLY: three indexes, no table or column touched.
--
-- WHY BLOCKING IS THE WHOLE PROBLEM (01-research.md R5)
-- Comparison count grows with the SQUARE of record count — Splink's own guidance notes that 1M records
-- implies ~500 BILLION pairwise comparisons, and that even after blocking the surviving comparison count is
-- typically 10x-1000x the input row count. The scoring arithmetic (Fellegi-Sunter m/u weights) is trivial;
-- generating candidate pairs is the expensive part, and that is a Postgres index problem, not a new service.
-- Hence: no Splink runtime, no Spark, no new infrastructure. Just this index and a bounded offline sweep.
--
-- ── WHY THIS MIGRATION IS HAND-AUTHORED AND NOT IN THE DRIZZLE SCHEMA ────────────────────────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and Drizzle emits plain CREATE INDEX for
-- anything declared in a schema file. Declaring these in masterGraph.ts / masterTechnology.ts would
-- therefore produce a blocking build. drizzle-kit `generate` diffs the schema against its own snapshot (not
-- the live database) and this repo never runs `push`, so an index created outside the schema is simply
-- invisible to it and will not be dropped — the same arrangement provenance_event's indexes already rely on.
--
-- ── CONCURRENTLY IS SAFE HERE, AND THAT IS NOT OBVIOUS — verify before copying this pattern ──────────────
-- This repo does NOT use Drizzle's migrator. applyMigrations.ts::applyJournalByHash splits each file on the
-- breakpoint marker (the "statement dash breakpoint" comment used between statements below) and runs the
-- statements one at a time via sql.unsafe() in AUTOCOMMIT (its own docstring: "statement by statement
-- (autocommit, hash row recorded LAST) so an interrupted run resumes convergently"). No enclosing
-- transaction means CONCURRENTLY is legal. Note migrate.ts still carries a comment about "Drizzle's migrator
-- opens a real DDL transaction" — that describes the pooler hazard, not this path, and it is why this was
-- checked rather than assumed.
--
-- ⚠ DO NOT WRITE THE MARKER VERBATIM ANYWHERE IN A MIGRATION, INCLUDING IN A COMMENT.
-- The splitter is a plain string split over the WHOLE file — it does not know what a comment is. The first
-- version of this header quoted the marker inside backticks to explain the mechanism, which split the file
-- at that point and left a fragment beginning with a backtick. Every itest in the repo then died on
-- `syntax error at or near "\`"` (42601) at THIS migration, because applyMigrations runs before all of them.
-- The comment explaining the splitting broke the splitting. Refer to the marker descriptively, never literally.
--
-- ── THE TRAP THIS GUARD EXISTS FOR ──────────────────────────────────────────────────────────────────────
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind (Postgres does not clean it up). On the
-- next deploy the retry would raise 42P07 duplicate_table — which is IN this migrator's ALREADY_EXISTS
-- tolerance set, so it would be logged as "tolerated: object already exists", the migration marked applied,
-- and the INVALID index left in place FOREVER: never used by the planner, still maintained on every write.
-- The tolerance set is right for genuine already-exists cases; it just cannot tell a valid index from a dead
-- one. So drop any invalid leftovers first, then use IF NOT EXISTS. The pair is fully convergent: after a
-- success the re-run is a silent no-op, after a failure the corpse is cleared and the build retried.

-- Clear invalid leftovers from any previously-interrupted CONCURRENTLY build of these three indexes.
-- Scoped by name so it can never touch an unrelated index. Safe on a fresh database (matches nothing).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND NOT i.indisvalid
       AND c.relname IN ('idx_master_persons_block_key',
                         'idx_master_companies_block_key',
                         'idx_master_technologies_block_key')
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
    RAISE NOTICE 'dropped invalid index %', r.relname;
  END LOOP;
END $$;
--> statement-breakpoint

-- Partial on IS NOT NULL: block_key is unpopulated until the ER sweep computes it, and an index over a
-- column that is mostly NULL wastes space and buys nothing. The sweep reads exactly the non-null rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_block_key
  ON master_persons (block_key)
  WHERE block_key IS NOT NULL;
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_block_key
  ON master_companies (block_key)
  WHERE block_key IS NOT NULL;
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_technologies_block_key
  ON master_technologies (block_key)
  WHERE block_key IS NOT NULL;

-- DOWN (manual):
--   DROP INDEX CONCURRENTLY IF EXISTS idx_master_technologies_block_key;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_master_companies_block_key;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_master_persons_block_key;
-- Dropping them disables the probabilistic ER tier; it does not affect the deterministic tier, which keys on
-- primary_domain / linkedin_public_id / the HMAC blind indexes and never reads block_key.
