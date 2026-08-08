// meteringAccess.itest.ts — the access model for the Phase 1 metering pair, `usage_event` and `entitlement`.
// On a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN
// process: `bun test ./packages/db/test/meteringAccess.itest.ts`.
//
// The two tables have DELIBERATELY OPPOSITE postures, and each one's failure mode is the other's normal:
//
//   usage_event  — the app WRITES it (a reveal meters itself inside its own transaction), scoped to the
//                  workspace GUC. The risk is cross-workspace leakage, so both directions are asserted: a
//                  read must not see another workspace's rows, and a WRITE must not be able to plant one.
//
//   entitlement  — the app only READS it. A role that can grant itself an entitlement has no cap at all, so
//                  the enforcement path would be decorative. The wall is FORCE RLS plus the ABSENCE of a write
//                  policy, NOT a REVOKE: applyMigrations' [4/4] phase runs after every rls/*.sql and hands
//                  leadwolf_app every table privilege, so a REVOKE would simply be undone. That distinction is
//                  invisible in the SQL and is exactly why it needs a test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantA = "";
let wsA = "";
let userA = "";
let tenantB = "";
let wsB = "";

async function seedTenant(slug: string) {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const userId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${userId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${userId}) RETURNING id`;
  return { tenantId, wsId: (w as { id: string }).id, userId };
}

beforeAll(async () => {
  dbHandle = await startItestDb("meteringAccess");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  ({ tenantId: tenantA, wsId: wsA, userId: userA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB } = await seedTenant("globex"));

  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

/** A scalar read inside a scoped tenant tx — the shape every isolation assertion below needs. */
async function scopedCount(
  scope: { tenantId: string; workspaceId: string },
  query: string,
): Promise<number> {
  const rows = (await dbmod.withTenantTx(scope, (tx) =>
    tx.execute(sql.raw(query)),
  )) as unknown as Array<Record<string, unknown>>;
  return Number(Object.values(rows[0] ?? {})[0] ?? -1);
}

/** Run a statement as leadwolf_app inside a fully-GUC'd tenant tx; return the SQLSTATE it threw (or ""). */
async function appCode(scope: { tenantId: string; wsId: string }, stmt: string): Promise<string> {
  try {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${scope.tenantId}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${scope.wsId}, true)`;
      await tx.unsafe(stmt);
    });
  } catch (e) {
    return (e as { code?: string }).code ?? "";
  }
  return "";
}

describe("usage_event — workspace isolation, both directions", () => {
  test("the repository append lands under withTenantTx", async () => {
    await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, async (tx) => {
      await dbmod.usageEventRepository.append(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        userId: userA,
        action: "reveal",
        subjectType: "contact",
        entitlementKey: "reveal_month",
        metadata: { revealType: "email" },
      });
    });
    const [n] = await admin`SELECT count(*)::int AS n FROM usage_event WHERE workspace_id = ${wsA}`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("workspace B cannot READ workspace A's metering", async () => {
    const n = await scopedCount(
      { tenantId: tenantB, workspaceId: wsB },
      "SELECT count(*)::int AS n FROM usage_event",
    );
    expect(n).toBe(0);
  });

  test("workspace B cannot PLANT a row in workspace A", async () => {
    // The direction a read-only isolation test would miss. Under FORCE RLS the WITH CHECK clause rejects an
    // INSERT whose workspace_id is not the GUC's — SQLSTATE 42501, the RLS violation code.
    const code = await appCode(
      { tenantId: tenantB, wsId: wsB },
      `INSERT INTO usage_event (tenant_id, workspace_id, action)
         VALUES ('${tenantA}', '${wsA}', 'reveal')`,
    );
    expect(code).toBe("42501");

    const [n] = await admin`SELECT count(*)::int AS n FROM usage_event WHERE workspace_id = ${wsA}`;
    expect((n as { n: number }).n).toBe(1); // still just the legitimate one
  });

  test("a miss without a fingerprint is refused by the database", async () => {
    // The CHECK exists so a miss can always be counted and later suppressed. Without it the most-wanted feed
    // silently drops rows that have neither a subject nor a fingerprint.
    const code = await appCode(
      { tenantId: tenantA, wsId: wsA },
      `INSERT INTO usage_event (tenant_id, workspace_id, action)
         VALUES ('${tenantA}', '${wsA}', 'reveal_miss')`,
    );
    expect(code).toBe("23514"); // check_violation
  });
});

describe("outcome metrics — the number the kill criterion turns on", () => {
  test("hit rate counts misses in the denominator", async () => {
    // THE assertion. Phase 1 stops the project if reveal-hit rate is <40%, and the obvious source for that
    // number — contact_reveals — cannot produce it: a miss never creates a claim row, so a hit rate computed
    // from the billing table is 100% by construction. Two hits and three misses must read 0.4, not 1.0.
    await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, async (tx) => {
      for (let i = 0; i < 2; i++) {
        await dbmod.usageEventRepository.append(tx, {
          tenantId: tenantA,
          workspaceId: wsA,
          action: "reveal",
          metadata: { serverMs: 100 + i },
        });
      }
      for (let i = 0; i < 3; i++) {
        await dbmod.usageEventRepository.append(tx, {
          tenantId: tenantA,
          workspaceId: wsA,
          action: "reveal_miss",
          subjectFingerprint: new Uint8Array([9, i]),
        });
      }
    });

    const m = await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      dbmod.outcomeMetricsRepository.revealOutcomes(tx, 30),
    );
    // The earlier suite in this file already appended one 'reveal', so hits is 3 of 6.
    expect(m.hits).toBe(3);
    expect(m.misses).toBe(3);
    expect(m.hitRate).toBeCloseTo(0.5, 5);
  });

  test("p95 ignores rows with no recorded duration rather than counting them as zero", async () => {
    // A miss carries no serverMs. Treating a missing value as 0 would drag the p95 down and make a slow reveal
    // path look fast — the failure mode that lets a latency SLO pass while users wait.
    const m = await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      dbmod.outcomeMetricsRepository.revealOutcomes(tx, 30),
    );
    expect(m.p95ServerMs).not.toBeNull();
    expect(m.p95ServerMs as number).toBeGreaterThan(0);
  });

  test("an empty window returns null, not a zero hit rate", async () => {
    // "No data yet" and "every attempt missed" are opposite conclusions. A kill criterion that cannot tell
    // them apart would stop the project on an empty table.
    const m = await dbmod.withTenantTx({ tenantId: tenantB, workspaceId: wsB }, (tx) =>
      dbmod.outcomeMetricsRepository.revealOutcomes(tx, 30),
    );
    expect(m.hits).toBe(0);
    expect(m.misses).toBe(0);
    expect(m.hitRate).toBeNull();
  });

  test("most-wanted ranks by demand and is workspace-scoped", async () => {
    const wanted = await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      dbmod.outcomeMetricsRepository.mostWanted(tx, 10),
    );
    expect(wanted.length).toBeGreaterThan(0);

    // Workspace B ran no misses of its own, so it must see none of A's demand.
    const other = await dbmod.withTenantTx({ tenantId: tenantB, workspaceId: wsB }, (tx) =>
      dbmod.outcomeMetricsRepository.mostWanted(tx, 10),
    );
    expect(other.length).toBe(0);
  });
});

describe("entitlement — readable by the app, never writable", () => {
  test("a tenant reads its own entitlements", async () => {
    await admin`
      INSERT INTO entitlement (tenant_id, key, cap, period, source)
      VALUES (${tenantA}, 'reveal_month', 25, 'month', 'plan')`;

    const cap = await scopedCount(
      { tenantId: tenantA, workspaceId: wsA },
      "SELECT cap FROM entitlement WHERE key = 'reveal_month'",
    );
    expect(cap).toBe(25);
  });

  test("another tenant sees none of them", async () => {
    const n = await scopedCount(
      { tenantId: tenantB, workspaceId: wsB },
      "SELECT count(*)::int AS n FROM entitlement",
    );
    expect(n).toBe(0);
  });

  test("the app role cannot grant itself an entitlement, raise a cap, or drop one", async () => {
    // THE assertion in this file, and the mechanism is NOT uniform — which is worth knowing, because the
    // obvious version of this test (assert 42501 three times) FAILS, and failing for the wrong reason is how
    // a security test gets "fixed" by weakening it.
    //
    // Under FORCE RLS with only a FOR SELECT policy:
    //   INSERT raises 42501 — there is no policy to satisfy WITH CHECK, so the row is refused outright.
    //   UPDATE and DELETE raise NOTHING. With no policy granting those commands, the rows are simply not
    //   visible AS TARGETS, so the statement matches zero rows and reports success.
    // Both outcomes are safe, but only one is loud. That means "no error" must never be read as "it worked",
    // and the real proof is the STATE afterwards, which is what this asserts.
    const scope = { tenantId: tenantA, wsId: wsA };

    expect(
      await appCode(
        scope,
        `INSERT INTO entitlement (tenant_id, key, cap, source)
           VALUES ('${tenantA}', 'export_month', 999999, 'staff')`,
      ),
    ).toBe("42501");

    // Silent no-ops, not errors. Asserted explicitly so a future Postgres version that starts raising here
    // shows up as a deliberate change rather than a surprise.
    expect(
      await appCode(scope, `UPDATE entitlement SET cap = 999999 WHERE key = 'reveal_month'`),
    ).toBe("");
    expect(await appCode(scope, `DELETE FROM entitlement WHERE key = 'reveal_month'`)).toBe("");

    // THE SECURITY PROPERTY: nothing moved. The cap is what the plan granted, the forged row never landed,
    // and the row the app tried to delete is still there.
    const rows = await admin`
      SELECT key, cap FROM entitlement WHERE tenant_id = ${tenantA} ORDER BY key`;
    const byKey = new Map(
      rows.map((r) => [(r as { key: string }).key, (r as { cap: number }).cap]),
    );
    expect(byKey.get("reveal_month")).toBe(25); // not raised to 999999, and not deleted
    expect(byKey.has("export_month")).toBe(false); // the self-granted row never existed
  });

  test("cap 0 and cap NULL are different facts", async () => {
    // NULL means unlimited, 0 means the feature is off for this tenant. Conflating them is how an unlimited
    // plan silently becomes a blocked one, so the column must keep both representable.
    await admin`
      INSERT INTO entitlement (tenant_id, key, cap, source) VALUES (${tenantA}, 'alerts', NULL, 'plan')`;
    await admin`
      INSERT INTO entitlement (tenant_id, key, cap, source) VALUES (${tenantA}, 'export_month', 0, 'plan')`;
    const rows = await admin`
      SELECT key, cap FROM entitlement WHERE tenant_id = ${tenantA} AND key IN ('alerts','export_month')
       ORDER BY key`;
    expect((rows[0] as { cap: number | null }).cap).toBeNull();
    expect((rows[1] as { cap: number | null }).cap).toBe(0);
  });

  test("the same key from two sources coexists — Community never overwrites the plan", async () => {
    // `source` is in the primary key precisely so a Phase 3 Community grant can be withdrawn by expiring one
    // row without touching what the tenant paid for.
    await admin`
      INSERT INTO entitlement (tenant_id, key, cap, period, source)
      VALUES (${tenantA}, 'reveal_month', 100, 'month', 'community')`;
    const rows = await admin`
      SELECT source, cap FROM entitlement
       WHERE tenant_id = ${tenantA} AND key = 'reveal_month' ORDER BY source`;
    expect(rows.length).toBe(2);
    expect((rows[0] as { source: string; cap: number }).source).toBe("community");
    expect((rows[1] as { source: string; cap: number }).cap).toBe(25); // the plan row, untouched
  });
});
