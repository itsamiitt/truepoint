// lists.itest.ts — owner-scoping + workspace-isolation Definition-of-Done for static prospect lists and the
// soft-owner model (24; spec req #8: "no prospect from another owner or workspace can ever appear, be
// selected, or be acted on"). Real Postgres 16 — Testcontainers by default, or ITEST_DATABASE_URL (itestDb.ts).
// Run in its OWN process (the db client is a module singleton):
//   `bun test ./packages/db/test/lists.itest.ts`
//
// Proves:
//   (1) a list is workspace-shared — owner + a co-worker see it, workspace B NEVER does;
//   (2) membership writes are CROSS-WORKSPACE-SAFE — a contact from workspace B can never be added to a
//       workspace-A list (it is silently filtered out; the affected count and the member rows exclude it);
//       and the masked contact list is itself workspace-isolated (B's contacts never surface in A);
//   (3) rename/delete are OWNER-gated — a co-worker (same workspace) and workspace B both 404, row intact;
//   (4) the soft owner surfaces on the masked list (owner_user_id), and remove-members affects only the ids
//       passed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

// Two tenants × one workspace each (RLS isolation), plus a second member of A's workspace (owner-gating).
let tenantA = "";
let wsA = "";
let ownerA = "";
let coworkerA = "";
let tenantB = "";
let wsB = "";
let ownerB = "";
let contactA1 = "";
let contactA2 = "";
let contactB1 = "";

async function seedUser(email: string): Promise<string> {
  const [u] = await admin`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
  return (u as { id: string }).id;
}

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const ownerId = await seedUser(`owner@${slug}.test`);
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

/** Minimal masked contact (no PII) owned by `ownerUserId`. */
async function seedContact(
  scope: { tenantId: string; workspaceId: string },
  ownerUserId: string,
  firstName: string,
): Promise<string> {
  const [c] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, owner_user_id, first_name)
    VALUES (${scope.tenantId}, ${scope.workspaceId}, ${ownerUserId}, ${firstName}) RETURNING id`;
  return (c as { id: string }).id;
}

async function caught(run: () => Promise<unknown>): Promise<{ code?: string } & Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as { code?: string } & Error;
  }
}

async function memberContactIds(listId: string): Promise<string[]> {
  const rows = await admin`SELECT contact_id FROM list_members WHERE list_id = ${listId}`;
  return (rows as { contact_id: string }[]).map((r) => r.contact_id).sort();
}

beforeAll(async () => {
  dbHandle = await startItestDb("lists");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedTenantWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedTenantWorkspace("globex"));
  coworkerA = await seedUser("coworker@acme.test");
  await admin`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (${wsA}, ${coworkerA}, 'member', 'active', now())`;

  contactA1 = await seedContact({ tenantId: tenantA, workspaceId: wsA }, ownerA, "A-One");
  contactA2 = await seedContact({ tenantId: tenantA, workspaceId: wsA }, coworkerA, "A-Two");
  contactB1 = await seedContact({ tenantId: tenantB, workspaceId: wsB }, ownerB, "B-One");

  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

describe("prospect lists — owner scoping + workspace isolation (req #8)", () => {
  test("a list is workspace-shared: owner + co-worker see it; workspace B never does", async () => {
    const created = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "Q3 targets",
    });
    expect(created.isOwner).toBe(true);

    const ownerView = await core.listLists({ scope: scopeA(), callerUserId: ownerA });
    expect(ownerView.find((l) => l.id === created.id)?.isOwner).toBe(true);

    const coworkerView = await core.listLists({ scope: scopeA(), callerUserId: coworkerA });
    expect(coworkerView.find((l) => l.id === created.id)?.isOwner).toBe(false); // shared, not owned

    const bView = await core.listLists({ scope: scopeB(), callerUserId: ownerB });
    expect(bView.some((l) => l.id === created.id)).toBe(false); // RLS: B never sees A's list
  });

  test("membership is cross-workspace-safe: B's contact can never join an A list", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "mixed add",
    });
    // Try to add one valid A contact + one foreign B contact in the same call.
    const res = await core.addContactsToList({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      contactIds: [contactA1, contactB1],
    });
    expect(res.affected).toBe(1); // only the A contact landed
    expect(await memberContactIds(list.id)).toEqual([contactA1]); // B's contact never linked
  });

  test("rename/delete are owner-gated: a co-worker and workspace B both 404, row intact", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "owned only",
    });

    const coworkerRename = await caught(() =>
      core.updateList({ scope: scopeA(), callerUserId: coworkerA, id: list.id, name: "hijacked" }),
    );
    expect(coworkerRename.code).toBe("not_found");

    const bDelete = await caught(() =>
      core.deleteList({ scope: scopeB(), callerUserId: ownerB, id: list.id }),
    );
    expect(bDelete.code).toBe("not_found");

    const [row] = await admin`SELECT name FROM lists WHERE id = ${list.id}`;
    expect((row as { name: string }).name).toBe("owned only"); // survived both attempts

    const renamed = await core.updateList({
      scope: scopeA(),
      callerUserId: ownerA,
      id: list.id,
      name: "owned only (v2)",
    });
    expect(renamed.name).toBe("owned only (v2)"); // the owner can
  });

  test("the masked contact list is workspace-isolated and surfaces the soft owner", async () => {
    const aRows = await db.contactRepository.listByWorkspace(scopeA(), 100);
    const aIds = aRows.map((r) => r.id);
    expect(aIds).toContain(contactA1);
    expect(aIds).toContain(contactA2);
    expect(aIds).not.toContain(contactB1); // B's contact never surfaces in A
    expect(aRows.find((r) => r.id === contactA1)?.ownerUserId).toBe(ownerA);
    expect(aRows.find((r) => r.id === contactA2)?.ownerUserId).toBe(coworkerA); // soft owner, distinct member

    const bRows = await db.contactRepository.listByWorkspace(scopeB(), 100);
    const bIds = bRows.map((r) => r.id);
    expect(bIds).toContain(contactB1);
    expect(bIds).not.toContain(contactA1); // A's contacts never surface in B
  });

  test("remove-members affects only the ids passed", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "removable",
    });
    await core.addContactsToList({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      contactIds: [contactA1, contactA2],
    });
    const res = await core.removeContactsFromList({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      contactIds: [contactA1],
    });
    expect(res.affected).toBe(1);
    expect(await memberContactIds(list.id)).toEqual([contactA2]); // only A2 remains
  });
});
