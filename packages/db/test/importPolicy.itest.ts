// importPolicy.itest.ts — the per-workspace import policy's storage contract + the T-V6 audited-write half
// (import-and-data-model-redesign 10 §3, S-V4), on a real Postgres 16 (Testcontainers by default, or
// ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a module singleton):
// `bun test ./packages/db/test/importPolicy.itest.ts`.
//
// Proves: (1) an unconfigured workspace resolves to the member-broad DEFAULT (today's posture); (2) the
// settings-PUT composition — upsertInTx + the `import.policy_updated` audit row in ONE tenant tx — commits
// together AND passes the audit_log action CHECK (ruling M1: the P0 CHECK extension rode S-V1's migration
// train; without it this write would fail at runtime); (3) a re-upsert updates the single per-workspace
// row in place (never a duplicate) and records the acting admin; (4) RLS: workspace B never sees A's
// policy. The role-gate half of T-V6 (viewer/member 403s) is the pure evaluateImportCreateGrant matrix
// (packages/core importCreateGrant.test.ts) + the shipped requireRole mechanism on the settings routes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let tenantA = "";
let wsA = "";
let userA = "";
let tenantB = "";
let wsB = "";

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; userId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, userId: u!.id };
}

beforeAll(async () => {
  dbHandle = await startItestDb("import-policy");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, userId: userA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  db = await import("@leadwolf/db");
}, 240_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("import_policy — resolve-or-default, audited upsert, RLS isolation (T-V6)", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
  const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

  test("an unconfigured workspace resolves to the member-broad default (today's posture)", async () => {
    expect(await db.importPolicyRepository.get(scopeA())).toBeNull();
    expect(await db.importPolicyRepository.resolved(scopeA())).toEqual({
      whoCanImport: "member",
      defaultMergeMode: "create_and_update",
      defaultPreservePopulated: false,
    });
  });

  test("the settings-PUT composition: upsert + import.policy_updated audit row in ONE tx", async () => {
    // Compose exactly like PUT /settings/import-policy: policy write + in-tx audit, one transaction.
    const record = await db.withTenantTx(scopeA(), async (tx) => {
      const next = await db.importPolicyRepository.upsertInTx(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        whoCanImport: "admin",
        defaultMergeMode: "create_only",
        defaultPreservePopulated: true,
        updatedByUserId: userA,
      });
      await db.auditRepository.insert(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        actorUserId: userA,
        action: "import.policy_updated", // the M1 P0 CHECK extension — this INSERT proves it at runtime
        entityType: "import_policy",
        entityId: wsA,
        metadata: { whoCanImport: "admin" },
      });
      return next;
    });
    expect(record.whoCanImport).toBe("admin");
    expect(record.updatedByUserId).toBe(userA);

    const [audit] = await admin`
      SELECT action, actor_user_id FROM audit_log
       WHERE tenant_id = ${tenantA} AND action = 'import.policy_updated'`;
    expect((audit as { action: string }).action).toBe("import.policy_updated");
    expect((audit as { actor_user_id: string }).actor_user_id).toBe(userA);
  });

  test("re-upsert updates the single per-workspace row in place (never a duplicate)", async () => {
    await db.withTenantTx(scopeA(), (tx) =>
      db.importPolicyRepository.upsertInTx(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        whoCanImport: "member",
        defaultMergeMode: "create_and_update",
        defaultPreservePopulated: false,
        updatedByUserId: userA,
      }),
    );
    const [count] = (await admin`
      SELECT count(*)::int AS n FROM import_policy WHERE workspace_id = ${wsA}`) as { n: number }[];
    expect(count!.n).toBe(1);
    expect((await db.importPolicyRepository.resolved(scopeA())).whoCanImport).toBe("member");
  });

  test("RLS: workspace B never sees A's policy (fail-closed default for B)", async () => {
    expect(await db.importPolicyRepository.get(scopeB())).toBeNull();
    expect((await db.importPolicyRepository.resolved(scopeB())).whoCanImport).toBe("member");
    // The BYPASSRLS admin sees A's row — proving it exists; only RLS hides it from B's scope.
    const [count] = (await admin`
      SELECT count(*)::int AS n FROM import_policy`) as { n: number }[];
    expect(count!.n).toBe(1);
  });
});
