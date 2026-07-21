// accountHierarchy.cycleguard.itest.ts — S-A4/S-A6 hierarchy write-guard gate (import-and-data-model-redesign
// 06 §2; 15 §T-P4 "cycle tests"): the accountChildRepository.setParentAccount write-time invariants end to end
// against a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its
// OWN process: `bun test ./packages/db/test/accountHierarchy.cycleguard.itest.ts`.
//
// PROVEN (06 §2): self-parent rejected; a 2-cycle and a deep cycle rejected (CIRCULAR_DEPENDENCY analog); a
// 10-deep chain accepted but an 11th level rejected (depth cap = ACCOUNT_HIERARCHY_MAX_DEPTH); root_account_id
// is recomputed for the moved node AND its whole subtree in the same tx (attach + clear).
//
// NO API verb ships yet (06 §API's PATCH parent verb rides doc 04/11) — the guard is exercised directly through
// the repo method inside withTenantTx, RLS-scoped to one workspace. Core is not needed here; @leadwolf/db is
// imported directly (no Turbo cycle — the repo lives in db).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;

let tenantId = "";
let workspaceId = "";

async function seedTenantWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId: tId, workspaceId: (w as { id: string }).id };
}

/** Insert a bare account (hierarchy fields start empty) and return its id. */
async function makeAccount(name: string): Promise<string> {
  const [a] = await admin`
    INSERT INTO accounts (tenant_id, workspace_id, name) VALUES (${tenantId}, ${workspaceId}, ${name}) RETURNING id`;
  return (a as { id: string }).id;
}

async function edges(id: string): Promise<{ parent: string | null; root: string | null }> {
  const [r] = await admin`
    SELECT parent_account_id::text AS parent, root_account_id::text AS root FROM accounts WHERE id = ${id}`;
  return r as unknown as { parent: string | null; root: string | null };
}

const scope = () => ({ tenantId, workspaceId });

/** setParentAccount inside a fresh withTenantTx (the caller's tx contract). */
function setParent(accountId: string, parentAccountId: string | null): Promise<void> {
  return db.withTenantTx(scope(), (tx) =>
    db.accountChildRepository.setParentAccount(tx, scope(), { accountId, parentAccountId }),
  );
}

/** Assert a setParent call rejects with a specific AccountHierarchyError code. */
async function expectReject(
  accountId: string,
  parentAccountId: string | null,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await setParent(accountId, parentAccountId);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(db.AccountHierarchyError);
  expect((caught as { code: string }).code).toBe(code);
}

beforeAll(async () => {
  dbHandle = await startItestDb("account_hierarchy_cycleguard");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId, workspaceId } = await seedTenantWorkspace("hier"));
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("06 §2 — self-parent + cycle rejection", () => {
  test("self-parent ⇒ self_parent (the DB CHECK is the backstop)", async () => {
    const a = await makeAccount("self");
    await expectReject(a, a, "self_parent");
  });

  test("a 2-cycle ⇒ cycle (child is already an ancestor of the proposed parent)", async () => {
    const a = await makeAccount("cyc-a");
    const b = await makeAccount("cyc-b");
    await setParent(b, a); // b under a
    await expectReject(a, b, "cycle"); // a under b would close the loop
  });

  test("a deep cycle (a→b→c, then a under c) ⇒ cycle", async () => {
    const a = await makeAccount("dc-a");
    const b = await makeAccount("dc-b");
    const c = await makeAccount("dc-c");
    await setParent(b, a);
    await setParent(c, b);
    await expectReject(a, c, "cycle");
  });
});

describe("06 §2 — depth cap (ACCOUNT_HIERARCHY_MAX_DEPTH = 10)", () => {
  test("a 10-deep chain is accepted; an 11th level ⇒ depth_cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await makeAccount(`chain-${i}`));
    // Chain them: ids[0] (root) → ids[1] → … → ids[9] (depth 10). Each attach is within the cap.
    for (let i = 1; i < 10; i++) await setParent(ids[i]!, ids[i - 1]!);
    // An 11th child under the depth-10 leaf would make an 11-deep tree ⇒ rejected.
    const n11 = await makeAccount("chain-11");
    await expectReject(n11, ids[9]!, "depth_cap");
  });
});

describe("06 §2 — root_account_id recompute (moved node + whole subtree, same tx)", () => {
  test("attach: re-rooting a family propagates the new ultimate root to every descendant", async () => {
    // Build a→b→c→d under a (a is the root).
    const a = await makeAccount("fam-a");
    const b = await makeAccount("fam-b");
    const c = await makeAccount("fam-c");
    const d = await makeAccount("fam-d");
    await setParent(b, a);
    await setParent(c, b);
    await setParent(d, c);
    // Family key of every non-root node is a (COALESCE(root,id)); a is its own root (root NULL).
    expect((await edges(a)).root).toBeNull();
    for (const n of [b, c, d]) expect((await edges(n)).root).toBe(a);

    // Now graft the whole family under a fresh root e: a→e. Every node's ultimate root becomes e.
    const e = await makeAccount("fam-e");
    await setParent(a, e);
    expect((await edges(e)).root).toBeNull();
    for (const n of [a, b, c, d]) expect((await edges(n)).root).toBe(e);
    expect((await edges(a)).parent).toBe(e);
  });

  test("clear: detaching a node makes it the family root; its subtree re-points at it", async () => {
    const a = await makeAccount("clr-a");
    const b = await makeAccount("clr-b");
    const c = await makeAccount("clr-c");
    await setParent(b, a);
    await setParent(c, b); // a→b→c, all root=a
    await setParent(b, null); // b detaches → b is its own root; c re-roots at b
    const eb = await edges(b);
    expect(eb.parent).toBeNull();
    expect(eb.root).toBeNull();
    const ec = await edges(c);
    expect(ec.parent).toBe(b); // c still points at b
    expect(ec.root).toBe(b); // …and its ultimate root is now b
  });
});
