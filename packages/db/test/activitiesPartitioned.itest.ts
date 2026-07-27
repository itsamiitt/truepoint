// activitiesPartitioned.itest.ts — that converting `activities` to monthly partitions (migration 0085) kept
// everything that was true of it before.
//
// A partitioning conversion is a table REBUILD: the old table is dropped and a new one takes its name. Every
// property that lived on the old table — the RLS policies, the grants, the statement-level trigger that
// maintains contacts.last_activity_at, the check constraints, the indexes — has to be re-established, and a
// missing one does not announce itself. Writes keep working; the tenant boundary or the cache just quietly
// stops holding.
//
// activity.itest.ts already proves the timeline reads and the trigger from the application side. This file
// covers the things only visible at the schema level, plus the two that are new: that rows land in the right
// month, and that a read filtered by time prunes to it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  dbHandle = await startItestDb();
  await applyMigrations(dbHandle.adminUrl);
  sql = postgres(dbHandle.adminUrl, { max: 1 });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await dbHandle.stop();
});

describe("activities after the partitioning conversion (0085)", () => {
  test("is a partitioned table with monthly partitions and a DEFAULT", async () => {
    const [rel] = await sql<{ relkind: string }[]>`
      SELECT relkind FROM pg_class WHERE relname = 'activities' AND relnamespace = 'public'::regnamespace
    `;
    expect(rel?.relkind).toBe("p");

    const parts = await sql<{ relname: string; isdefault: boolean }[]>`
      SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT' AS isdefault
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'activities'::regclass
    `;
    // The sweep's horizon (current month + 3) plus the catch-all.
    expect(parts.filter((p) => !p.isdefault).length).toBeGreaterThanOrEqual(4);
    expect(parts.some((p) => p.isdefault)).toBe(true);
  });

  test("the primary key is (id, occurred_at) — the partition key must be in it", async () => {
    const cols = await sql<{ attname: string }[]>`
      SELECT a.attname
        FROM pg_constraint con
        JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.conrelid = 'activities'::regclass AND con.contype = 'p'
       ORDER BY k.ord
    `;
    expect(cols.map((c) => c.attname)).toEqual(["id", "occurred_at"]);
  });

  test("RLS is still enabled and the indexes came back with their canonical names", async () => {
    // The rebuild drops the old table; if rls/activity.sql did not re-run, this is how a silently open
    // tenant boundary would look.
    const [rls] = await sql<{ relrowsecurity: boolean }[]>`
      SELECT relrowsecurity FROM pg_class WHERE oid = 'activities'::regclass
    `;
    expect(rls?.relrowsecurity).toBe(true);

    const [policies] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'activities'
    `;
    expect(policies?.n).toBeGreaterThan(0);

    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'activities' ORDER BY indexname
    `;
    const names = idx.map((i) => i.indexname);
    // Named, not just counted: the Home summary's aggregate depends on ws_occurred_type specifically, and a
    // rebuild that recreated only the timeline index would still pass a count check.
    expect(names).toContain("idx_activities_ws_contact_occurred");
    expect(names).toContain("idx_activities_ws_occurred_type");
  });

  test("the last_activity_at trigger survived the rebuild", async () => {
    // Statement-level with a transition table. It is the reason partitioning `activities` looked blocked, and
    // it is re-created by rls/activity.sql on a table that did not exist when that file was written.
    const [trg] = await sql<{ tgname: string; is_statement: boolean }[]>`
      SELECT tgname, NOT (tgtype::int & 1)::boolean AS is_statement
        FROM pg_trigger
       WHERE tgrelid = 'activities'::regclass AND NOT tgisinternal
    `;
    expect(trg?.tgname).toBe("activities_sync_last_activity");
    expect(trg?.is_statement).toBe(true);
  });

  test("the check constraints came back", async () => {
    const checks = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = 'activities'::regclass AND contype = 'c'
       ORDER BY conname
    `;
    const names = checks.map((c) => c.conname);
    expect(names).toContain("activities_type_enum");
    expect(names).toContain("activities_channel_enum");
    expect(names).toContain("activities_outcome_enum");
  });

  test("a row lands in the partition for its month, and a time-filtered read prunes to it", async () => {
    // Same fixture shape the other itests use (tenant → owner → workspace → contact).
    const slug = `part-${Date.now()}`;
    const [{ id: tenantId }] = await sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id
    `;
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id
    `;
    await sql`
      INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
      VALUES (${tenantId}, ${ownerId}, true)
    `;
    const [{ id: workspaceId }] = await sql<{ id: string }[]>`
      INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
      VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id
    `;
    const [{ id: contactId }] = await sql<{ id: string }[]>`
      INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name)
      VALUES (${tenantId}, ${workspaceId}, 'Ada', 'L') RETURNING id
    `;

    await sql`
      INSERT INTO activities (tenant_id, workspace_id, contact_id, activity_type, channel, occurred_at)
      VALUES (${tenantId}, ${workspaceId}, ${contactId}, 'note_added', 'email', now())
    `;

    // tableoid names the PARTITION the row physically lives in — the month, not the default catch-all.
    const [row] = await sql<{ part: string }[]>`
      SELECT tableoid::regclass::text AS part FROM activities WHERE contact_id = ${contactId}
    `;
    expect(row?.part).toMatch(/^activities_\d{4}_\d{2}$/);

    // And the cache trigger ran on the partitioned table, for real, through a normal insert.
    const [contact] = await sql<{ last_activity_at: Date | null }[]>`
      SELECT last_activity_at FROM contacts WHERE id = ${contactId}
    `;
    expect(contact?.last_activity_at).not.toBeNull();

    // Pruning: a plan for a single month must not mention every partition. This is the whole point of the
    // conversion — without it the read is the same full scan it always was, just spread over more tables.
    const plan = await sql<{ line: string }[]>`
      EXPLAIN SELECT count(*) FROM activities
       WHERE workspace_id = ${workspaceId}
         AND occurred_at >= date_trunc('month', now())
         AND occurred_at <  date_trunc('month', now()) + interval '1 month'
    `;
    const text = plan.map((p) => p.line ?? Object.values(p)[0]).join("\n");
    expect(text).not.toMatch(/activities_default/);
  });
});

describe("platform_audit_log after the partitioning conversion (0086)", () => {
  test("is partitioned, keeps its composite key, and still refuses mutation", async () => {
    const [rel] = await sql<{ relkind: string }[]>`
      SELECT relkind FROM pg_class
       WHERE relname = 'platform_audit_log' AND relnamespace = 'public'::regnamespace
    `;
    expect(rel?.relkind).toBe("p");

    const cols = await sql<{ attname: string }[]>`
      SELECT a.attname
        FROM pg_constraint con
        JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.conrelid = 'platform_audit_log'::regclass AND con.contype = 'p'
       ORDER BY k.ord
    `;
    expect(cols.map((c) => c.attname)).toEqual(["id", "occurred_at"]);

    // The append-only trigger (ADR-0032) is the property most easily lost in a rebuild, and losing it turns
    // an immutable audit trail into an editable one without anything failing.
    const [trg] = await sql<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'platform_audit_log'::regclass AND NOT tgisinternal
    `;
    expect(trg?.tgname).toBe("platform_audit_log_no_mutation");

    // RLS still ENABLED (not FORCED — the owner is the withPlatformTx writer) with no policy, which is what
    // denies leadwolf_app every row.
    const [rls] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'platform_audit_log'::regclass
    `;
    expect(rls?.relrowsecurity).toBe(true);
    expect(rls?.relforcerowsecurity).toBe(false);

    const [policies] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'platform_audit_log'
    `;
    expect(policies?.n).toBe(0);

    const [idx] = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'platform_audit_log' AND indexname = 'idx_platform_audit_tenant_time'
    `;
    expect(idx?.indexname).toBe("idx_platform_audit_tenant_time");
  });

  test("an audit row lands in its month and cannot then be updated or deleted", async () => {
    const [{ id: actorId }] = await sql<{ id: string }[]>`
      INSERT INTO users (email) VALUES (${`audit-${Date.now()}@t.test`}) RETURNING id
    `;
    await sql`
      INSERT INTO platform_audit_log (actor_user_id, action) VALUES (${actorId}, 'test.action')
    `;
    const [row] = await sql<{ part: string }[]>`
      SELECT tableoid::regclass::text AS part FROM platform_audit_log WHERE actor_user_id = ${actorId}
    `;
    expect(row?.part).toMatch(/^platform_audit_log_\d{4}_\d{2}$/);

    // Append-only holds through the partition, not just on the parent. Written as an explicit try/catch
    // rather than expect(...).rejects: a postgres.js tagged template is a lazy PendingQuery, and handing one
    // to `.rejects` risks leaving it unsettled on the single pooled connection — which then blocks the DROP
    // DATABASE in teardown rather than failing.
    const mutationError = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };

    expect(
      await mutationError(
        () =>
          sql`UPDATE platform_audit_log SET action = 'tampered' WHERE actor_user_id = ${actorId}`,
      ),
    ).toMatch(/append-only/i);
    expect(
      await mutationError(
        () => sql`DELETE FROM platform_audit_log WHERE actor_user_id = ${actorId}`,
      ),
    ).toMatch(/append-only/i);
  });
});
