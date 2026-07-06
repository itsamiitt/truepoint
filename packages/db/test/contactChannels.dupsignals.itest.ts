// contactChannels.dupsignals.itest.ts — S-C6's test gate (import-and-data-model-redesign 04 §2 act layer,
// 15 §M-SEQ seq 50 / §T-P3 test T7): the MATCH-vs-ACT split at match time, against a real Postgres 16
// (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (db client +
// config are module singletons): `bun test ./packages/db/test/contactChannels.dupsignals.itest.ts`
//
// What is proven (T7, the reachable half — 04 §2 / §Testing):
//   1. PHONE-SIGNAL-ONLY MATCH → MARKER, NO UPSERT, NO BLOCK: a NEW contact whose phone E.164 matches an
//      existing contact (phone is a dedup key NOWHERE — shared lines legal, 05 §2.2) LANDS as its own row
//      (never merged/blocked), keeps its OWN phone child row (the phone is dual-written, NOT upserted onto the
//      other contact), and gets a duplicate_of_contact_id SUGGESTION toward the signalled contact.
//   2. NO FALSE SIGNAL: a contact with a UNIQUE phone gets no marker.
//   3. MARKER GUARD (never an act): the suggestion is written ONLY when the contact has no existing pointer —
//      a pre-existing duplicate_of_contact_id (e.g. the dedup sweep's) is never clobbered.
//   4. RIDES THE S-CH4 READ GATE (15 seq 50): with channels_read OFF (dual-write still on ⇒ child rows
//      identical), the SAME phone-collision import writes NO marker — byte-identical to the pre-S-C6 path.
//
// The cross-key EMAIL-collision branch (05 §2.2) is forward-wiring for the multi-email mapping increment
// (15 seq 52): under single-email import with the read gate ON, the email rung ALWAYS resolves a live value to
// its owner (findByDedupKeys child rung), so the applyChannelWrite `collision` outcome is unreachable here —
// exercised when additionalEmails land. This itest covers the reachable phone path end-to-end.
//
// Core is imported via the RELATIVE barrel (../../core/src/index.ts) — a @leadwolf/core dep is a Turbo cycle.

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

const MAPPING = { email: "Email", firstName: "First Name", phone: "Phone", locationCountry: "Country" };
const SHARED_PHONE = "(415) 555-2671"; // Alice + Bob share this switchboard line (legal — a review signal)
const UNIQUE_PHONE = "(212) 555-9000";

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

async function enableFlag(tenantId: string, key: string) {
  await admin`INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled) VALUES (${key}, ${tenantId}, true)`;
}

async function contactIdByName(workspaceId: string, firstName: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND first_name = ${firstName}`;
  return (r as { id: string }).id;
}

async function dupPointer(contactId: string): Promise<string | null> {
  const [r] = await admin`SELECT duplicate_of_contact_id FROM contacts WHERE id = ${contactId}`;
  return (r as { duplicate_of_contact_id: string | null }).duplicate_of_contact_id;
}

async function livePhoneCount(contactId: string): Promise<number> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM contact_phones WHERE contact_id = ${contactId} AND deleted_at IS NULL`;
  return (r as { n: number }).n;
}

/** Import one row (its own runImport) with the given fields — overwrite policy so a no-match row is created. */
async function importOne(
  s: { tenantId: string; workspaceId: string; ownerId: string },
  row: Record<string, string>,
) {
  return core.runImport({
    scope: scope(s.tenantId, s.workspaceId),
    importedByUserId: s.ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: [row],
  });
}

beforeAll(async () => {
  dbHandle = await startItestDb("contact_channels_dupsignals");
  // env BEFORE the config/db singletons load (frozen config). Both env halves armed; per-tenant flags drive on/off.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.CHANNEL_DUAL_WRITE = "true";
  process.env.CHANNEL_READ_FROM_CHILD = "true";

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

describe("S-C6 §2 — phone-signal-only match: marker written, no upsert, no block (T7)", () => {
  test("a new contact sharing a phone is created, keeps its own phone, and is flagged duplicate_of the holder", async () => {
    const s = await seedTenantWorkspace("dsig-on");
    await enableFlag(s.tenantId, "channels_dual_write"); // child rows written
    await enableFlag(s.tenantId, "channels_read"); // read gate ON ⇒ S-C6 signals armed

    // Alice lands first, holding the shared switchboard line.
    const a = await importOne(s, {
      Email: "alice@acme.com",
      "First Name": "Alice",
      Phone: SHARED_PHONE,
      Country: "US",
    });
    expect(a.created).toBe(1);
    const aliceId = await contactIdByName(s.workspaceId, "Alice");

    // Bob: a DIFFERENT person (new email, no shared identity key) carrying the SAME phone.
    const b = await importOne(s, {
      Email: "bob@other.com",
      "First Name": "Bob",
      Phone: SHARED_PHONE,
      Country: "US",
    });
    // NOT blocked, NOT merged: Bob is created as his own row.
    expect(b.created).toBe(1);
    expect(b.duplicates).toBe(0);
    const bobId = await contactIdByName(s.workspaceId, "Bob");
    expect(bobId).not.toBe(aliceId);

    // Bob keeps his OWN phone child row (dual-written onto Bob, NOT upserted onto Alice — phones are per-contact).
    expect(await livePhoneCount(bobId)).toBe(1);
    expect(await livePhoneCount(aliceId)).toBe(1);

    // The only side effect: a duplicate_of_contact_id SUGGESTION on Bob toward the signalled holder Alice.
    expect(await dupPointer(bobId)).toBe(aliceId);
    expect(await dupPointer(aliceId)).toBeNull(); // the holder is untouched
  });

  test("a unique phone raises no signal", async () => {
    const s = await seedTenantWorkspace("dsig-uniq");
    await enableFlag(s.tenantId, "channels_dual_write");
    await enableFlag(s.tenantId, "channels_read");
    await importOne(s, { Email: "carol@acme.com", "First Name": "Carol", Phone: UNIQUE_PHONE, Country: "US" });
    const carolId = await contactIdByName(s.workspaceId, "Carol");
    expect(await dupPointer(carolId)).toBeNull();
  });
});

describe("S-C6 — the suggestion is a guard, never an act (markDuplicateSuggestion)", () => {
  test("only-when-null + non-self: never clobbers an existing pointer, never self-references", async () => {
    const s = await seedTenantWorkspace("dsig-guard");
    await enableFlag(s.tenantId, "channels_dual_write");
    // Three distinct contacts (unique phones ⇒ no import-time signal muddies the setup).
    await importOne(s, { Email: "dan@acme.com", "First Name": "Dan", Phone: "(303) 555-0001", Country: "US" });
    await importOne(s, { Email: "erin@acme.com", "First Name": "Erin", Phone: "(303) 555-0002", Country: "US" });
    await importOne(s, { Email: "fran@acme.com", "First Name": "Fran", Phone: "(303) 555-0003", Country: "US" });
    const danId = await contactIdByName(s.workspaceId, "Dan");
    const erinId = await contactIdByName(s.workspaceId, "Erin");
    const franId = await contactIdByName(s.workspaceId, "Fran");

    const call = (contactId: string, canonicalId: string) =>
      db.withTenantTx(scope(s.tenantId, s.workspaceId), (tx) =>
        db.contactRepository.markDuplicateSuggestion(tx, contactId, canonicalId),
      );

    expect(await call(erinId, danId)).toBe(true); // first pointer wins
    expect(await dupPointer(erinId)).toBe(danId);
    expect(await call(erinId, franId)).toBe(false); // already pointed → NOT clobbered
    expect(await dupPointer(erinId)).toBe(danId);
    expect(await call(franId, franId)).toBe(false); // self-reference refused
    expect(await dupPointer(franId)).toBeNull();
  });
});

describe("S-C6 §R-P3 — rides the S-CH4 read gate: gate-off writes no marker", () => {
  test("with channels_read OFF (dual-write on), a phone-collision import writes NO suggestion", async () => {
    const s = await seedTenantWorkspace("dsig-off");
    await enableFlag(s.tenantId, "channels_dual_write"); // child rows STILL written (identical data)
    // channels_read deliberately NOT enabled ⇒ read gate OFF ⇒ S-C6 signals disarmed.
    await importOne(s, { Email: "fay@acme.com", "First Name": "Fay", Phone: SHARED_PHONE, Country: "US" });
    await importOne(s, { Email: "gus@other.com", "First Name": "Gus", Phone: SHARED_PHONE, Country: "US" });
    const gusId = await contactIdByName(s.workspaceId, "Gus");
    // Gus still has his own phone child (dual-write on) but NO marker (read gate off) — byte-identical pre-S-C6.
    expect(await livePhoneCount(gusId)).toBe(1);
    expect(await dupPointer(gusId)).toBeNull();
  });
});
