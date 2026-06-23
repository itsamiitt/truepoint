-- Performance migration (perf audit RC#4 + RC#9): index the hot read paths that currently seq-scan.
--   RC#4 — user_sessions.refresh_token_hash equality lookup (silent refresh, every cold app load).
--   RC#9 — dashboard fan-out reads: ORDER BY <time>/<score> DESC LIMIT N with no covering index.
--
-- SESSION PRUNING (RC#4, follow-up — NOT in this migration): user_sessions is append-only and never pruned,
-- so even the partial index below grows with revoked rows. A sessionRepository.deleteExpired (DELETE WHERE
-- revoked_at IS NOT NULL OR expires_at < now()) called daily by a worker is the follow-up; until then the
-- index is partial-on-live-rows so reads stay fast, only storage grows.
--
-- DEDUPE BEFORE THE UNIQUE INDEX: a plain CREATE UNIQUE INDEX aborts the migration if existing data already
-- has two live (revoked_at IS NULL) rows sharing one refresh_token_hash — possible from a historical
-- concurrent-refresh race. Revoke all but the newest live duplicate per hash first so the build always
-- succeeds. This is exactly what reuse-detection would do (keep the latest session, revoke the rest) and is
-- a no-op on clean data. Runs in the same migration transaction as the index build below.
UPDATE "user_sessions" s SET "revoked_at" = now()
  WHERE s."revoked_at" IS NULL
    AND s."refresh_token_hash" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "user_sessions" o
      WHERE o."refresh_token_hash" = s."refresh_token_hash"
        AND o."revoked_at" IS NULL
        AND (o."created_at" > s."created_at"
             OR (o."created_at" = s."created_at" AND o."id" > s."id"))
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_sessions_refresh_token_hash" ON "user_sessions" USING btree ("refresh_token_hash") WHERE "user_sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_ws_priority_score" ON "contacts" USING btree ("workspace_id","priority_score" DESC NULLS LAST) WHERE "contacts"."deleted_at" IS NULL AND "contacts"."priority_score" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_imports_ws_imported_at" ON "source_imports" USING btree ("workspace_id","imported_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_tenant_occurred_at" ON "audit_log" USING btree ("tenant_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_tenant_auth_occurred_at" ON "audit_log" USING btree ("tenant_id","occurred_at" DESC NULLS LAST) WHERE "audit_log"."action" IN (
          'login.success','login.failure','login.locked','mfa.challenge','mfa.success','mfa.failure',
          'password.reset.request','password.reset.complete','sso.initiated','sso.callback',
          'token.issued','token.refresh','token.revoke','device.trusted','device.revoked','session.revoked',
          'code.issued','code.exchanged','signup','oauth.link'
        );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_reveals_ws_revealed_at" ON "contact_reveals" USING btree ("workspace_id","revealed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_calls_ws_called_at" ON "provider_calls" USING btree ("workspace_id","called_at" DESC NULLS LAST);