// crmIsolation.itest.ts — the MANDATORY cross-tenant/workspace isolation proof for the nine CRM-sync tables
// (crm-sync 00 §4/§7.1, 01 Block B; the truepoint-platform tenancy mandate and truepoint-security
// access-control mandate). On a real Postgres 16 (Testcontainers by default, or an external server via
// ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/crmIsolation.itest.ts
//
// The formalization checklist in 01 §5 names these tests as part of wiring rls/crm.sql — this is that.
// All nine tables are workspace-scoped Layer-1 overlay under ENABLE + FORCE RLS, so this proves, for the
// non-BYPASSRLS leadwolf_app role:
//   (1) READ — the wrong workspace GUC sees ZERO rows of the other workspace; the right GUC sees its own.
//   (2) FAIL-CLOSED — with NO GUC set at all, every table reads zero (the NULLIF(...,'') half of the policy).
//       This is the half that a policy written as `current_setting(...) = workspace_id` would silently fail.
//   (3) WRITE — WITH CHECK blocks stamping a row into another workspace, on every table.
//   (4) APPEND-ONLY — crm_inbound_events and crm_sync_dead_letter have SELECT+INSERT policies only, so an
//       UPDATE or DELETE mutates NOTHING even in the row's own workspace, and even though the [4/4] blanket
//       GRANT re-widens leadwolf_app afterwards. That grant is exactly why this must be asserted: the wall
//       is policy-absence, not the grant.
//   (5) LEDGER — crm_sync_runs additionally permits INSERT and UPDATE (running -> completed) but no DELETE.
//   (6) The encrypted token bytea never crosses a workspace boundary.
//
// TWO ASSERTION SHAPES, and picking the wrong one is the trap. A cross-workspace INSERT RAISES (a WITH CHECK
// violation is an error), so it is asserted with explicit try/catch. An UPDATE/DELETE with no policy does
// NOT raise — RLS applies the empty policy set as a row filter, so the statement matches zero rows and
// returns success. Those are asserted as "RETURNING came back empty and the data is provably unchanged",
// read on the OWNER connection. CI caught this: the first version of this file asserted that the
// append-only UPDATE threw, and five tests failed against a policy set that was entirely correct.
//
// Never `expect(sql`...`).rejects` on a tagged template either: a postgres.js PendingQuery is lazy, and one
// left unsettled holds a connection open and hangs the DROP DATABASE in teardown (that cost a 28-minute CI
// timeout once already). Hence the explicit try/catch everywhere a raise IS expected.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, one, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

interface Seeded {
  tenantId: string;
  wsId: string;
  ownerId: string;
  connectionId: string;
  contactId: string;
  runId: string;
  linkId: string;
}

let A: Seeded;
let B: Seeded;

async function seedTenant(slug: string, provider: string): Promise<Seeded> {
  const t = one<{ id: string }>(
    await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`,
    "tenant",
  );
  const u = one<{ id: string }>(
    await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`,
    "user",
  );
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${t.id}, ${u.id}, true)`;
  const w = one<{ id: string }>(
    await admin`
      INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
      VALUES (${t.id}, ${slug}, ${slug}, true, ${u.id}) RETURNING id`,
    "workspace",
  );

  // The connection carries the encrypted-bundle canary: a cross-workspace read must surface none of it.
  const conn = one<{ id: string }>(
    await admin`
      INSERT INTO crm_connections
        (tenant_id, workspace_id, owner_user_id, provider, status, sync_mode, external_account_id,
         oauth_token_enc)
      VALUES (${t.id}, ${w.id}, ${u.id}, ${provider}, 'connected', 'shadow', ${`acct-${slug}`},
              '\\xdeadbeef'::bytea)
      RETURNING id`,
    "crm_connection",
  );

  const contact = one<{ id: string }>(
    await admin`
      INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name)
      VALUES (${t.id}, ${w.id}, 'Dana', ${slug}) RETURNING id`,
    "contact",
  );

  const link = one<{ id: string }>(
    await admin`
      INSERT INTO crm_record_links
        (tenant_id, workspace_id, connection_id, tp_entity_type, contact_id, crm_object_type, crm_record_id)
      VALUES (${t.id}, ${w.id}, ${conn.id}, 'contact', ${contact.id}, 'Contact', ${`rec-${slug}`})
      RETURNING id`,
    "crm_record_link",
  );

  await admin`
    INSERT INTO crm_field_mappings
      (tenant_id, workspace_id, connection_id, object_type, tp_field, crm_field)
    VALUES (${t.id}, ${w.id}, ${conn.id}, 'contact', 'jobTitle', 'Title')`;

  await admin`
    INSERT INTO crm_sync_state (tenant_id, workspace_id, connection_id, object_type, direction)
    VALUES (${t.id}, ${w.id}, ${conn.id}, 'contact', 'inbound')`;

  await admin`
    INSERT INTO crm_inbound_events
      (tenant_id, workspace_id, connection_id, provider, object_type, crm_object_type, crm_record_id,
       provider_event_id)
    VALUES (${t.id}, ${w.id}, ${conn.id}, ${provider}, 'contact', 'Contact', ${`rec-${slug}`},
            ${`evt-${slug}`})`;

  const run = one<{ id: string }>(
    await admin`
      INSERT INTO crm_sync_runs
        (tenant_id, workspace_id, connection_id, provider, object_type, direction, trigger, mode)
      VALUES (${t.id}, ${w.id}, ${conn.id}, ${provider}, 'contact', 'inbound', 'scheduled', 'shadow')
      RETURNING id`,
    "crm_sync_run",
  );

  await admin`
    INSERT INTO crm_sync_conflicts
      (tenant_id, workspace_id, connection_id, record_link_id, object_type, field)
    VALUES (${t.id}, ${w.id}, ${conn.id}, ${link.id}, 'contact', 'jobTitle')`;

  await admin`
    INSERT INTO crm_sync_dead_letter
      (tenant_id, workspace_id, connection_id, run_id, queue, error_class)
    VALUES (${t.id}, ${w.id}, ${conn.id}, ${run.id}, 'crm-sync-pull', 'provider_5xx')`;

  await admin`
    INSERT INTO crm_oauth_states
      (tenant_id, workspace_id, owner_user_id, provider, state, expires_at)
    VALUES (${t.id}, ${w.id}, ${u.id}, ${provider}, ${`state-${slug}`}, now() + interval '10 minutes')`;

  return {
    tenantId: t.id,
    wsId: w.id,
    ownerId: u.id,
    connectionId: conn.id,
    contactId: contact.id,
    runId: run.id,
    linkId: link.id,
  };
}

beforeAll(async () => {
  dbHandle = await startItestDb("crmIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");

  A = await seedTenant("acme", "salesforce");
  B = await seedTenant("globex", "hubspot");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

/** Count rows of `table` belonging to workspace A, as leadwolf_app under the given workspace GUC. */
async function countAsWorkspace(
  table: string,
  wsGuc: string | null,
  wsOfRows: string,
): Promise<number> {
  return app.begin(async (tx) => {
    if (wsGuc !== null) await tx`SELECT set_config('app.current_workspace_id', ${wsGuc}, true)`;
    // The table name is a fixed literal from ALL_TABLES below, never user input — postgres.js parameters
    // cannot carry an identifier, so it is interpolated via the unsafe helper on a closed allow-list.
    const rows = await tx.unsafe(
      `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`,
      [wsOfRows],
    );
    return one<{ n: number }>(rows as unknown as Array<{ n: number }>, "count").n;
  });
}

/**
 * Ground truth for a table's row count in a workspace, read on the OWNER connection.
 *
 * Deliberately not the app connection: the append-only assertions need to know what is REALLY in the table,
 * and reading that through the same RLS wall being tested would make the test agree with itself.
 */
async function countRows(table: string, wsId: string): Promise<number> {
  const rows = await admin.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`,
    [wsId],
  );
  return one<{ n: number }>(rows as unknown as Array<{ n: number }>, "count").n;
}

// All nine tables are workspace-scoped. This list is the allow-list for the identifier interpolation above.
const ALL_TABLES = [
  "crm_connections",
  "crm_record_links",
  "crm_field_mappings",
  "crm_sync_state",
  "crm_inbound_events",
  "crm_sync_runs",
  "crm_sync_conflicts",
  "crm_sync_dead_letter",
  "crm_oauth_states",
] as const;

describe("CRM sync — cross-workspace isolation (all nine tables)", () => {
  for (const table of ALL_TABLES) {
    test(`${table}: wrong workspace GUC sees zero, right GUC sees its own`, async () => {
      expect(await countAsWorkspace(table, B.wsId, A.wsId)).toBe(0);
      expect(await countAsWorkspace(table, A.wsId, A.wsId)).toBeGreaterThan(0);
    });

    // The fail-closed half. A policy written without NULLIF would compare against '' and error — or worse,
    // a policy written as `current_setting(...) IS NULL OR ...` would return EVERYTHING here.
    test(`${table}: NO workspace GUC set reads zero (fail-closed via NULLIF)`, async () => {
      expect(await countAsWorkspace(table, null, A.wsId)).toBe(0);
    });
  }
});

describe("CRM sync — WITH CHECK blocks cross-workspace writes", () => {
  test("crm_connections: workspace B cannot stamp a connection into workspace A", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${B.wsId}, true)`;
        await tx`
          INSERT INTO crm_connections (tenant_id, workspace_id, provider, external_account_id)
          VALUES (${A.tenantId}, ${A.wsId}, 'salesforce', 'evil-cross-account')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    const r = one<{ n: number }>(
      await admin`
        SELECT count(*)::int AS n FROM crm_connections WHERE external_account_id = 'evil-cross-account'`,
      "count",
    );
    expect(r.n).toBe(0);
  });

  test("crm_record_links: workspace B cannot link one of workspace A's contacts", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${B.wsId}, true)`;
        await tx`
          INSERT INTO crm_record_links
            (tenant_id, workspace_id, connection_id, tp_entity_type, contact_id, crm_object_type,
             crm_record_id)
          VALUES (${A.tenantId}, ${A.wsId}, ${A.connectionId}, 'contact', ${A.contactId}, 'Contact',
                  'evil-cross-record')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    const r = one<{ n: number }>(
      await admin`
        SELECT count(*)::int AS n FROM crm_record_links WHERE crm_record_id = 'evil-cross-record'`,
      "count",
    );
    expect(r.n).toBe(0);
  });

  test("crm_inbound_events: workspace B cannot append an event into workspace A", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${B.wsId}, true)`;
        await tx`
          INSERT INTO crm_inbound_events
            (tenant_id, workspace_id, connection_id, provider, object_type, crm_object_type, crm_record_id,
             provider_event_id)
          VALUES (${A.tenantId}, ${A.wsId}, ${A.connectionId}, 'salesforce', 'contact', 'Contact', 'x',
                  'evil-cross-event')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    const r = one<{ n: number }>(
      await admin`
        SELECT count(*)::int AS n FROM crm_inbound_events WHERE provider_event_id = 'evil-cross-event'`,
      "count",
    );
    expect(r.n).toBe(0);
  });
});

describe("CRM sync — append-only tables cannot be mutated by leadwolf_app", () => {
  // These two have SELECT + INSERT policies ONLY. Under FORCE RLS the absence of an UPDATE/DELETE policy is
  // the wall — and it has to be, because applyMigrations' [4/4] blanket GRANT hands leadwolf_app full DML on
  // every table AFTER rls/crm.sql runs. A test that only checked the GRANT would prove nothing.
  //
  // HOW THE DENIAL MANIFESTS — this is the part worth stating, because the obvious test is wrong. An absent
  // UPDATE/DELETE policy does NOT raise: RLS applies the (empty) set of policies as a row filter, so the
  // statement matches ZERO rows and returns success. Only INSERT fails loudly, because a WITH CHECK
  // violation is an error rather than a filter. So the assertion is "affected nothing and the data is
  // unchanged", not "threw" — the same shape retention.itest.ts uses for retention_runs. Anything that
  // treats "the UPDATE didn't throw" as "the UPDATE worked" is wrong on these tables.
  for (const table of ["crm_inbound_events", "crm_sync_dead_letter"] as const) {
    test(`${table}: UPDATE in its OWN workspace affects zero rows and changes nothing`, async () => {
      const before = await countRows(table, A.wsId);
      expect(before).toBeGreaterThan(0); // the fixture exists, so zero-affected below is meaningful

      const affected = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${A.wsId}, true)`;
        const rows = await tx.unsafe(
          `UPDATE ${table} SET crm_record_id = 'mutated-by-app' WHERE workspace_id = $1 RETURNING id`,
          [A.wsId],
        );
        return (rows as unknown as unknown[]).length;
      });
      expect(affected).toBe(0);

      // Confirmed on the owner connection: no row took the new value.
      const mutated = await admin.unsafe(
        `SELECT count(*)::int AS n FROM ${table} WHERE crm_record_id = 'mutated-by-app'`,
      );
      expect(one<{ n: number }>(mutated as unknown as Array<{ n: number }>, "count").n).toBe(0);
    });

    test(`${table}: DELETE in its OWN workspace affects zero rows and removes nothing`, async () => {
      const before = await countRows(table, A.wsId);
      const affected = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${A.wsId}, true)`;
        const rows = await tx.unsafe(`DELETE FROM ${table} WHERE workspace_id = $1 RETURNING id`, [
          A.wsId,
        ]);
        return (rows as unknown as unknown[]).length;
      });
      expect(affected).toBe(0);
      expect(await countRows(table, A.wsId)).toBe(before);
    });
  }
});

describe("CRM sync — crm_sync_runs is an append + in-place-progress ledger", () => {
  test("UPDATE of its own run row is ALLOWED (running -> completed)", async () => {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${A.wsId}, true)`;
      await tx`
        UPDATE crm_sync_runs SET status = 'completed', records_seen = 7
        WHERE id = ${A.runId}`;
    });
    const r = one<{ status: string; records_seen: number }>(
      await admin`SELECT status, records_seen FROM crm_sync_runs WHERE id = ${A.runId}`,
      "run",
    );
    expect(r.status).toBe("completed");
    expect(r.records_seen).toBe(7);
  });

  test("UPDATE of ANOTHER workspace's run row changes nothing", async () => {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${B.wsId}, true)`;
      await tx`UPDATE crm_sync_runs SET status = 'cancelled' WHERE id = ${A.runId}`;
    });
    const r = one<{ status: string }>(
      await admin`SELECT status FROM crm_sync_runs WHERE id = ${A.runId}`,
      "run",
    );
    expect(r.status).toBe("completed"); // still A's own value from the test above
  });

  test("DELETE affects zero rows — no DELETE policy, so the ledger is immutable", async () => {
    const affected = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${A.wsId}, true)`;
      const rows = await tx`DELETE FROM crm_sync_runs WHERE id = ${A.runId} RETURNING id`;
      return rows.length;
    });
    expect(affected).toBe(0);
    const r = one<{ n: number }>(
      await admin`SELECT count(*)::int AS n FROM crm_sync_runs WHERE id = ${A.runId}`,
      "count",
    );
    expect(r.n).toBe(1);
  });

  test("the SELECT+INSERT+UPDATE policy set still permits a legitimate INSERT", async () => {
    const inserted = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${A.wsId}, true)`;
      const rows = await tx`
        INSERT INTO crm_sync_runs
          (tenant_id, workspace_id, connection_id, provider, object_type, direction, trigger, mode)
        VALUES (${A.tenantId}, ${A.wsId}, ${A.connectionId}, 'salesforce', 'contact', 'outbound',
                'manual', 'shadow')
        RETURNING id`;
      return rows.length;
    });
    expect(inserted).toBe(1);
  });
});

describe("CRM sync — the encrypted OAuth bundle never crosses a workspace", () => {
  test("workspace B reads no oauth_token_enc belonging to workspace A", async () => {
    const leaked = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${B.wsId}, true)`;
      const rows = await tx`
        SELECT oauth_token_enc FROM crm_connections WHERE id = ${A.connectionId}`;
      return rows.length;
    });
    expect(leaked).toBe(0);
  });

  test("workspace A does read its own ciphertext (the read path works at all)", async () => {
    const own = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${A.wsId}, true)`;
      const rows = await tx`
        SELECT oauth_token_enc FROM crm_connections WHERE id = ${A.connectionId}`;
      return rows.length;
    });
    expect(own).toBe(1);
  });
});
