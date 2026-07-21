-- 0060_channels_read_flag.sql — S-CH4 gate seed (import-and-data-model-redesign 05 §Implementation Steps /
-- §Rollout; 15 §M-SEQ Phase 3). SEED ONLY — nothing else ships in this migration (the 0059 precedent): the
-- per-tenant half of the S-CH4 channel READ-CUTOVER gate, off/off (fail-closed). Effective read-from-child =
-- the global `CHANNEL_READ_FROM_CHILD` env kill-switch (explicit-"true"-only, THE NAME DOC 05's S-CH4 row
-- pins) AND this flag AND the full S-CH2 dual-write gate (CHANNEL_DUAL_WRITE env + `channels_dual_write`
-- flag) — the read gate IMPLIES the dual-write gate (05 §5 ordering: cutover only atop a maintained cache),
-- fail-closed if dual-write is off. While ANY layer is off, every read surface (masked list/search
-- projection + channel summaries, the dedup email rung, reveal reads, the revealed export) keeps its shipped
-- flat-column behavior BYTE-IDENTICALLY and the child tables stay unread. §R-P3: flipping any layer off at
-- any point returns reads to the flat primary cache instantly (still dual-write-maintained) — secondaries
-- merely go invisible again, nothing is lost. FLIP PRECONDITIONS (05 §Rollout / 15): T-P3 green in CI +
-- backfill completeness = 0 (countContactsMissingChannelProjection) + drift = 0.
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('channels_read', 'Per-tenant rollout gate for the multi-value channel READ CUTOVER (import-and-data-model-redesign 05; S-CH4). OFF by default (fail-closed): while off every contact read keeps its shipped flat-column behavior byte-identical — masked list/search projections, has_email/has_phone/email_domain facets, the dedup email rung, reveal reads and the revealed export all resolve from the flat primary cache and the contact_emails/contact_phones child tables stay unread. Effective only when the global CHANNEL_READ_FROM_CHILD env kill-switch AND the full S-CH2 dual-write gate (CHANNEL_DUAL_WRITE env + channels_dual_write flag) are also on — read implies dual-write. With all four on, the child tables become the read truth: masked reads gain per-value channel summaries (counts + type/status/lineType/isPrimary — never values), secondaries count toward has_email/has_phone and dedup, and reveal/export read primary-first from the child rows. Flip only after backfill completeness = 0 and drift = 0.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P3 — safe while the read gate is off):
--   DELETE FROM feature_flags WHERE key = 'channels_read';
