-- 0062_account_domains_dual_write_flag.sql — S-A2 gate seed (import-and-data-model-redesign 06 §1/§Rollout;
-- 15 §M-SEQ seq 54). SEED ONLY — nothing else ships in this migration (the 0059 channels-dual-write-flag
-- precedent): the per-tenant half of the S-A2 account-domain dual-write DUAL GATE, off/off (fail-closed).
-- Effective dual-write = the global `ACCOUNT_DOMAINS_DUAL_WRITE` env kill-switch (explicit-"true"-only) AND
-- this flag. While either half is off, every account writer keeps its shipped flat-column behavior
-- BYTE-IDENTICALLY (the T-P4 parity gate is the proof) and the 0061 `account_domains` child table stays
-- unwritten. §R-P4: flipping either half off at any point reverts writers to flat-only instantly; the flat
-- accounts.domain cache stays authoritative (reads never move until S-A6), and already-written child rows stay
-- INERT (nothing reads them until S-A6) and are never rolled back by a flag.
--
-- MINT NOTE (doc 16 drift row): 06 names NO dual-write flag — only the S-A6 read-cutover per-tenant gate. This
-- pair (env + `account_domains_dual_write`) is minted for S-A2, mirroring 0059's `channels_dual_write`, because
-- doc 15 §M-SEQ seq 54 mandates a dual-write step whose rollback is "writer revert; cache remains authoritative"
-- — which requires a runtime gate the writers can read.
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('account_domains_dual_write', 'Per-tenant rollout gate for the account-domain dual-write (import-and-data-model-redesign 06 §1; S-A2). OFF by default (fail-closed): while off every account writer keeps its shipped flat accounts.domain behavior byte-identical and the account_domains child table stays unwritten. Effective only when the global ACCOUNT_DOMAINS_DUAL_WRITE env kill-switch is also on; with both on, the import (and later enrichment/manual) account writers additionally maintain the child domain row + the flat accounts.domain primary cache via applyAccountDomainWrite in the same transaction. The flat accounts.domain cache remains the source of truth until S-A6. Also the S-A1/S-A3 backfill sweep tenant selector + batch-boundary abort.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P4 — safe while the dual gate is off):
--   DELETE FROM feature_flags WHERE key = 'account_domains_dual_write';
