-- 0059_channels_dual_write_flag.sql — S-CH2 gate seed (import-and-data-model-redesign 05 §Implementation
-- Steps / §Rollout; 15 §M-SEQ seq 45). SEED ONLY — nothing else ships in this migration (the 0046/0048/0054
-- flag-seed precedent): the per-tenant half of the S-CH2 channel dual-write DUAL GATE, off/off (fail-closed).
-- Effective dual-write = the global `CHANNEL_DUAL_WRITE` env kill-switch (explicit-"true"-only, the name doc
-- 05 pins) AND this flag. While either half is off, every writer keeps its shipped flat-column behavior
-- BYTE-IDENTICALLY (T-CH parity is the proof) and the 0058 child tables stay unwritten. §R-P3: flipping
-- either half off at any point reverts writers to flat-only instantly; already-written child rows stay
-- INERT (nothing reads them until S-CH4) and are never rolled back by a flag.
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('channels_dual_write', 'Per-tenant rollout gate for the multi-value channel dual-write (import-and-data-model-redesign 05; S-CH2). OFF by default (fail-closed): while off, writers keep the shipped flat-column behavior and the contact_emails/contact_phones child tables stay unwritten. Effective only when the global CHANNEL_DUAL_WRITE env kill-switch is also on; with both on, writers also maintain child rows via applyChannelWrite in the same transaction (CH-INV-1). Flat columns stay the read truth until S-CH4.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P3 — safe while the dual gate is off):
--   DELETE FROM feature_flags WHERE key = 'channels_dual_write';
