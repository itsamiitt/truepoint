-- 0088_provenance_usage_flags.sql — Phase 1 spine gate seed (docs/strategy/08-architecture.md invariant 1;
-- 06-roadmap.md § Phase 1). SEED ONLY — nothing else ships in this migration (the 0046/0048/0054/0059
-- flag-seed precedent): the per-tenant halves of three DUAL GATES, all off/off (fail-closed).
--
-- Each flag is the tenant half; the global half is an explicit-"true"-only env kill-switch in
-- packages/config/src/env.ts (BULK_IMPORT_ENABLED posture — "false"/"0"/""/unset can never read truthy).
-- While EITHER half is off, every affected path keeps its shipped behavior BYTE-IDENTICALLY with zero flag
-- reads and zero writes to the new tables. Flipping a half off is the instant rollback lever; rows already
-- written stay INERT (nothing reads them) and are never rolled back by a flag.
--
-- ASYMMETRY WORTH READING TWICE: `provenance_events` gates OVERLAY events only (entity_type contact|account,
-- which carry a scope_ref = workspace_id). Layer-0 master_* events have NO tenant to key on — Layer 0 has no
-- tenant_id by design (rls/masterGraph.sql) — so they ride the env half ALONE. Same split as
-- INGESTION_EVIDENCE_ENABLED, which gates the ER evidence writers with no tenant flag at all.

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('provenance_events', 'Per-tenant rollout gate for the OVERLAY half of the provenance_event dual-write (08-architecture invariant 1; Phase 1 S-06). OFF by default (fail-closed): while off, contact/account writers keep their shipped field_provenance behavior byte-identically and append no events. Effective only when the global PROVENANCE_EVENTS_ENABLED env kill-switch is also on. Layer-0 master_* events are gated by the env half ALONE (Layer 0 has no tenant_id to key on). field_provenance stays authoritative throughout Phase 1 — the projection flip is a separate, CI-parity-gated step.', false, false) ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('usage_events', 'Per-tenant rollout gate for usage_event emission (08-architecture § Instrumentation; Phase 1 S-11). OFF by default (fail-closed): while off, no usage_event rows are written and every metered path behaves exactly as shipped. Effective only when the global USAGE_EVENTS_ENABLED env kill-switch is also on. usage_event is the OUTCOME-METRIC substrate; it never replaces credit_ledger, contact_reveals, provider_calls, ai_requests or activities, which keep metering billing independently.', false, false) ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('entitlements_enforced', 'Per-tenant gate for entitlement CAP ENFORCEMENT (06-roadmap Phase 1 "Free caps enforced"; S-10). OFF by default (fail-closed): while off, requireEntitlement runs in SHADOW mode — it computes and logs the decision it WOULD have made and never rejects a request (the AUTH_POLICY_SHADOW_ENABLED precedent). Effective enforcement = the global ENTITLEMENTS_ENABLED env kill-switch AND this flag. Entitlement caps sit ABOVE the reveal-credit ledger and do not replace it (decisions.md 2026-07-31 D2).', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual — safe while all three dual gates are off, since nothing reads the rows they gate):
--   DELETE FROM feature_flags WHERE key IN ('provenance_events','usage_events','entitlements_enforced');
