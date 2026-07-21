// contactChannels.reconcile.itest.ts — S-CH5's test gate (import-and-data-model-redesign 05 §3.4/§5 §Testing,
// 15 §3 "permanent fixtures" / §T-P3): the PERMANENT CH-INV-1 reconcile / drift sweep against a real
// Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process
// (db client + config are module singletons):
// `bun test ./packages/db/test/contactChannels.reconcile.itest.ts`
//
// What is proven, per 05 §3.4:
//   1. FLAT WINS (read gate OFF): the shipped-writer coherence gap (doc 16 S-CH2 row) — flat overwritten to a
//      NEW value that landed as a SECONDARY while the child primary kept the OLD value — is repaired by an
//      atomic swap: the NEW-value row becomes the sole primary, byte-exact to flat (CH-INV-1 restored).
//   2. FLAT WINS: a flat-only grade change (status) refreshes the child primary in place.
//   3. FLAT WINS degenerate-1: flat present with NO child rows ⇒ the child primary is created from flat
//      (email bytes verbatim; phone re-derived — the backfill primitive), byte-exact.
//   4. Degenerate-2 (direction-independent): a child primary with a NULLED flat cache ⇒ flat re-projected from
//      the child (never nulls a real value).
//   5. CHILD WINS (read gate ON): a divergent flat is re-projected FROM the child primary — the child value
//      wins; the child row is untouched.
//   6. IDEMPOTENT: a second pass over a reconciled workspace repairs nothing (twice = once).
//   7. GATE-OFF: `channels_dual_write` off ⇒ gateOff, ZERO writes (the divergence is left exactly as found).
//
// Env posture mirrors contactChannels.readcutover.itest.ts: both env halves armed for the whole process
// (frozen config); the per-tenant flags drive the arms — FLAT tenant has channels_dual_write only (read gate
// OFF ⇒ flat wins), CHILD tenant has both (read gate ON ⇒ child wins). Core is imported via the RELATIVE
// barrel (../../core/src/index.ts) — a @leadwolf/core dep here is a Turbo build cycle.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

let tFlat = "";
let wsFlat = "";
let tChild = "";
let wsChild = "";
let tGate = "";
let wsGate = "";

const NEW_EMAIL = "jane.new@acme.com"; // already normalized (no plus-tag) ⇒ blindIndex(NEW_EMAIL) is its key
const MAPPING = { email: "Email", firstName: "First Name", phone: "Phone", locationCountry: "Country" };
const rowsFor = (slug: string) => [
  { Email: `jane@${slug}.com`, "First Name": "Jane", Phone: "(415) 555-2671", Country: "US" },
  { Email: `john@${slug}.com`, "First Name": "John", Phone: "", Country: "" },
  { Email: `uma@${slug}.com`, "First Name": "Uma", Phone: "555 0100", Country: "United States" },
];

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

async function enableFlag(tenantId: string, key: string) {
  await admin`INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled) VALUES (${key}, ${tenantId}, true)`;
}

async function importFlat(s: { tenantId: string; workspaceId: string }, ownerId: string, slug: string) {
  const res = await core.runImport({
    scope: s,
    importedByUserId: ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: rowsFor(slug),
  });
  expect(res.created).toBe(3);
}

async function contactId(workspaceId: string, name: string): Promise<string> {
  const [r] = await admin`SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND first_name = ${name}`;
  return (r as { id: string }).id;
}

async function primaryEmail(cId: string) {
  const rows = await admin`
    SELECT encode(value_enc,'hex') AS v, encode(blind_index,'hex') AS bi, status, is_primary
    FROM contact_emails WHERE contact_id = ${cId} AND is_primary AND deleted_at IS NULL`;
  return rows[0] as { v: string; bi: string; status: string } | undefined;
}

async function livePrimaryCount(cId: string): Promise<number> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM contact_emails WHERE contact_id = ${cId} AND is_primary AND deleted_at IS NULL`;
  return (r as { n: number }).n;
}

/** CH-INV-1's checkable form asserted IN SQL for one contact's email (ciphertext never decrypted here). */
async function emailCoherent(cId: string): Promise<boolean> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM contacts c
    JOIN contact_emails ce ON ce.contact_id = c.id AND ce.is_primary AND ce.deleted_at IS NULL
    WHERE c.id = ${cId}
      AND ce.value_enc = c.email_enc AND ce.blind_index = c.email_blind_index
      AND ce.email_domain = c.email_domain AND ce.status = c.email_status`;
  return (r as { n: number }).n === 1;
}

beforeAll(async () => {
  dbHandle = await startItestDb("contact_channels_reconcile");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.CHANNEL_DUAL_WRITE = "true";
  process.env.CHANNEL_READ_FROM_CHILD = "true"; // read gate ENV half; per-tenant channels_read drives the arm

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");

  // FLAT: dual-write on, read OFF (flat wins). CHILD: both on (child wins). GATE: dual-write on at import so
  // child rows exist, then flipped off before reconcile to prove the fail-closed abort.
  const f = await seedTenantWorkspace("rcf");
  tFlat = f.tenantId;
  wsFlat = f.workspaceId;
  await enableFlag(tFlat, "channels_dual_write");
  await importFlat(scope(tFlat, wsFlat), f.ownerId, "rcf");

  const c = await seedTenantWorkspace("rcc");
  tChild = c.tenantId;
  wsChild = c.workspaceId;
  await enableFlag(tChild, "channels_dual_write");
  await enableFlag(tChild, "channels_read");
  await importFlat(scope(tChild, wsChild), c.ownerId, "rcc");

  const g = await seedTenantWorkspace("rcg");
  tGate = g.tenantId;
  wsGate = g.workspaceId;
  await enableFlag(tGate, "channels_dual_write");
  await importFlat(scope(tGate, wsGate), g.ownerId, "rcg");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("S-CH5 flat-wins (read gate OFF) — the dual-write-era repair direction", () => {
  test("sets up divergence, reconciles once, and restores CH-INV-1 across every case", async () => {
    const janeId = await contactId(wsFlat, "Jane");
    const johnId = await contactId(wsFlat, "John");
    const umaId = await contactId(wsFlat, "Uma");

    // 1) THE COHERENCE GAP: flat overwritten to NEW_EMAIL (landed as a SECONDARY); child primary keeps old.
    const newEnc = Buffer.from(core.encryptPii(NEW_EMAIL));
    const newBi = Buffer.from(core.blindIndex(NEW_EMAIL));
    await admin`
      INSERT INTO contact_emails (tenant_id, workspace_id, contact_id, value_enc, blind_index, email_domain, type, is_primary, status, source)
      VALUES (${tFlat}, ${wsFlat}, ${janeId}, ${Buffer.from(core.encryptPii(NEW_EMAIL))}, ${newBi}, 'acme.com', 'other', false, 'unverified', 'user_edit')`;
    await admin`UPDATE contacts SET email_enc = ${newEnc}, email_blind_index = ${newBi}, email_domain = 'acme.com' WHERE id = ${janeId}`;

    // 2) FLAT-ONLY GRADE CHANGE: John's flat email graded 'risky'; child primary stays 'unverified'.
    await admin`UPDATE contacts SET email_status = 'risky' WHERE id = ${johnId}`;

    // 3) DEGENERATE-1: Uma's child rows deleted — flat present, no children.
    await admin`DELETE FROM contact_emails WHERE contact_id = ${umaId}`;
    await admin`DELETE FROM contact_phones WHERE contact_id = ${umaId}`;

    // 4) DEGENERATE-2: Jane's flat phone NULLED — a live primary child phone remains.
    await admin`UPDATE contacts SET phone_enc = NULL, phone_status = NULL, phone_line_type = NULL WHERE id = ${janeId}`;

    const res = await core.runChannelReconcileForWorkspace(scope(tFlat, wsFlat));
    expect(res.gateOff).toBe(false);
    expect(res.readGateOn).toBe(false); // flat wins
    expect(res.drained).toBe(true);
    // Flat-wins repairs dominate (swap + refresh + degenerate-1 create); the direction-INDEPENDENT
    // degenerate-2 (Jane's nulled flat phone) still projects flat FROM child, so it lands as one child-labelled
    // repair. Assert the repair SHAPE via SQL below rather than pinning the exact split.
    expect(res.flatWins).toBeGreaterThan(0);
    expect(res.emailsRepaired).toBe(3); // Jane swap · John refresh · Uma create
    expect(res.phonesRepaired).toBe(2); // Jane project-from-child · Uma create

    // 1) swap restored: exactly one primary, and it is the NEW-value row, byte-exact to flat.
    expect(await livePrimaryCount(janeId)).toBe(1);
    const jp = await primaryEmail(janeId);
    expect(jp?.bi).toBe(newBi.toString("hex"));
    expect(jp?.v).toBe(newEnc.toString("hex")); // primary value_enc == flat email_enc (CH-INV-1)
    expect(await emailCoherent(janeId)).toBe(true);

    // 2) refresh: John's child primary now mirrors the flat grade.
    expect((await primaryEmail(johnId))?.status).toBe("risky");
    expect(await emailCoherent(johnId)).toBe(true);

    // 3) degenerate-1: Uma's children recreated from flat, byte-exact; phone kept (unparseable, e164 NULL).
    expect(await emailCoherent(umaId)).toBe(true);
    const [uPhone] = await admin`
      SELECT (cp.value_enc = c.phone_enc) AS byte_equal, cp.e164_enc IS NOT NULL AS parsed, cp.is_primary
      FROM contacts c JOIN contact_phones cp ON cp.contact_id = c.id AND cp.deleted_at IS NULL
      WHERE c.id = ${umaId}`;
    expect((uPhone as { byte_equal: boolean }).byte_equal).toBe(true);
    expect((uPhone as { parsed: boolean }).parsed).toBe(false);
    expect((uPhone as { is_primary: boolean }).is_primary).toBe(true);

    // 4) degenerate-2: Jane's flat phone re-projected from the child primary (non-null again, byte-equal).
    const [jPhone] = await admin`
      SELECT (cp.value_enc = c.phone_enc) AS byte_equal, c.phone_enc IS NOT NULL AS flat_present
      FROM contacts c JOIN contact_phones cp ON cp.contact_id = c.id AND cp.is_primary AND cp.deleted_at IS NULL
      WHERE c.id = ${janeId}`;
    expect((jPhone as { flat_present: boolean }).flat_present).toBe(true);
    expect((jPhone as { byte_equal: boolean }).byte_equal).toBe(true);
  });

  test("idempotent: a second pass repairs nothing (twice = once)", async () => {
    const res = await core.runChannelReconcileForWorkspace(scope(tFlat, wsFlat));
    expect(res.gateOff).toBe(false);
    expect(res.emailsRepaired).toBe(0);
    expect(res.phonesRepaired).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.drained).toBe(true);
  });
});

describe("S-CH5 child-wins (read gate ON) — the post-cutover repair direction", () => {
  test("a divergent flat is re-projected FROM the child primary; the child value wins", async () => {
    const johnId = await contactId(wsChild, "John");
    // flat diverges (graded 'valid'); the child primary stays 'unverified'.
    await admin`UPDATE contacts SET email_status = 'valid' WHERE id = ${johnId}`;
    const childStatusBefore = (await primaryEmail(johnId))?.status;
    expect(childStatusBefore).toBe("unverified");

    const res = await core.runChannelReconcileForWorkspace(scope(tChild, wsChild));
    expect(res.gateOff).toBe(false);
    expect(res.readGateOn).toBe(true); // child wins
    expect(res.childWins).toBeGreaterThan(0);

    // Flat adopted the CHILD's grade (child won); the child row is untouched.
    const [c] = await admin`SELECT email_status FROM contacts WHERE id = ${johnId}`;
    expect((c as { email_status: string }).email_status).toBe("unverified");
    expect((await primaryEmail(johnId))?.status).toBe("unverified");
    expect(await emailCoherent(johnId)).toBe(true);
  });
});

describe("S-CH5 gate — fail-closed tenant selection IS the batch-boundary abort", () => {
  test("channels_dual_write off ⇒ gateOff, zero writes (divergence left exactly as found)", async () => {
    const janeId = await contactId(wsGate, "Jane");
    await admin`UPDATE contacts SET email_status = 'risky' WHERE id = ${janeId}`;
    // Flip dual-write OFF for this tenant AFTER the divergence exists.
    await admin`UPDATE tenant_feature_flags SET enabled = false WHERE flag_key = 'channels_dual_write' AND tenant_id = ${tGate}`;

    const res = await core.runChannelReconcileForWorkspace(scope(tGate, wsGate));
    expect(res.gateOff).toBe(true);
    expect(res.batches).toBe(0);
    expect(res.scanned).toBe(0);
    // The child primary is untouched (flat 'risky' vs child 'unverified' still divergent).
    expect((await primaryEmail(janeId))?.status).toBe("unverified");
  });
});
