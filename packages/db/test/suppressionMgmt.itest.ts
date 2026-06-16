// suppressionMgmt.itest.ts — proves the DNC / suppression-list MANAGEMENT surface (T-1b27d4ce) is tenant-
// ISOLATED under RLS: suppressionRepository.list + removeByIds run inside withTenantTx (SET LOCAL ROLE
// leadwolf_app + the tenant/workspace GUCs), so one tenant can never list or delete another tenant's
// suppression rows, and the management list excludes the platform-managed global rows. Real Postgres 16
// (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts). Run in its
// OWN process (the db client is a module singleton): `bun test ./packages/db/test/suppressionMgmt.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let tenantA = "";
let wsA = "";
let tenantB = "";
let wsB = "";

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  dbHandle = await startItestDb("suppression-mgmt");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

/** Add a tenant-scoped domain suppression in `tenantId`'s scope via the RLS-enforced repository path. */
function addDomainSuppression(
  tenantId: string,
  workspaceId: string,
  domain: string,
): Promise<string> {
  return db.withTenantTx({ tenantId, workspaceId }, (tx) =>
    db.suppressionRepository.insert(tx, {
      scope: "tenant",
      tenantId,
      matchType: "domain",
      domain,
      reason: `block ${domain}`,
    }),
  );
}

const countById = async (id: string): Promise<number> => {
  const [r] = await admin`SELECT count(*)::int AS n FROM suppression_list WHERE id = ${id}`;
  return (r as { n: number }).n;
};

describe("DNC suppression management is tenant-isolated (withTenantTx / RLS)", () => {
  test("list shows only the caller's own entries — never another tenant's, never global", async () => {
    const idA = await addDomainSuppression(tenantA, wsA, "blocked-by-a.com");
    const idB = await addDomainSuppression(tenantB, wsB, "blocked-by-b.com");
    // A platform-managed global row exists; the management list must exclude it.
    await admin`
      INSERT INTO suppression_list (scope, match_type, domain, reason)
      VALUES ('global', 'domain', 'globally-blocked.com', 'platform')`;

    const listA = await db.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      db.suppressionRepository.list(tx),
    );
    const idsA = listA.map((e) => e.id);
    expect(idsA).toContain(idA);
    expect(idsA).not.toContain(idB);
    expect(listA.every((e) => e.scope !== "global")).toBe(true);

    const listB = await db.withTenantTx({ tenantId: tenantB, workspaceId: wsB }, (tx) =>
      db.suppressionRepository.list(tx),
    );
    const idsB = listB.map((e) => e.id);
    expect(idsB).toContain(idB);
    expect(idsB).not.toContain(idA);
  });

  test("removeByIds cannot delete another tenant's row; only the owner can", async () => {
    const idA = await addDomainSuppression(tenantA, wsA, "del-a.com");
    const idB = await addDomainSuppression(tenantB, wsB, "del-b.com");

    // A attempts to delete B's row → the RLS delete policy makes it a no-op; B's row survives.
    await db.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      db.suppressionRepository.removeByIds(tx, [idB]),
    );
    expect(await countById(idB)).toBe(1);

    // Each tenant CAN delete its own row.
    await db.withTenantTx({ tenantId: tenantB, workspaceId: wsB }, (tx) =>
      db.suppressionRepository.removeByIds(tx, [idB]),
    );
    await db.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      db.suppressionRepository.removeByIds(tx, [idA]),
    );
    expect(await countById(idA)).toBe(0);
    expect(await countById(idB)).toBe(0);
  });
});
