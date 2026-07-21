-- 0069_seed_api_imports_flag.sql — P5 API-PUSH gate seed (import-and-data-model-redesign 08 §9 "API-push
-- imports"). SEED ONLY — nothing else ships in this migration (the 0046/0048/0059/0067/0068 flag-seed
-- precedent): the per-tenant half of the API-PUSH DUAL GATE, off by default (fail-closed). Effective push =
-- the global `API_IMPORTS_ENABLED` env kill-switch (explicit-"true"-only, the name env.ts pins) AND this flag.
-- While EITHER half is off the `POST /imports/rows` verb 404s (dark, strict-from-birth — no existence oracle),
-- the JSON push pipeline is never constructed, and every other import surface is byte-identical to today (a NEW
-- additive route). Surfaces in the shipped feature-flag console (the flag control plane is generic — seeding it
-- here makes it appear + per-tenant-toggleable).
--
-- 08 §9 pins that PUBLIC-API PACKAGING (key minting, scopes, developer docs) is doc-14 future; this ships the
-- body/limits/idempotency CONTRACT only, riding the existing session-authed import surface (no api_key infra
-- exists on disk — the key auth swaps in when doc 14 mints it, the contract is unchanged). Flipping this off at
-- any point halts NEW pushes; executed imports keep their durable rows (data is never rolled back by a flag).
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('api_imports_enabled', 'Per-tenant rollout gate for API-PUSH imports (import-and-data-model-redesign 08 §9). OFF by default (fail-closed): while off the POST /imports/rows verb 404s, the JSON push pipeline is never constructed, and behavior is byte-identical to today (a NEW additive route — every other import surface unchanged). Effective only when the global API_IMPORTS_ENABLED env kill-switch is also on; with both on, a caller may submit already-structured canonical contact rows as JSON (no multipart file) onto the SAME fast-lane durable import_jobs pipeline the one-shot multipart POST uses, with an Idempotency-Key REQUIRED (programmatic). Body-carried rows ONLY — no remote-URL/connected-source fetch (13 §7/§8 SSRF forward-guard; deferred). Caps: rows per push bounded by the fast-path row ceiling (env BULK_IMPORT_THRESHOLD_ROWS); over that ⇒ honest 413 (no stored object exists to route to copy mode). Public-API key packaging/scopes/docs are doc-14 future — this ships the contract on the existing session-authed surface.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual — safe while the dual gate is off / nothing pushed):
--   DELETE FROM feature_flags WHERE key = 'api_imports_enabled';
