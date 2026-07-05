-- 0056_import_storage_params.sql — S-P5 (import-and-data-model-redesign 12 §6.2; 15 §M-SEQ seq 34).
-- STORAGE PARAMETERS ONLY — zero schema-shape change, zero behavior change, reversible via ALTER … RESET
-- (the §R-P2 lever). May ship any time from P1 (15 seq 34: "may ship any time"). Two halves:
--
--   • `import_jobs` fillfactor = 90 (12 §6.2): the job row is the HOTTEST row in the system during a run —
--     ≤ K (=2) chunk writers × ≤ 20 counter deltas per 10k chunk (09 §4.2; importProgress.ts pins the
--     cadence). The eight rows_* counters are NON-INDEXED columns, so with page headroom every delta is a
--     HOT update: within-page churn, no index-visible row versions (a 2M job's ~400 deltas would otherwise
--     write ~400 index entries on the hottest row). fillfactor applies to FUTURE page writes only — no
--     table rewrite is issued here; existing pages acquire headroom as they are naturally rewritten.
--     COROLLARY (12 §6.2, recorded in importJobs.ts): NEVER index a counter column — it forfeits HOT.
--
--   • Per-table autovacuum parameters on the four high-churn tables 12 §6.2 names: `import_job_rows`,
--     `source_imports`, `contact_emails`, `contact_phones`. The first two are append-only (insert-only
--     tables don't bloat from updates, but autovacuum must still run for the visibility map — index-only
--     scans — and to freeze); at the 100M-row horizon (12 §1.1 10x, A3) the default
--     autovacuum_vacuum_scale_factor = 0.2 means ~20M row changes before a vacuum — the visibility map
--     goes stale for exactly the index-backed reads 10 S-V1 priced. 12 §6.2 fixes the DIRECTION (lower
--     scale factors / absolute thresholds, "thresholds sized for burst" — 15 §Failure modes); the NUMBERS
--     are fixed HERE (drift-logged in 16): scale factors 0.2/0.1 → 0.01 (at 100M rows ⇒ vacuum/analyze
--     every ~1M changed rows instead of ~20M/~10M), plus an absolute insert threshold of 100 000 so a 2M
--     import burst triggers an insert-vacuum promptly (~at each ~1% growth or 100k inserted rows,
--     whichever the reltuples math reaches first) rather than after the next 20% of a 100M-row table.
--
-- `contact_emails` / `contact_phones` DO NOT EXIST YET (05 S-CH1, 16 subsystem row 🔲 — this program's
-- migrations may run before S-CH1's). Their ALTERs are guarded with to_regclass so this migration is
-- order-independent; ⚠ S-CH1'S OWN MIGRATION MUST (RE)STATE THESE PARAMETERS — on any database migrated
-- before S-CH1 lands, the guarded blocks below were no-ops (recorded as a 16 drift row so it cannot be
-- silently lost).
ALTER TABLE "import_jobs" SET (fillfactor = 90);--> statement-breakpoint
ALTER TABLE "import_job_rows" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 100000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 10000
);--> statement-breakpoint
ALTER TABLE "source_imports" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 100000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 10000
);--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.contact_emails') IS NOT NULL THEN
  EXECUTE 'ALTER TABLE contact_emails SET (
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_insert_scale_factor = 0.01,
    autovacuum_vacuum_insert_threshold = 100000,
    autovacuum_analyze_scale_factor = 0.01,
    autovacuum_analyze_threshold = 10000
  )';
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.contact_phones') IS NOT NULL THEN
  EXECUTE 'ALTER TABLE contact_phones SET (
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_insert_scale_factor = 0.01,
    autovacuum_vacuum_insert_threshold = 100000,
    autovacuum_analyze_scale_factor = 0.01,
    autovacuum_analyze_threshold = 10000
  )';
 END IF;
END $$;

-- DOWN (manual, per 15 §R-P2 — "S-P5 params RESET"; storage params only, safe at any time):
--   ALTER TABLE import_jobs RESET (fillfactor);
--   ALTER TABLE import_job_rows RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
--     autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold,
--     autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
--   ALTER TABLE source_imports RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
--     autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold,
--     autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
--   -- only if they exist (S-CH1):
--   ALTER TABLE contact_emails RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
--     autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold,
--     autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
--   ALTER TABLE contact_phones RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
--     autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold,
--     autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
