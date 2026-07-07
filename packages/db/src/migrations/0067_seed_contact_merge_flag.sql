-- 0067_seed_contact_merge_flag.sql — S-C3 gate seed (import-and-data-model-redesign 04 §3.1; 15 §M-SEQ seq
-- 62). SEED ONLY — nothing else ships in this migration (the 0046/0048/0059 flag-seed precedent): the
-- per-tenant half of the contact TRUE-MERGE DUAL GATE, off by default (fail-closed). Effective merge =
-- the global `CONTACT_MERGE_ENABLED` env kill-switch (explicit-"true"-only, the name doc 04 pins) AND this
-- flag. While EITHER half is off the merge verb 404s (dark) and the engine is never constructed — flag-off is
-- byte-identical current behavior (nothing merges). Surfaces in the shipped feature-flag console (the flag
-- control plane is generic — seeding it here makes it appear + per-tenant-toggleable).
--
-- §R-P4: merge is IRREVERSIBLE — flipping this off halts NEW merges but NEVER rolls back executed ones (there
-- is no unmerge; the guardrail is the gate, not a reversal). PRECONDITIONS (04 §Rollout): 05's channel tables
-- live + backfill complete (type-aware demotion needs somewhere to demote to) + S-A5's account tombstone.
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('contact_merge_enabled', 'Per-tenant rollout gate for the contact TRUE-MERGE verb (import-and-data-model-redesign 04; S-C3/S-C4/S-C5/S-C9). OFF by default (fail-closed): while off the POST /contacts/:id/merge verb 404s, the merge engine is never constructed, and behavior is byte-identical to today (nothing merges). Effective only when the global CONTACT_MERGE_ENABLED env kill-switch is also on; with both on, the maker-confirmed customer verb and the Surface-1 staff wrapper call the same core merge engine (field union via planFieldWrite/planUserEdit, type-aware channel demotion, the full Class-A child re-point inventory, a loser tombstone, and the contact.merge audit event) inside one RLS-scoped withTenantTx. Merge is IRREVERSIBLE (no unmerge); this flag halts new merges, it never rolls back executed ones. Caps: 2 records per op, per-workspace daily cap.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P4 — safe while the dual gate is off / nothing merged):
--   DELETE FROM feature_flags WHERE key = 'contact_merge_enabled';
