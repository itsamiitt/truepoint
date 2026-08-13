-- 0110_worker_outbox_fks.sql — give worker_outbox the foreign keys its sibling outbox already declares
-- (audit 32 §9.4).
--
-- EXPAND ONLY: no column is added, dropped or retyped. Two constraints, plus the orphan cleanup that must
-- precede them.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────────────────────
-- event_outbox declares tenant_id and workspace_id as FKs with ON DELETE CASCADE. worker_outbox — the
-- transactional outbox of ADR-0027, holding publish-intent for real queue jobs — declares neither, and its
-- header gives no reason for the difference, so this is an omission rather than a decision.
--
-- The consequence is not theoretical. When a tenant is deleted, its worker_outbox rows survive, and the relay
-- (apps/workers/src/outboxRelay.ts) drains rows cross-tenant on the owner connection with no tenant predicate
-- to save it. It would publish queue jobs on behalf of a tenant that no longer exists. CASCADE makes the
-- outbox rows die with the tenant, which is the only correct behavior for publish-INTENT: the intent is void
-- once the thing it was published for is gone.
--
-- The audit filed this under "consolidate the three outbox tables". That merge is refused (see plan 32 §9B —
-- projection_outbox is a Layer-0 table with no tenant column at all, and folding it in would put a Layer-0
-- queue under tenant RLS). This constraint repair is the part of that finding that was real.
--
-- ── WHY NOT VALID, THEN VALIDATE ────────────────────────────────────────────────────────────────────────
-- A plain ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock for the whole verifying scan, which blocks the relay
-- and every producer for the duration. NOT VALID takes that lock only briefly and skips the scan; VALIDATE
-- then re-checks existing rows under a SHARE UPDATE EXCLUSIVE lock, which readers and writers do not block
-- on. The table is normally small — rows are drained continuously — so this is cheap either way, but the
-- two-step is free and stays correct if a relay outage has let a backlog build, which is precisely when a
-- migration is most likely to be run.
--
-- The DELETEs must come FIRST: a NOT VALID constraint still rejects new rows, and VALIDATE fails outright on
-- any surviving orphan. These rows are unpublishable in any case — the relay could only enqueue work scoped
-- to a tenant or workspace that no longer exists.
--
-- Idempotent throughout: the DELETEs are naturally so, and each ADD CONSTRAINT is guarded on pg_constraint so
-- a re-run (or a database already carrying the constraint) is a no-op rather than a duplicate-object error.

DELETE FROM worker_outbox wo
 WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = wo.tenant_id);
--> statement-breakpoint

DELETE FROM worker_outbox wo
 WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = wo.workspace_id);
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_outbox_tenant_id_fk') THEN
    ALTER TABLE worker_outbox
      ADD CONSTRAINT worker_outbox_tenant_id_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_outbox_workspace_id_fk') THEN
    ALTER TABLE worker_outbox
      ADD CONSTRAINT worker_outbox_workspace_id_fk
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE worker_outbox VALIDATE CONSTRAINT worker_outbox_tenant_id_fk;
--> statement-breakpoint

ALTER TABLE worker_outbox VALIDATE CONSTRAINT worker_outbox_workspace_id_fk;
--> statement-breakpoint

-- Clear invalid leftovers from any previously-interrupted build of the two indexes below. Same reasoning as
-- 0106/0109: a failed CONCURRENTLY build leaves an INVALID index that the IF NOT EXISTS below would skip past
-- forever — never used by the planner, still maintained on every write. Scoped by name, so it can never touch
-- an unrelated index; matches nothing on a fresh database.
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
       AND c.relname IN ('idx_worker_outbox_tenant', 'idx_worker_outbox_workspace')
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- The referencing side of a CASCADE needs its own index or the parent delete sequentially scans this table
-- once per constraint (audit 32 §9.3, the same class of defect 0109 repaired elsewhere). The existing
-- idx_worker_outbox_status leads with `status`, so it cannot serve either cascade. CONCURRENTLY is legal here
-- because applyMigrations.ts runs each statement in AUTOCOMMIT — see 0106's header before copying this.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_worker_outbox_tenant ON worker_outbox (tenant_id);
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_worker_outbox_workspace ON worker_outbox (workspace_id);
