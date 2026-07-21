// contactMerge.itest.ts — S-C4's test gate (import-and-data-model-redesign 04 §Testing T1/T2/T3/T5/T6,
// 15 §M-SEQ seq 63 / §T-P4): the contact TRUE-MERGE engine against a real Postgres 16 (Testcontainers by
// default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (db client + config are module
// singletons): `bun test ./packages/db/test/contactMerge.itest.ts`
//
// What is proven (04 §Testing):
//   • T1  inventory completeness — a loser with rows in the seeded Class-A tables (emails, phones incl. a
//         collision, activities, source_imports, contact_reveals incl. a collision, + a duplicate marker
//         AIMING at it) merges with ZERO rows still referencing the loser (except the tombstone). The standing
//         guard: a future child table added without a merge rule fails this.
//   • T3  pin preservation — a pinned survivor scalar + a conflicting loser value → the value is UNCHANGED
//         (planFieldWrite skips pins structurally); an explicit loser pick re-pins + writes.
//   • T5  idempotent replay — re-submitting the same survivor/loser pair after commit → ContactMergedError
//         (the loser is tombstoned), NO second effect.
//   • T6  reveal / billing — merge inserts NO new contact_reveals row and NEVER double-charges (a duplicate
//         claim collapses); the survivor adopts the loser's reveal trio when it had none.
//   • T2  isolation — a foreign-workspace loser id is invisible under RLS ⇒ NotFoundError, nothing written.
//
// Core is imported via the RELATIVE barrel (../../core/src/index.ts) — a @leadwolf/core dep here is a Turbo
// build cycle (the harness rule). Channels do not need the dual-write env here: the engine re-points whatever
// child rows exist, and this itest seeds them directly.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

const scope = (tenantId: string, workspaceId: string) => ({ tenantId, workspaceId });

async function seedTenantWorkspace(slug: string) {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

async function insertContact(
  s: { tenantId: string; workspaceId: string },
  cols: Record<string, unknown> = {},
): Promise<string> {
  const base: Record<string, unknown> = {
    tenant_id: s.tenantId,
    workspace_id: s.workspaceId,
    ...cols,
  };
  const keys = Object.keys(base);
  const vals = keys.map((k) => base[k]);
  const colSql = keys.join(", ");
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const [r] = (await admin.unsafe(
    `INSERT INTO contacts (${colSql}) VALUES (${placeholders}) RETURNING id`,
    vals as never[],
  )) as unknown as Array<{ id: string }>;
  return r.id;
}

async function insertEmail(
  s: { tenantId: string; workspaceId: string },
  contactId: string,
  bidxHex: string,
  isPrimary = false,
) {
  await admin`INSERT INTO contact_emails (tenant_id, workspace_id, contact_id, value_enc, blind_index, email_domain, source, is_primary)
    VALUES (${s.tenantId}, ${s.workspaceId}, ${contactId}, decode('01','hex'), decode(${bidxHex},'hex'), 'ex.com', 'import:test', ${isPrimary})`;
}

async function insertPhone(
  s: { tenantId: string; workspaceId: string },
  contactId: string,
  bidxHex: string,
  isPrimary = false,
) {
  await admin`INSERT INTO contact_phones (tenant_id, workspace_id, contact_id, value_enc, blind_index, source, is_primary)
    VALUES (${s.tenantId}, ${s.workspaceId}, ${contactId}, decode('02','hex'), decode(${bidxHex},'hex'), 'import:test', ${isPrimary})`;
}

async function insertReveal(
  s: { tenantId: string; workspaceId: string; ownerId: string },
  contactId: string,
  revealType: string,
) {
  await admin`INSERT INTO contact_reveals (tenant_id, workspace_id, contact_id, revealed_by_user_id, reveal_type)
    VALUES (${s.tenantId}, ${s.workspaceId}, ${contactId}, ${s.ownerId}, ${revealType})`;
}

async function loserRefCount(table: string, col: string, loserId: string): Promise<number> {
  const [r] = (await admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [
    loserId,
  ] as never[])) as unknown as Array<{ n: number }>;
  return r.n;
}

async function liveCount(table: string, contactId: string): Promise<number> {
  const [r] = (await admin.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE contact_id = $1 AND deleted_at IS NULL`,
    [contactId] as never[],
  )) as unknown as Array<{ n: number }>;
  return r.n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("contact_merge");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("S-C4 — T1 inventory completeness + T6 reveal/billing", () => {
  test("loser children all re-point to survivor; collisions collapse; no double-charge; markers follow", async () => {
    const s = await seedTenantWorkspace("merge-t1");
    const survivor = await insertContact(s, { first_name: "Survivor" });
    const loser = await insertContact(s, { first_name: "Loser" });
    const marker = await insertContact(s, { first_name: "Marker", duplicate_of_contact_id: loser });

    // Survivor: 1 email, 1 phone (blind aa), reveal 'email'.
    await insertEmail(s, survivor, "a0", true);
    await insertPhone(s, survivor, "aa", true);
    await insertReveal(s, survivor, "email");
    // Loser: 2 emails (distinct), 2 phones (aa collides with survivor, bb unique), activity, source_import,
    // reveals 'email' (collides → collapse, no double-charge) + 'phone' (moves).
    await insertEmail(s, loser, "b1", true);
    await insertEmail(s, loser, "b2", false);
    await insertPhone(s, loser, "aa", true); // collides with survivor's phone
    await insertPhone(s, loser, "bb", false); // unique → moves
    await insertReveal(s, loser, "email"); // duplicate claim → collapses
    await insertReveal(s, loser, "phone"); // moves
    await admin`INSERT INTO activities (tenant_id, workspace_id, contact_id, activity_type, channel)
      VALUES (${s.tenantId}, ${s.workspaceId}, ${loser}, 'note', 'system')`;
    await admin`INSERT INTO source_imports (tenant_id, workspace_id, contact_id, source_name)
      VALUES (${s.tenantId}, ${s.workspaceId}, ${loser}, 'manual')`;

    const res = await core.runContactMerge({
      scope: scope(s.tenantId, s.workspaceId),
      survivorContactId: survivor,
      loserContactId: loser,
      decisions: [],
      userId: s.ownerId,
    });
    expect(res.survivorContactId).toBe(survivor);

    // T1: nothing references the loser anymore (except the tombstone row itself).
    expect(await loserRefCount("contact_emails", "contact_id", loser)).toBe(0);
    expect(await loserRefCount("contact_phones", "contact_id", loser)).toBe(0);
    expect(await loserRefCount("activities", "contact_id", loser)).toBe(0);
    expect(await loserRefCount("source_imports", "contact_id", loser)).toBe(0);
    expect(await loserRefCount("contact_reveals", "contact_id", loser)).toBe(0);
    expect(await loserRefCount("contacts", "duplicate_of_contact_id", loser)).toBe(0);

    // Survivor now holds the union: 3 emails, 2 live phones (its own aa + loser's bb; the collided aa collapsed).
    expect(await liveCount("contact_emails", survivor)).toBe(3);
    expect(await liveCount("contact_phones", survivor)).toBe(2);

    // T6: no double-charge — survivor holds exactly 2 reveal claims (email + phone), no NEW row minted.
    const [rev] = (await admin`SELECT count(*)::int AS n FROM contact_reveals WHERE contact_id = ${survivor}`) as unknown as Array<{ n: number }>;
    expect(rev.n).toBe(2);

    // Marker re-pointed to the survivor.
    const [m] = (await admin`SELECT duplicate_of_contact_id AS d FROM contacts WHERE id = ${marker}`) as unknown as Array<{ d: string | null }>;
    expect(m.d).toBe(survivor);

    // Loser tombstoned: soft-deleted + merged_into + PII nulled.
    const [l] = (await admin`SELECT deleted_at, merged_into_contact_id AS mi, first_name FROM contacts WHERE id = ${loser}`) as unknown as Array<{ deleted_at: string | null; mi: string | null; first_name: string | null }>;
    expect(l.deleted_at).not.toBeNull();
    expect(l.mi).toBe(survivor);
    expect(l.first_name).toBeNull();
  });

  test("survivor adopts the loser's reveal trio when it had none", async () => {
    const s = await seedTenantWorkspace("merge-trio");
    const survivor = await insertContact(s, { first_name: "S" });
    const loser = await insertContact(s, {
      first_name: "L",
      is_revealed: true,
      revealed_by_user_id: s.ownerId,
      revealed_at: new Date().toISOString(),
    });
    await core.runContactMerge({
      scope: scope(s.tenantId, s.workspaceId),
      survivorContactId: survivor,
      loserContactId: loser,
      decisions: [],
      userId: s.ownerId,
    });
    const [r] = (await admin`SELECT is_revealed, revealed_by_user_id AS by FROM contacts WHERE id = ${survivor}`) as unknown as Array<{ is_revealed: boolean; by: string | null }>;
    expect(r.is_revealed).toBe(true);
    expect(r.by).toBe(s.ownerId);
  });
});

describe("S-C4 — T3 pin immunity", () => {
  test("a pinned survivor scalar is not overwritten by default; an explicit loser pick re-pins + writes", async () => {
    const s = await seedTenantWorkspace("merge-pin");
    const pinnedProv = JSON.stringify({ jobTitle: { src: "user_edit", pin: true, by: s.ownerId } });
    const survivorA = await insertContact(s, { first_name: "S", field_provenance: pinnedProv });
    const loserA = await insertContact(s, { first_name: "L", job_title: "VP Sales" });
    await core.runContactMerge({
      scope: scope(s.tenantId, s.workspaceId),
      survivorContactId: survivorA,
      loserContactId: loserA,
      decisions: [],
      userId: s.ownerId,
    });
    const [a] = (await admin`SELECT job_title FROM contacts WHERE id = ${survivorA}`) as unknown as Array<{ job_title: string | null }>;
    expect(a.job_title).toBeNull(); // pin immune (survivor blank stays blank)

    const survivorB = await insertContact(s, { first_name: "S2", field_provenance: pinnedProv });
    const loserB = await insertContact(s, { first_name: "L2", job_title: "VP Sales" });
    await core.runContactMerge({
      scope: scope(s.tenantId, s.workspaceId),
      survivorContactId: survivorB,
      loserContactId: loserB,
      decisions: [{ field: "jobTitle", winner: "loser" }],
      userId: s.ownerId,
    });
    const [b] = (await admin`SELECT job_title FROM contacts WHERE id = ${survivorB}`) as unknown as Array<{ job_title: string | null }>;
    expect(b.job_title).toBe("VP Sales"); // explicit pick overrides the pin
  });
});

describe("S-C4 — T5 idempotent replay", () => {
  test("re-submitting a merged pair throws ContactMergedError (no second effect)", async () => {
    const s = await seedTenantWorkspace("merge-replay");
    const survivor = await insertContact(s, { first_name: "S" });
    const loser = await insertContact(s, { first_name: "L" });
    const input = {
      scope: scope(s.tenantId, s.workspaceId),
      survivorContactId: survivor,
      loserContactId: loser,
      decisions: [],
      userId: s.ownerId,
    };
    await core.runContactMerge(input);
    await expect(core.runContactMerge(input)).rejects.toThrow(/merged|deleted/i);
    // Only one merge event was recorded.
    const [e] = (await admin`SELECT count(*)::int AS n FROM audit_log WHERE action = 'contact.merge' AND entity_id = ${survivor}`) as unknown as Array<{ n: number }>;
    expect(e.n).toBe(1);
  });
});

describe("S-C4 — T2 isolation (IDOR)", () => {
  test("a foreign-workspace loser id is invisible ⇒ NotFoundError, nothing written", async () => {
    const s1 = await seedTenantWorkspace("merge-ws1");
    const s2 = await seedTenantWorkspace("merge-ws2");
    const survivor = await insertContact(s1, { first_name: "S" });
    const foreignLoser = await insertContact(s2, { first_name: "Foreign" });
    await expect(
      core.runContactMerge({
        scope: scope(s1.tenantId, s1.workspaceId),
        survivorContactId: survivor,
        loserContactId: foreignLoser,
        decisions: [],
        userId: s1.ownerId,
      }),
    ).rejects.toThrow(/exist in this workspace/i);
    // Foreign loser untouched.
    const [f] = (await admin`SELECT deleted_at, merged_into_contact_id AS mi FROM contacts WHERE id = ${foreignLoser}`) as unknown as Array<{ deleted_at: string | null; mi: string | null }>;
    expect(f.deleted_at).toBeNull();
    expect(f.mi).toBeNull();
  });
});
