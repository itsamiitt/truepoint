// jobChangeAlerts.itest.ts — the Phase 4 producer: a job-change verdict becomes an intent_signal plus alerts
// to the users who SAVED the contact (S-13 "minimize the time between a saved contact changing jobs and the
// seller learning about it").
//
// Two properties need a real database. The watcher query is a lateral over lists + list_members, and its
// failure modes are both silent: too NARROW and the person who will actually waste the call never hears;
// too WIDE and a job change becomes a workspace-wide broadcast, which is how an alert channel turns into
// noise nobody reads — and S-13's entire value is in being read.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");
// Core via the RELATIVE barrel, not @leadwolf/core: packages/db must not depend on core (Turbo cycle) —
// the same idiom contactMerge.itest.ts uses and documents.
type CoreModule = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let core: CoreModule;

let tenantId = "";
let wsId = "";
let owner = "";
let adder = "";
let bystander = "";
let contactId = "";
let unsavedContactId = "";

const MOVED = {
  changed: true as const,
  kind: "moved" as const,
  confidence: 0.9,
  priorConfidence: 0.3,
  reason: "new_claim_stronger" as const,
};

async function makeUser(email: string): Promise<string> {
  const [u] = await admin`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
  const id = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id) VALUES (${tenantId}, ${id})`;
  return id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("jobChangeAlerts");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`;
  tenantId = (t as { id: string }).id;
  owner = await makeUser("owner@acme.test");
  await admin`UPDATE tenant_members SET is_tenant_owner = true WHERE user_id = ${owner}`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${owner}) RETURNING id`;
  wsId = (w as { id: string }).id;
  adder = await makeUser("adder@acme.test");
  bystander = await makeUser("bystander@acme.test");

  const mk = async (name: string) => {
    const [c] = await admin`
      INSERT INTO contacts (tenant_id, workspace_id, first_name) VALUES (${tenantId}, ${wsId}, ${name})
      RETURNING id`;
    return (c as { id: string }).id;
  };
  contactId = await mk("Saved");
  unsavedContactId = await mk("Unsaved");

  // A list OWNED by `owner`, with the contact added by a DIFFERENT user.
  const [l] = await admin`
    INSERT INTO lists (tenant_id, workspace_id, owner_user_id, name)
    VALUES (${tenantId}, ${wsId}, ${owner}, 'Target accounts') RETURNING id`;
  await admin`
    INSERT INTO list_members (tenant_id, workspace_id, list_id, contact_id, added_by_user_id)
    VALUES (${tenantId}, ${wsId}, ${(l as { id: string }).id}, ${contactId}, ${adder})`;

  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scope = () => ({ tenantId, workspaceId: wsId });

describe("job-change alerts", () => {
  test("notifies the list owner AND the person who added the contact — but nobody else", async () => {
    // Both, and the second is the point: the rep who researched the prospect is the one who will waste the
    // call, but the list belongs to their manager. Owner-only would send it to the person least able to act.
    const res = await dbmod.withTenantTx(scope(), (tx) =>
      core.recordJobChange(tx, {
        scope: scope(),
        contactId,
        contactLabel: "Saved",
        newCompanyName: "Globex",
        verdict: MOVED,
      }),
    );
    expect(res.signalRecorded).toBe(true);
    expect(res.notified).toBe(2);

    const rows = await admin`
      SELECT user_id, title, entity_id FROM notifications
       WHERE type = 'job_change' AND entity_id = ${contactId} ORDER BY user_id`;
    const notifiedUsers = new Set(rows.map((r) => (r as { user_id: string }).user_id));
    expect(notifiedUsers.has(owner)).toBe(true);
    expect(notifiedUsers.has(adder)).toBe(true);
    // A workspace member who never saved this contact must NOT be told. Broadcasting is how the channel dies.
    expect(notifiedUsers.has(bystander)).toBe(false);
    expect((rows[0] as { title: string }).title).toContain("Globex");
  });

  test("the signal is recorded with a weight derived from confidence", async () => {
    const [s] = await admin`
      SELECT signal_type, detail, weight FROM intent_signals WHERE contact_id = ${contactId}`;
    expect((s as { signal_type: string }).signal_type).toBe("job_change");
    expect((s as { detail: string }).detail).toBe("moved");
    // A change we are 90% sure of must not push scoring like one we are 50% sure of.
    expect((s as { weight: number }).weight).toBe(9);
  });

  test("re-detecting the same change does not notify twice", async () => {
    // The sweep re-runs. Without entity-keyed dedup a user gets the same alert every tick, which trains them
    // to ignore the channel entirely.
    const res = await dbmod.withTenantTx(scope(), (tx) =>
      core.recordJobChange(tx, {
        scope: scope(),
        contactId,
        contactLabel: "Saved",
        newCompanyName: "Globex",
        verdict: MOVED,
      }),
    );
    expect(res.notified).toBe(0);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM notifications WHERE type = 'job_change' AND entity_id = ${contactId}`;
    expect((n as { n: number }).n).toBe(2);
  });

  test("a contact nobody saved still records the signal, and alerts no one", async () => {
    // The fact is true regardless of the audience — and someone may save this contact tomorrow and want the
    // history. Skipping the signal because nobody is watching would lose it permanently.
    const res = await dbmod.withTenantTx(scope(), (tx) =>
      core.recordJobChange(tx, {
        scope: scope(),
        contactId: unsavedContactId,
        contactLabel: "Unsaved",
        verdict: { ...MOVED, kind: "departed" },
      }),
    );
    expect(res.signalRecorded).toBe(true);
    expect(res.notified).toBe(0);
    const [s] = await admin`
      SELECT count(*)::int AS n FROM intent_signals WHERE contact_id = ${unsavedContactId}`;
    expect((s as { n: number }).n).toBe(1);
  });

  test("a title change records a signal but sends no alert", async () => {
    const res = await dbmod.withTenantTx(scope(), (tx) =>
      core.recordJobChange(tx, {
        scope: scope(),
        contactId,
        contactLabel: "Saved",
        verdict: { ...MOVED, kind: "title_change" },
      }),
    );
    expect(res.signalRecorded).toBe(true);
    expect(res.notified).toBe(0);
  });

  test("a non-change writes nothing at all", async () => {
    const before = await admin`SELECT count(*)::int AS n FROM intent_signals`;
    const res = await dbmod.withTenantTx(scope(), (tx) =>
      core.recordJobChange(tx, {
        scope: scope(),
        contactId,
        contactLabel: "Saved",
        verdict: { changed: false, kind: null, confidence: 0.9, priorConfidence: 0.9, reason: "prior_stronger" },
      }),
    );
    expect(res.signalRecorded).toBe(false);
    const after = await admin`SELECT count(*)::int AS n FROM intent_signals`;
    expect((after[0] as { n: number }).n).toBe((before[0] as { n: number }).n);
  });
});
