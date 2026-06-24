// listsStaffNoAccess.itest.ts — the Phase-5 STAFF-NO-ACCESS Definition-of-Done (list-plan/07 §8 done-when,
// 08 §9 test #2, D2). The privacy-first guarantee: WITHOUT a workspace scope (the customer path) or an
// impersonation session, NO staff/platform path can reach a tenant's list-MEMBER PII — staff see only list
// METADATA + AGGREGATE counts. Real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL). Run in
// its OWN process (the db client is a module singleton):
//   `bun test ./packages/db/test/listsStaffNoAccess.itest.ts`
//
// Proves (D2):
//   (1) the customer app role (leadwolf_app) with NO `app.current_workspace_id` GUC reads ZERO list_members
//       rows (NULLIF fail-closed) — record-level list contents are unreachable without a workspace scope;
//   (2) the customer app role WITH the workspace GUC set (the ONLY legit record-level path) DOES see its own
//       members — proving (1) is the scope boundary, not a broken query;
//   (3) the STAFF lists-overview (platformAdminRepository.listTenantListsOverview via withPlatformTx) returns
//       per-list METADATA + an aggregate member COUNT only — and its projection carries NO contact-PII field
//       and NO list_members row;
//   (4) every staff overview read writes an append-only platform_audit_log row (admin.list.view_metadata)
//       naming the tenant — the access is audited.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>; // migration/owner connection
let app: ReturnType<typeof postgres>; // the non-BYPASSRLS leadwolf_app role (the customer API connection)
let db: Db;

let tenantA = "";
let wsA = "";
let ownerA = "";
let listA = "";
let contactA1 = "";
let contactA2 = "";

async function seedUser(email: string): Promise<string> {
  const [u] = await admin`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
  return (u as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("listsStaffNoAccess");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme') RETURNING id`;
  tenantA = (t as { id: string }).id;
  ownerA = await seedUser("owner@acme.test");
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  // A list with two members carrying PII columns (the thing staff must NEVER reach record-level).
  const [c1] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, owner_user_id, first_name, last_name)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, 'Jane', 'Doe') RETURNING id`;
  const [c2] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, owner_user_id, first_name, last_name)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, 'Mark', 'Roe') RETURNING id`;
  contactA1 = (c1 as { id: string }).id;
  contactA2 = (c2 as { id: string }).id;

  const [l] = await admin`
    INSERT INTO lists (tenant_id, workspace_id, owner_user_id, name)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, 'Q3 targets') RETURNING id`;
  listA = (l as { id: string }).id;
  await admin`
    INSERT INTO list_members (tenant_id, workspace_id, list_id, contact_id, added_by_user_id)
    VALUES (${tenantA}, ${wsA}, ${listA}, ${contactA1}, ${ownerA}),
           (${tenantA}, ${wsA}, ${listA}, ${contactA2}, ${ownerA})`;

  db = await import("@leadwolf/db");
}, 240_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await app?.end();
  await dbHandle?.stop();
});

describe("Phase-5 staff-no-access guarantee (list-plan/07 §8, D2)", () => {
  test("leadwolf_app with NO workspace GUC reads ZERO list_members (record-level contents unreachable)", async () => {
    // The customer API role, but no `app.current_workspace_id` set — exactly the state a staff/platform path
    // would be in if it tried to read member rows as the app role without a workspace scope. NULLIF
    // fail-closed → the workspace predicate matches nothing → zero rows. No impersonation, no contents.
    const rows = await app`SELECT count(*)::int AS n FROM list_members WHERE list_id = ${listA}`;
    expect((rows[0] as { n: number }).n).toBe(0);
    // The same for the lists container itself (FORCE-RLS, workspace-isolated).
    const listRows = await app`SELECT count(*)::int AS n FROM lists WHERE id = ${listA}`;
    expect((listRows[0] as { n: number }).n).toBe(0);
  });

  test("leadwolf_app WITH the workspace GUC set DOES see its own members (the only legit record-level path)", async () => {
    // Mirror withTenantTx: drop to the app role + set the workspace GUC LOCAL, then read. This is the
    // customer-in-workspace path — and it is the ONLY non-impersonation way to reach member rows.
    const seen = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true),
                      set_config('app.current_workspace_id', ${wsA}, true)`;
      const r =
        await tx`SELECT contact_id FROM list_members WHERE list_id = ${listA} ORDER BY contact_id`;
      return (r as { contact_id: string }[]).map((x) => x.contact_id);
    });
    expect(seen.sort()).toEqual([contactA1, contactA2].sort());
  });

  test("the staff lists-overview returns METADATA + aggregate COUNT only — no member rows, no PII", async () => {
    const overview = await db.withPlatformTx(
      { userId: ownerA, ip: "10.0.0.1" },
      "admin.list.view_metadata",
      (tx) => db.platformAdminRepository.listTenantListsOverview(tx, tenantA),
      { targetType: "tenant", targetId: tenantA, tenantId: tenantA },
    );
    expect(overview).toHaveLength(1);
    const row = overview[0]!;
    expect(row.id).toBe(listA);
    expect(row.name).toBe("Q3 targets");
    expect(row.ownerUserId).toBe(ownerA);
    expect(row.memberCount).toBe(2); // aggregate count, not the rows

    // The projection is metadata-only: no contact-PII field (no first/last name, email, phone), no member
    // id/contact_id, AND no owner EMAIL (the owner is a customer employee — their email is PII). Assert the
    // shape contains exactly the allowed keys.
    expect(Object.keys(row).sort()).toEqual(
      ["createdAt", "description", "id", "memberCount", "ownerUserId", "updatedAt"].sort(),
    );
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain("Jane"); // no member PII anywhere in the staff payload
    expect(serialized).not.toContain("Doe");
    expect(serialized).not.toContain("owner@acme.test"); // no owner-email PII either
    expect(serialized).not.toContain(contactA1); // no member contact id leaks
    expect(serialized).not.toContain(contactA2);
  });

  test("each staff overview read writes an append-only platform_audit_log row naming the tenant", async () => {
    const before = await admin`
      SELECT count(*)::int AS n FROM platform_audit_log
      WHERE action = 'admin.list.view_metadata' AND tenant_id = ${tenantA}`;
    const beforeN = (before[0] as { n: number }).n;

    await db.withPlatformTx(
      { userId: ownerA, ip: "10.0.0.2" },
      "admin.list.view_metadata",
      (tx) => db.platformAdminRepository.listTenantListsOverview(tx, tenantA),
      { targetType: "tenant", targetId: tenantA, tenantId: tenantA },
    );

    const after = await admin`
      SELECT actor_user_id, action, target_type, target_id, tenant_id FROM platform_audit_log
      WHERE action = 'admin.list.view_metadata' AND tenant_id = ${tenantA}
      ORDER BY occurred_at DESC LIMIT 1`;
    const auditCount = await admin`
      SELECT count(*)::int AS n FROM platform_audit_log
      WHERE action = 'admin.list.view_metadata' AND tenant_id = ${tenantA}`;
    expect((auditCount[0] as { n: number }).n).toBe(beforeN + 1);
    const r = after[0] as Record<string, string>;
    expect(r.actor_user_id).toBe(ownerA);
    expect(r.target_type).toBe("tenant");
    expect(r.target_id).toBe(tenantA);
    expect(r.tenant_id).toBe(tenantA);
  });
});
