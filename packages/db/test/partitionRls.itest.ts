// partitionRls.itest.ts — a partition must not be a way around its parent's RLS (0140).
//
// PostgreSQL applies the policies of the table NAMED IN THE QUERY, and `CREATE TABLE ... PARTITION OF` does
// not inherit `relrowsecurity`. So `SELECT ... FROM activities` was scoped while `SELECT ... FROM
// activities_2026_08` returned every tenant's rows to leadwolf_app, which holds table privileges on the
// partitions through the schema-wide grant.
//
// The first test here is the one that matters: it asks the question an attacker would, as the role an
// attacker would have, and it FAILED before 0140 — returning both tenants' rows. The catalog assertions after
// it are secondary; a catalog check alone would have passed the day someone enabled RLS on a parent and
// assumed the partitions followed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb | undefined;
let admin: postgres.Sql | undefined;
let app: postgres.Sql | undefined;

type Seeded = { tenantId: string; workspaceId: string; contactId: string };
const seeded: Record<"a" | "b", Seeded> = {} as Record<"a" | "b", Seeded>;
let partition = "";

async function seed(slug: string): Promise<Seeded> {
  const sql = admin as postgres.Sql;
  const [t] = await sql`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await sql`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await sql`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await sql`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  const workspaceId = (w as { id: string }).id;
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    return await tx`
      INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name)
      VALUES (${tenantId}, ${workspaceId}, ${slug}, 'contact') RETURNING id`;
  });
  return { tenantId, workspaceId, contactId: (rows[0] as { id: string }).id };
}

async function addActivity(who: Seeded, note: string): Promise<void> {
  const sql = admin as postgres.Sql;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_workspace_id', ${who.workspaceId}, true)`;
    await tx`
      INSERT INTO activities (tenant_id, workspace_id, contact_id, activity_type, channel, note, occurred_at)
      VALUES (${who.tenantId}, ${who.workspaceId}, ${who.contactId}, 'note_added', 'email', ${note}, now())`;
  });
}

beforeAll(async () => {
  dbHandle = await startItestDb("partition_rls");
  admin = postgres(dbHandle.adminUrl, { max: 1, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 1, onnotice: () => {} });
  seeded.a = await seed("prls-a");
  seeded.b = await seed("prls-b");
  await addActivity(seeded.a, "A-secret");
  await addActivity(seeded.b, "B-secret");
  // Whichever month the suite runs in — the partition holding "now", asked of the catalog rather than
  // computed from a date here. A hardcoded activities_2026_08 would start failing in September.
  const [row] = await (admin as postgres.Sql)<{ part: string }[]>`
    SELECT c.relname AS part
      FROM pg_class c
     WHERE c.oid = (SELECT tableoid FROM activities LIMIT 1)`;
  partition = (row as { part: string }).part;
}, 180_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("a partition is not a way around its parent's RLS", () => {
  test("naming the partition directly as leadwolf_app returns NO rows", async () => {
    const sql = app as postgres.Sql;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${seeded.a.workspaceId}, true)`;

      // Prove the role and the fixture first: an empty result means nothing if the query ran as the owner, or
      // if the rows were never there. Both would make the real assertion below pass vacuously.
      const [who] = await tx<{ u: string }[]>`SELECT session_user AS u`;
      expect((who as { u: string }).u).toBe("leadwolf_app");

      const viaParent = await tx<{ note: string }[]>`SELECT note FROM activities ORDER BY note`;
      expect(viaParent.map((r) => r.note)).toEqual(["A-secret"]);

      // The bypass. Before 0140 this returned ["A-secret", "B-secret"].
      const direct = (await tx.unsafe(`SELECT note FROM ${partition} ORDER BY note`)) as Array<{
        note: string;
      }>;
      expect(direct.map((r) => r.note)).toEqual([]);
    });
  });

  test("the parent still reads and WRITES normally through the app role", async () => {
    const sql = app as postgres.Sql;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${seeded.a.workspaceId}, true)`;
      await tx`
        INSERT INTO activities (tenant_id, workspace_id, contact_id, activity_type, channel, note, occurred_at)
        VALUES (${seeded.a.tenantId}, ${seeded.a.workspaceId}, ${seeded.a.contactId},
                'note_added', 'email', 'A-write', now())`;
      const rows = await tx<{ note: string }[]>`SELECT note FROM activities ORDER BY note`;
      expect(rows.map((r) => r.note)).toEqual(["A-secret", "A-write"]);
    });
  });

  test("every partition of an RLS-enabled parent has RLS enabled", async () => {
    const rows = await (admin as postgres.Sql)<{ ns: string; name: string; parent: string }[]>`
      SELECT child_ns.nspname AS ns, child.relname AS name, parent.relname AS parent
        FROM pg_inherits inh
        JOIN pg_class child ON child.oid = inh.inhrelid
        JOIN pg_class parent ON parent.oid = inh.inhparent
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
       WHERE parent.relkind = 'p' AND parent.relrowsecurity
         AND child.relkind = 'r' AND NOT child.relrowsecurity
       ORDER BY 1, 2`;
    expect(rows.map((r) => `${r.parent} -> ${r.name}`)).toEqual([]);
  });

  test("a partition created by the maintenance sweep is born with RLS", async () => {
    const sql = admin as postgres.Sql;
    // Far enough out that no existing partition covers it, so the function must actually create one.
    await sql`SELECT ensure_month_partitions('activities'::regclass, 9)`;
    const rows = await sql<{ name: string; rls: boolean }[]>`
      SELECT child.relname AS name, child.relrowsecurity AS rls
        FROM pg_inherits inh
        JOIN pg_class child ON child.oid = inh.inhrelid
        JOIN pg_class parent ON parent.oid = inh.inhparent
       WHERE parent.relname = 'activities' AND child.relkind = 'r'
       ORDER BY child.relname`;
    // The sweep is idempotent, so this asserts the state of every partition it left behind, not just new ones.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
  });
});
