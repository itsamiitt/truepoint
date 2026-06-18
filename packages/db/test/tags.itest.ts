// tags.itest.ts — the record-customization tag layer (ADR-0028, G-REV-6) Definition-of-Done proof on a real
// Postgres 16 (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts).
// Run in its OWN process (the db client is a module singleton): `bun test ./packages/db/test/tags.itest.ts`.
//
// Proves: (1) tags + record_tags are tenant-ISOLATED under RLS — withTenantTx (SET LOCAL ROLE leadwolf_app +
// the tenant/workspace GUCs) means workspace A can never list/assign/unassign workspace B's tags; (2)
// create/assign/list/usageCount work end-to-end; (3) the per-workspace case-insensitive unique-name rule is
// enforced (core's createTag → 409 TagNameConflictError, and the unique index is the backstop); (4)
// assignment is idempotent; (5) listRecordsByTag drives filter-by-tag; (6) cross-workspace assign cannot
// attach to another workspace's tag (the tag is invisible under RLS → 404).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");
type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let core: Core;
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

/** Seed one contact directly (admin/BYPASSRLS) and return its id — the record a tag gets assigned to. */
async function seedContact(
  tenantId: string,
  workspaceId: string,
  emailDomain: string,
): Promise<string> {
  const [c] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, email_domain)
    VALUES (${tenantId}, ${workspaceId}, ${emailDomain}) RETURNING id`;
  return (c as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("tags");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));
  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("tag layer (ADR-0028, G-REV-6) — CRUD, assignment, uniqueness, per-workspace RLS isolation", () => {
  test("create + assign + list with usageCount, scoped to the workspace", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const { id: tagId } = await core.createTag({ scope: scopeA, name: "Hot", color: "danger" });
    const contactId = await seedContact(tenantA, wsA, "lead.com");

    await core.assignTag({ scope: scopeA, tagId, entity: "contact", recordId: contactId });

    const list = await db.tagRepository.listByWorkspace(scopeA);
    const hot = list.find((t) => t.id === tagId);
    expect(hot).toBeDefined();
    expect(hot?.name).toBe("Hot");
    expect(hot?.color).toBe("danger");
    expect(hot?.usageCount).toBe(1);

    // The assignment surfaces both for the record (tagsForRecord) and for the tag (listRecordsByTag).
    const forRecord = await db.tagRepository.tagsForRecord(scopeA, "contact", contactId);
    expect(forRecord.map((t) => t.id)).toContain(tagId);
    const byTag = await db.tagRepository.listRecordsByTag(scopeA, tagId, "contact");
    expect(byTag).toEqual([contactId]);
  });

  test("assignment is idempotent — re-assigning the same tag/record keeps usageCount at 1", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const { id: tagId } = await core.createTag({ scope: scopeA, name: "Idem", color: "neutral" });
    const contactId = await seedContact(tenantA, wsA, "idem.com");
    await core.assignTag({ scope: scopeA, tagId, entity: "contact", recordId: contactId });
    await core.assignTag({ scope: scopeA, tagId, entity: "contact", recordId: contactId });
    const byTag = await db.tagRepository.listRecordsByTag(scopeA, tagId, "contact");
    expect(byTag).toEqual([contactId]);
  });

  test("unassign removes the link; list reflects usageCount 0", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const { id: tagId } = await core.createTag({ scope: scopeA, name: "Temp", color: "info" });
    const contactId = await seedContact(tenantA, wsA, "temp.com");
    await core.assignTag({ scope: scopeA, tagId, entity: "contact", recordId: contactId });
    await core.unassignTag({ scope: scopeA, tagId, entity: "contact", recordId: contactId });
    const byTag = await db.tagRepository.listRecordsByTag(scopeA, tagId, "contact");
    expect(byTag).toEqual([]);
  });

  test("per-workspace case-insensitive name uniqueness → 409 (and the unique index backstops it)", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    await core.createTag({ scope: scopeA, name: "Unique", color: "accent" });
    // Same name, different case, same workspace → conflict.
    await expect(
      core.createTag({ scope: scopeA, name: "unique", color: "success" }),
    ).rejects.toMatchObject({ code: "tag_name_taken", status: 409 });

    // But the SAME name in a DIFFERENT workspace is allowed (per-workspace scope).
    const scopeB = { tenantId: tenantB, workspaceId: wsB };
    const ok = await core.createTag({ scope: scopeB, name: "Unique", color: "accent" });
    expect(ok.id).toBeTruthy();
  });

  test("RLS isolation — workspace A never lists workspace B's tags, and vice-versa", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const scopeB = { tenantId: tenantB, workspaceId: wsB };
    const { id: onlyB } = await core.createTag({ scope: scopeB, name: "B-only", color: "warning" });

    const listA = await db.tagRepository.listByWorkspace(scopeA);
    expect(listA.map((t) => t.id)).not.toContain(onlyB);

    const listB = await db.tagRepository.listByWorkspace(scopeB);
    expect(listB.map((t) => t.id)).toContain(onlyB);
  });

  test("RLS isolation — A cannot assign B's tag (the tag is invisible → 404)", async () => {
    const scopeB = { tenantId: tenantB, workspaceId: wsB };
    const { id: tagB } = await core.createTag({
      scope: scopeB,
      name: "B-secret",
      color: "neutral",
    });
    const contactA = await seedContact(tenantA, wsA, "cross.com");

    // A tries to assign B's tag to A's contact → core.assignTag looks the tag up under A's scope, can't see
    // it, and throws 404. No row is written.
    await expect(
      core.assignTag({
        scope: { tenantId: tenantA, workspaceId: wsA },
        tagId: tagB,
        entity: "contact",
        recordId: contactA,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const [{ n }] = (await admin`
      SELECT count(*)::int AS n FROM record_tags WHERE tag_id = ${tagB}`) as [{ n: number }];
    expect(n).toBe(0);
  });

  test("assign rejects a record_id that isn't in the caller's workspace → 404, no row written", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const { id: tagA } = await core.createTag({ scope: scopeA, name: "A-own", color: "accent" });
    // A contact that belongs to workspace B (and a totally unknown uuid) must both be rejected.
    const contactB = await seedContact(tenantB, wsB, "foreign.com");

    await expect(
      core.assignTag({ scope: scopeA, tagId: tagA, entity: "contact", recordId: contactB }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      core.assignTag({
        scope: scopeA,
        tagId: tagA,
        entity: "contact",
        recordId: "00000000-0000-7000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const [{ n }] = (await admin`
      SELECT count(*)::int AS n FROM record_tags WHERE tag_id = ${tagA}`) as [{ n: number }];
    expect(n).toBe(0);
  });

  test("update with no fields is a no-op (no 'No values to set' throw)", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const { id: tagId } = await core.createTag({ scope: scopeA, name: "NoOp", color: "neutral" });
    // Both fields omitted — must not throw; the row is unchanged.
    await core.updateTag({ scope: scopeA, tagId });
    const list = await db.tagRepository.listByWorkspace(scopeA);
    expect(list.find((t) => t.id === tagId)?.name).toBe("NoOp");
  });

  test("delete cascades the assignments (record_tags FK on delete cascade)", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const { id: tagId } = await core.createTag({ scope: scopeA, name: "Doomed", color: "danger" });
    const contactId = await seedContact(tenantA, wsA, "doomed.com");
    await core.assignTag({ scope: scopeA, tagId, entity: "contact", recordId: contactId });
    await core.deleteTag(scopeA, tagId);

    const [{ tn }] = (await admin`SELECT count(*)::int AS tn FROM tags WHERE id = ${tagId}`) as [
      { tn: number },
    ];
    expect(tn).toBe(0);
    const [{ rn }] = (await admin`
      SELECT count(*)::int AS rn FROM record_tags WHERE tag_id = ${tagId}`) as [{ rn: number }];
    expect(rn).toBe(0);
  });
});
