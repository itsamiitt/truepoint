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

  test("Phase-0 schema: new list/member columns default correctly (list-plan/02)", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "phase0 defaults",
    });
    // A plain create lands the Phase-0 defaults: a static list, empty tags, no provenance/dynamic link yet.
    const [meta] = await admin`
      SELECT list_kind, tags, source, saved_search_id, deleted_at FROM lists WHERE id = ${list.id}`;
    expect((meta as { list_kind: string }).list_kind).toBe("static");
    expect((meta as { tags: unknown }).tags).toEqual([]);
    expect((meta as { source: string | null }).source).toBeNull();
    expect((meta as { saved_search_id: string | null }).saved_search_id).toBeNull();
    expect((meta as { deleted_at: string | null }).deleted_at).toBeNull();

    await core.addContactsToList({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      contactIds: [contactA1],
    });
    // A member added through the core path carries the default provenance (added_via='manual', no import link).
    const [mem] = await admin`
      SELECT added_via, source_import_id FROM list_members
      WHERE list_id = ${list.id} AND contact_id = ${contactA1}`;
    expect((mem as { added_via: string }).added_via).toBe("manual");
    expect((mem as { source_import_id: string | null }).source_import_id).toBeNull();

    // Phase-0 DoD: list mutations write append-only audit rows (list.create + member.add).
    const auditRows = await admin`SELECT action FROM audit_log WHERE entity_id = ${list.id}`;
    const actions = (auditRows as { action: string }[]).map((r) => r.action);
    expect(actions).toContain("list.create");
    expect(actions).toContain("member.add");
  });

  // ── Phase 1: the masked, keyset-paged members read path (GET /lists/:id/members) ───────────────────────
  test("listListMembers returns the list's MASKED members; a foreign/absent list 404s", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "members read",
    });
    await core.addContactsToList({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      contactIds: [contactA1, contactA2],
    });

    const page = await core.listListMembers({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      limit: 100,
    });
    const ids = page.members.map((m) => m.id).sort();
    expect(ids).toEqual([contactA1, contactA2].sort());
    // Masked shape: the read carries non-PII facets only (no encrypted email/phone leaks through).
    const m = page.members.find((r) => r.id === contactA1);
    expect(m).toBeDefined();
    expect(m).not.toHaveProperty("emailEnc");
    expect(m).not.toHaveProperty("phoneEnc");
    expect(typeof m?.hasEmail).toBe("boolean");
    expect(typeof m?.hasPhone).toBe("boolean");

    // Workspace B can never read an A list's members (RLS scopes findById to B → 404, no existence leak).
    const bRead = await caught(() =>
      core.listListMembers({ scope: scopeB(), callerUserId: ownerB, listId: list.id, limit: 100 }),
    );
    expect(bRead.code).toBe("not_found");
  });

  test("listListMembers keyset-paginates: limit 1 yields a cursor that walks the remaining members", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "paged members",
    });
    await core.addContactsToList({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      contactIds: [contactA1, contactA2],
    });

    const first = await core.listListMembers({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      limit: 1,
    });
    expect(first.members).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await core.listListMembers({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.members).toHaveLength(1);
    // The two pages cover both members with no overlap, and the keyset terminates (no third page).
    const seen = [...first.members, ...second.members].map((r) => r.id).sort();
    expect(seen).toEqual([contactA1, contactA2].sort());
    expect(second.nextCursor).toBeNull();
  });
});

// ── Phase 2: upload-your-own-data → list (list-plan/03 §2.2) ──────────────────────────────────────────────
// Importing rows with a target listId lands members with added_via='import' + a non-null source_import_id;
// dedup/idempotency are respected at the membership layer; and a cross-workspace listId is rejected.
describe("import into list — Phase 2 (list-plan/03 §2.2)", () => {
  // Mirrors the import.itest MAPPING/row shape: header → canonical field; one identity (email) per row.
  const MAPPING = { email: "Email", firstName: "First Name", accountDomain: "Domain" } as const;

  /** Read each list_members row's provenance (added_via + whether a source_imports id is linked). */
  async function memberProvenance(
    listId: string,
  ): Promise<{ contactId: string; addedVia: string; hasSourceImport: boolean }[]> {
    const rows = await admin`
      SELECT contact_id, added_via, (source_import_id IS NOT NULL) AS has_source_import
      FROM list_members WHERE list_id = ${listId} ORDER BY contact_id`;
    return (rows as { contact_id: string; added_via: string; has_source_import: boolean }[]).map(
      (r) => ({
        contactId: r.contact_id,
        addedVia: r.added_via,
        hasSourceImport: r.has_source_import,
      }),
    );
  }

  test("imported rows land as members with added_via='import' + a non-null source_import_id", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "import target",
    });
    const summary = await core.runImport({
      scope: scopeA(),
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "leads.csv",
      mapping: MAPPING,
      target: { listId: list.id },
      rows: [
        { Email: "ada@northwind.test", "First Name": "Ada", Domain: "northwind.test" },
        { Email: "bo@northwind.test", "First Name": "Bo", Domain: "northwind.test" },
      ],
    });
    expect(summary.created).toBe(2);
    expect(summary.addedToList).toBe(2); // both landed rows became NEW members

    const prov = await memberProvenance(list.id);
    expect(prov).toHaveLength(2);
    // Every member carries the import provenance: added_via='import' AND a linked source_imports row.
    for (const p of prov) {
      expect(p.addedVia).toBe("import");
      expect(p.hasSourceImport).toBe(true);
    }
  });

  test("re-importing the same file adds no new members (idempotent at both contact + membership layers)", async () => {
    const list = await core.createList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "idempotent import",
    });
    const rows = [{ Email: "cy@northwind.test", "First Name": "Cy", Domain: "northwind.test" }];
    const first = await core.runImport({
      scope: scopeA(),
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "again.csv",
      mapping: MAPPING,
      target: { listId: list.id },
      rows,
    });
    expect(first.created).toBe(1);
    expect(first.addedToList).toBe(1);

    // Same payload again: the content-hash short-circuits the contact write (skipped) AND the membership is
    // ON CONFLICT DO NOTHING — so nothing new is added the second time.
    const second = await core.runImport({
      scope: scopeA(),
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "again.csv",
      mapping: MAPPING,
      target: { listId: list.id },
      rows,
    });
    expect(second.skipped).toBe(1);
    expect(second.addedToList).toBe(0); // the contact was already a member
    expect(await memberContactIds(list.id)).toHaveLength(1); // still exactly one member
    // The member still carries import provenance (it was added by the FIRST import).
    expect((await memberProvenance(list.id))[0]?.addedVia).toBe("import");
  });

  test("a cross-workspace listId is rejected: an A-workspace import into a B list lands nothing in B", async () => {
    const bList = await core.createList({
      scope: scopeB(),
      callerUserId: ownerB,
      name: "B-owned list",
    });
    // Workspace A tries to import targeting workspace B's list — findById is RLS-scoped to A, so the list is
    // invisible and the whole import fails fast (the client list id is never trusted; list-plan D4).
    const err = await caught(() =>
      core.runImport({
        scope: scopeA(),
        importedByUserId: ownerA,
        sourceName: "manual",
        mapping: MAPPING,
        target: { listId: bList.id },
        rows: [{ Email: "mallory@northwind.test", "First Name": "Mal", Domain: "northwind.test" }],
      }),
    );
    expect(err.code).toBe("not_found"); // NotFoundError — the same guard the manual add path uses
    // B's list never gained a member, and A never imported the row into B.
    expect(await memberContactIds(bList.id)).toEqual([]);
  });
});

// ── Phase 4: dynamic / saved-search lists (list-plan/04, 09) ─────────────────────────────────────────────
describe("dynamic lists — Phase 4 (saved-search-backed)", () => {
  // A broad saved search (no filters) matches every workspace contact, so a dynamic list backed by it
  // resolves to them on read — with nothing materialized in list_members.
  const BROAD = { filters: [] } as const;

  test("a dynamic list resolves members from its saved query (workspace-scoped, masked, not materialized)", async () => {
    const saved = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "all A contacts",
      filters: BROAD,
      visibility: "private",
    });
    const list = await core.createDynamicList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "dynamic — all",
      savedSearchId: saved.id,
    });
    expect(list.kind).toBe("dynamic");
    expect(list.savedSearchId).toBe(saved.id);

    const page = await core.listListMembers({
      scope: scopeA(),
      callerUserId: ownerA,
      listId: list.id,
      limit: 100,
    });
    const ids = page.members.map((m) => m.id);
    expect(ids).toContain(contactA1);
    expect(ids).toContain(contactA2);
    expect(ids).not.toContain(contactB1); // RLS: B's contact never resolves in A

    // Membership is query-derived — no list_members rows are written for a dynamic list.
    const [matNone] =
      await admin`SELECT count(*)::int AS n FROM list_members WHERE list_id = ${list.id}`;
    expect((matNone as { n: number }).n).toBe(0);
  });

  test("SECURITY: a cross-workspace savedSearchId is rejected at create (the FK is not a workspace guard)", async () => {
    const savedA = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "A's search",
      filters: BROAD,
      visibility: "private",
    });
    // B tries to back a dynamic list with A's saved-search id → RLS hides it → NotFoundError (no leak).
    const err = await caught(() =>
      core.createDynamicList({
        scope: scopeB(),
        callerUserId: ownerB,
        name: "stolen query",
        savedSearchId: savedA.id,
      }),
    );
    expect(err.code).toBe("not_found");
    // No cross-workspace link was ever persisted.
    const [leak] = await admin`
      SELECT count(*)::int AS n FROM lists WHERE workspace_id = ${wsB} AND saved_search_id = ${savedA.id}`;
    expect((leak as { n: number }).n).toBe(0);
  });

  test("explicit member mutations on a dynamic list are rejected (membership is query-derived)", async () => {
    const saved = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "for guard",
      filters: BROAD,
      visibility: "private",
    });
    const list = await core.createDynamicList({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "no manual members",
      savedSearchId: saved.id,
    });
    const addErr = await caught(() =>
      core.addContactsToList({
        scope: scopeA(),
        callerUserId: ownerA,
        listId: list.id,
        contactIds: [contactA1],
      }),
    );
    expect(addErr.code).toBe("validation_error");
    const removeErr = await caught(() =>
      core.removeContactsFromList({
        scope: scopeA(),
        callerUserId: ownerA,
        listId: list.id,
        contactIds: [contactA1],
      }),
    );
    expect(removeErr.code).toBe("validation_error");
  });
});
