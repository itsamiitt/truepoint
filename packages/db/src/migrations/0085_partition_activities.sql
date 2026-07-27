-- 0085_partition_activities.sql — convert `activities` to monthly RANGE partitions on occurred_at (E-6.4).
--
-- Done NOW, deliberately, while the table is small: the data-platform skill's own mandate is to partition the
-- append-heavy logs "before they reach billions of rows; repartitioning a huge live table is painful". The
-- cost of this conversion is proportional to the current row count, and it only ever grows.
--
-- ONE `DO` block, on purpose. applyMigrations runs each statement-breakpoint-separated statement on its own
-- (autocommit), so a multi-statement conversion that failed halfway would leave the table renamed away, or
-- copied but not swapped — with no rollback. A DO block is a single statement and therefore atomic: the whole
-- conversion commits or none of it does.
--
-- Prerequisites already in place: `ensure_month_partitions` (0084) and the daily partition_sweep that calls
-- it, because a partitioned table whose next month does not exist stops accepting writes on the 1st.
-- A DEFAULT partition is created as well — belt and braces. If the sweep ever stops, rows land there instead
-- of erroring; the cost is that attaching a future partition then has to scan it, which is a far better
-- failure mode than refusing writes.
--
-- What is NOT recreated here: RLS policies, grants, and the last_activity_at trigger. applyMigrations runs
-- every rls/*.sql AFTER the migrations on every boot, so rls/activity.sql re-establishes all three. The
-- trigger is the interesting one — it is statement-level with a transition table (REFERENCING NEW TABLE), and
-- partitioningFeasibility.itest.ts proves PG16 accepts that on a partitioned table.
--
-- Not partitioned, with reasons, so the next reader does not retry them:
--   • provider_calls  — UNIQUE (workspace_id, request_hash) IS the provider-response cache dedup. Partitioning
--                       forces called_at into it, which turns "one persisted answer per request" into "one per
--                       timestamp" — i.e. re-billing the provider on every miss. Needs the dedup moved first.
--   • email_event     — partial UNIQUE (provider_event_id) is the webhook ingestion idempotency key. Same
--                       problem, worse blast radius: duplicate events corrupt open/click/bounce analytics and
--                       can re-trigger reply auto-pause.
--   • source_imports,
--     credit_ledger   — inbound FKs. The composite key propagates into four referencing tables, one of them a
--                       financial ledger's integrity constraint.

DO $$
DECLARE
  copied bigint;
BEGIN
  -- Idempotent: a re-run against an already-converted database is a no-op rather than an error.
  IF (SELECT relkind FROM pg_class WHERE relname = 'activities' AND relnamespace = 'public'::regnamespace) = 'p' THEN
    RAISE NOTICE 'activities is already partitioned — nothing to do';
    RETURN;
  END IF;

  -- The OLD table steps aside first so the new one can take the canonical name immediately. That ordering
  -- matters more than it looks: partitions are named after their parent at creation time, so building under a
  -- temporary name and renaming afterwards would leave every partition called activities_partitioned_YYYY_MM
  -- while the sweep went on creating activities_YYYY_MM beside them.
  ALTER TABLE activities RENAME TO activities_pre_partition;

  -- The primary key gains occurred_at because a partitioned table's unique constraints must include the
  -- partition key. Nothing depends on `id` alone being unique (no inbound foreign keys — verified), so this is
  -- a widening, not a semantic change.
  CREATE TABLE activities (
    id uuid NOT NULL DEFAULT uuid_generate_v7(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES users(id),
    activity_type varchar(30) NOT NULL,
    channel varchar(20) NOT NULL,
    outcome varchar(20),
    note varchar(2000),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, occurred_at),
    CONSTRAINT activities_type_enum CHECK (activity_type IN ('email_sent','email_opened','email_clicked',
      'email_replied','call_made','call_connected','linkedin_message','linkedin_connected','sales_nav_inmail',
      'meeting_held','note_added')),
    CONSTRAINT activities_channel_enum CHECK (channel IN ('email','phone','linkedin','sales_navigator','in-person')),
    CONSTRAINT activities_outcome_enum CHECK (outcome IS NULL OR outcome IN ('connected','voicemail','no_answer',
      'positive','negative','neutral'))
  ) PARTITION BY RANGE (occurred_at);

  -- Months FIRST, then the catch-all, and BOTH before the copy. Rows must land in their real month where one
  -- exists: anything sitting in the DEFAULT partition blocks a later CREATE ... PARTITION OF for that month
  -- outright, because the new partition's constraint would be violated by the rows already there.
  -- Rows OLDER than the current month land in the default by design — the sweep only ever creates the current
  -- month and forward, so no future CREATE can collide with them.
  PERFORM ensure_month_partitions('activities'::regclass, 3);
  CREATE TABLE activities_default PARTITION OF activities DEFAULT;

  INSERT INTO activities (id, tenant_id, workspace_id, contact_id, actor_user_id, activity_type,
                          channel, outcome, note, metadata, occurred_at)
       SELECT id, tenant_id, workspace_id, contact_id, actor_user_id, activity_type,
              channel, outcome, note, metadata, occurred_at
         FROM activities_pre_partition;
  GET DIAGNOSTICS copied = ROW_COUNT;

  -- CASCADE takes the old table's indexes and its last_activity_at trigger with it. Dropping BEFORE the index
  -- creation below is what frees the canonical index names; rls/activity.sql recreates the trigger on the new
  -- table later in this same applyMigrations run.
  DROP TABLE activities_pre_partition CASCADE;

  -- The timeline read (newest-first per contact within a workspace) and the workspace-wide recency aggregate
  -- Home's summary runs on every load (migration 0080). Created on the parent, so they propagate to every
  -- partition, existing and future.
  CREATE INDEX idx_activities_ws_contact_occurred
    ON activities (workspace_id, contact_id, occurred_at DESC NULLS LAST);
  CREATE INDEX idx_activities_ws_occurred_type
    ON activities (workspace_id, occurred_at DESC, activity_type);

  RAISE NOTICE 'activities partitioned by month (% rows copied)', copied;
END $$;
