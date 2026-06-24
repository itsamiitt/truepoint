// listMembersDsarCascade.itest.ts — the Phase-5 DSAR-cascade Definition-of-Done for list membership
// (list-plan/08 §5.2 step 3, 08 §9 test #3, 07 gap #7, ADR-0021): person erasure must provably remove the
// subject's `list_members` rows across the workspace, so no list still references an erased person. Real
// Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL). Run in its OWN process:
//   `bun test ./packages/db/test/listMembersDsarCascade.itest.ts`
//
// Proves:
//   (1) the FK `list_members.contact_id → contacts.id` is ON DELETE CASCADE — DELETING a contact removes its
//       list_members rows automatically (the schema-level guarantee Deliverable 5 asks for);
//   (2) deleting a contact removes ONLY that contact's memberships (a co-member in the same list survives);
//   (3) the LIVE DSAR fan-out (core.deleteFanout) — which TOMBSTONES the contact (deleted_at + nulled PII)
//       rather than DELETEing the row, so the FK cascade does NOT fire on its own — now SWEEPS list_members
//       explicitly (dsarRepository.purgeDependents, list-plan/08 §5.2 step 3): an erased person's memberships
//       are removed and the verification scan only completes once they are gone. This closes 07 gap #7.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;

let tenantA = "";
let wsA = "";
let ownerA = "";

async function seedUser(email: string): Promise<string> {
  const [u] = await admin`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
  return (u as { id: string }).id;
}

async function memberCountForContact(contactId: string): Promise<number> {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM list_members WHERE contact_id = ${contactId}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("listMembersDsarCascade");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme', 'acme', 10) RETURNING id`;
  tenantA = (t as { id: string }).id;
  ownerA = await seedUser("owner@acme.test");
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  core = await import("../../core/src/index.ts");
}, 240_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

async function seedContact(first: string, domain: string): Promise<string> {
  const [c] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, owner_user_id, first_name, email_domain)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, ${first}, ${domain}) RETURNING id`;
  return (c as { id: string }).id;
}

async function seedListWithMembers(name: string, contactIds: string[]): Promise<string> {
  const [l] = await admin`
    INSERT INTO lists (tenant_id, workspace_id, owner_user_id, name)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, ${name}) RETURNING id`;
  const listId = (l as { id: string }).id;
  for (const contactId of contactIds) {
    await admin`
      INSERT INTO list_members (tenant_id, workspace_id, list_id, contact_id, added_by_user_id)
      VALUES (${tenantA}, ${wsA}, ${listId}, ${contactId}, ${ownerA})`;
  }
  return listId;
}

describe("Phase-5 DSAR cascade over list membership (list-plan/08 §5.2, ADR-0021)", () => {
  test("deleting a contact CASCADE-removes its list_members rows (FK ON DELETE CASCADE)", async () => {
    const c = await seedContact("Cascade", "cascade.test");
    const listId = await seedListWithMembers("cascade list", [c]);
    // The contact is a member in two lists — both memberships must go when the contact is deleted.
    const list2 = await seedListWithMembers("cascade list 2", [c]);
    expect(await memberCountForContact(c)).toBe(2);

    // Person erasure at the schema level = DELETE the contacts row → the FK cascade removes every membership.
    await admin`DELETE FROM contacts WHERE id = ${c}`;

    expect(await memberCountForContact(c)).toBe(0); // every membership removed
    const [remaining] = await admin`
      SELECT count(*)::int AS n FROM list_members WHERE list_id IN (${listId}, ${list2})`;
    expect((remaining as { n: number }).n).toBe(0); // the lists no longer reference the erased person
  });

  test("the cascade removes ONLY the erased contact's memberships (a co-member survives)", async () => {
    const erased = await seedContact("Erased", "erased.test");
    const kept = await seedContact("Kept", "kept.test");
    const listId = await seedListWithMembers("mixed list", [erased, kept]);
    expect(await memberCountForContact(erased)).toBe(1);
    expect(await memberCountForContact(kept)).toBe(1);

    await admin`DELETE FROM contacts WHERE id = ${erased}`;

    expect(await memberCountForContact(erased)).toBe(0); // erased subject's membership gone
    const remaining = (await admin`
      SELECT contact_id FROM list_members WHERE list_id = ${listId}`) as { contact_id: string }[];
    expect(remaining).toHaveLength(1); // exactly one membership survives (catches an under-delete)
    expect(remaining[0]!.contact_id).toBe(kept); // and it is the co-member, untouched
  });

  test("the live DSAR fan-out SWEEPS list_members on person erasure (07 gap #7 closed, list-plan/08 §5.2)", async () => {
    // Build a real subject via the import pipeline so the fan-out can resolve it by blind index.
    await core.runImport({
      scope: { tenantId: tenantA, workspaceId: wsA },
      sourceName: "manual",
      mapping: {
        email: "Email",
        firstName: "First Name",
        accountName: "Company",
        accountDomain: "Domain",
      },
      rows: [
        { Email: "dsar@subj.test", "First Name": "Dee", Company: "Subj", Domain: "subj.test" },
      ],
    });
    const [contact] = await admin`
      SELECT id FROM contacts WHERE workspace_id = ${wsA} AND email_domain = 'subj.test' AND deleted_at IS NULL`;
    const contactId = (contact as { id: string }).id;
    await seedListWithMembers("dsar subject list", [contactId]);
    // A co-member in the same list must survive — the sweep is contact-scoped, not list-scoped.
    const coMember = await seedContact("CoMember", "comember.test");
    const sharedList = await seedListWithMembers("dsar shared list", [contactId, coMember]);
    expect(await memberCountForContact(contactId)).toBe(2);

    const requestId = await core.createDsarRequest("delete", "dsar@subj.test");
    const result = await core.deleteFanout(requestId, "dsar@subj.test");
    expect(result.copiesErased).toBe(1);
    expect(result.completed).toBe(true); // the scan counts list_members as a dependent → cannot complete dirty
    expect(result.verification.dependents).toBe(0);

    // The contact is tombstoned (deleted_at set, PII nulled) — and its list memberships are SWEPT, so no list
    // still references the erased person. The co-member is untouched.
    const [tomb] = await admin`SELECT deleted_at, first_name FROM contacts WHERE id = ${contactId}`;
    expect((tomb as { deleted_at: Date | null }).deleted_at).not.toBeNull();
    expect((tomb as { first_name: string | null }).first_name).toBeNull(); // PII nulled
    expect(await memberCountForContact(contactId)).toBe(0); // erased subject's memberships removed
    expect(await memberCountForContact(coMember)).toBe(1); // co-member survives
    const [shared] = await admin`
      SELECT contact_id FROM list_members WHERE list_id = ${sharedList}`;
    expect((shared as { contact_id: string }).contact_id).toBe(coMember);
  });
});
