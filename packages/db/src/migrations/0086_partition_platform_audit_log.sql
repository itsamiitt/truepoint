-- 0086_partition_platform_audit_log.sql — convert `platform_audit_log` to monthly RANGE partitions (E-6.4).
--
-- The counterpart to rls/platform.sql, which now creates this table partitioned on a FRESH database. This
-- migration is for databases where it already exists unpartitioned. Migrations run BEFORE the rls/*.sql
-- files, so on a fresh database the table is simply absent here and this is a no-op — the two paths converge
-- on the same shape from either direction.
--
-- One `DO` block for the same reason as 0085: applyMigrations runs statements with autocommit, so a rebuild
-- split across statements could not roll back if it failed partway.
--
-- The append-only trigger and the deny-all RLS posture are NOT recreated here; rls/platform.sql re-establishes
-- both after the migrations on the same run. The trigger is row-level (BEFORE UPDATE OR DELETE), which
-- partitioned tables have supported since PG13.

DO $$
DECLARE
  copied bigint;
BEGIN
  -- Absent (fresh database) — rls/platform.sql creates it partitioned later in this same run.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'platform_audit_log' AND relnamespace = 'public'::regnamespace
  ) THEN
    RETURN;
  END IF;

  -- Already converted.
  IF (SELECT relkind FROM pg_class
       WHERE relname = 'platform_audit_log' AND relnamespace = 'public'::regnamespace) = 'p' THEN
    RETURN;
  END IF;

  ALTER TABLE platform_audit_log RENAME TO platform_audit_log_pre_partition;

  CREATE TABLE platform_audit_log (
    id uuid NOT NULL DEFAULT uuid_generate_v7(),
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    tenant_id uuid,
    workspace_id uuid,
    ip text,
    metadata jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, occurred_at)
  ) PARTITION BY RANGE (occurred_at);

  PERFORM ensure_month_partitions('platform_audit_log'::regclass, 3);
  CREATE TABLE platform_audit_log_default PARTITION OF platform_audit_log DEFAULT;

  INSERT INTO platform_audit_log (id, actor_user_id, action, target_type, target_id, tenant_id, workspace_id,
                                  ip, metadata, occurred_at)
       SELECT id, actor_user_id, action, target_type, target_id, tenant_id, workspace_id,
              ip, metadata, occurred_at
         FROM platform_audit_log_pre_partition;
  GET DIAGNOSTICS copied = ROW_COUNT;

  -- The old table still carries the append-only trigger, which raises on DELETE — including the implicit one
  -- a DROP does not perform, but the trigger would also block any future maintenance on it. Dropping the
  -- table outright is unaffected by a row trigger, and CASCADE takes its index with it.
  DROP TABLE platform_audit_log_pre_partition CASCADE;

  -- The customer-visible staff-access log read (list-plan/07 §5): WHERE tenant_id = $1 ORDER BY occurred_at
  -- DESC. Partial on tenant_id IS NOT NULL so it stays small — most platform actions are tenant-targeted.
  CREATE INDEX idx_platform_audit_tenant_time
    ON platform_audit_log (tenant_id, occurred_at DESC)
    WHERE tenant_id IS NOT NULL;

  RAISE NOTICE 'platform_audit_log partitioned by month (% rows copied)', copied;
END $$;
