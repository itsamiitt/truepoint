// emailGovernance.itest.ts — M12 P6 governance (email-planning/13 P6, 06/11). Run in its OWN process. Proves:
//   (1) a GLOBAL suppression row (addGlobalSuppression — the audited platform path) blocks an enrollment via
//       the UNCHANGED M9 assertNotSuppressed — one row blocks across the tenant (D11);
//   (2) a DSAR contact ERASURE cascades across the email entities: outreach_log + activities are removed
//       (FK cascade) and email_event.contact_id is nulled (FK set null) — the contact is tombstoned.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type EnrollMod = typeof import("../../core/src/outreach/enrollContact.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let enrollMod: EnrollMod;
let tenantA = "";
let wsA = "";
let ownerA = "";
let sequenceId = "";

async function contactIdByDomain(d: string): Promise<string> {
  const [r] =
    await admin`SELECT id FROM contacts WHERE workspace_id = ${wsA} AND email_domain = ${d}`;
  return (r as { id: string }).id;
}
async function caught(run: () => Promise<unknown>): Promise<{ code?: string } & Error> {
  try {
    await run();
    throw new Error("expected a rejection");
  } catch (e) {
    return e as { code?: string } & Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("emailGovernance");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] =
    await admin`INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme','acme',10) RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  core = await import("../../core/src/index.ts");
  enrollMod = await import("../../core/src/outreach/enrollContact.ts");

  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: { email: "Email", firstName: "First Name", accountDomain: "Domain" },
    rows: [
      { Email: "jane@acme.com", "First Name": "Jane", Domain: "acme.com" },
      { Email: "mark@globex.com", "First Name": "Mark", Domain: "globex.com" },
    ],
  });
  for (const d of ["acme.com", "globex.com"]) {
    await core.revealContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      userId: ownerA,
      contactId: await contactIdByDomain(d),
      revealType: "email",
    });
  }
  const seq = await core.createSequence({
    scope: { tenantId: tenantA, workspaceId: wsA },
    userId: ownerA,
    name: "Q3",
    fromAddress: "sdr@acme.com",
    physicalAddress: "500 Howard St, SF",
  });
  sequenceId = seq.id;
  await core.addStep({
    scope: { tenantId: tenantA, workspaceId: wsA },
    userId: ownerA,
    sequenceId,
    subject: "Hi",
    body: "Hello",
  });
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M12 P6 email governance", () => {
  const scope = () => ({ tenantId: tenantA, workspaceId: wsA });

  test("addGlobalSuppression writes a global, tenant-less suppression row (audited platform path)", async () => {
    await core.addGlobalSuppression(
      { userId: ownerA },
      { domain: "acme.com", reason: "test_global" },
    );
    const [g] = await admin`
      SELECT count(*)::int AS n FROM suppression_list
      WHERE scope = 'global' AND domain = 'acme.com' AND tenant_id IS NULL AND workspace_id IS NULL`;
    expect((g as { n: number }).n).toBe(1);
    // And the platform action was audited.
    const [a] =
      await admin`SELECT count(*)::int AS n FROM platform_audit_log WHERE action = 'email.global_suppression.add'`;
    expect((a as { n: number }).n).toBe(1);
  });

  test("the global suppression refuses the acme contact at the enroll gate (unchanged M9 gate)", async () => {
    const jane = await contactIdByDomain("acme.com");
    const err = await caught(() =>
      enrollMod.enrollContact({ scope: scope(), userId: ownerA, sequenceId, contactId: jane }),
    );
    expect(err.code).toBe("suppressed");
  });

  test("a DSAR contact erasure cascades across the email entities", async () => {
    const mark = await contactIdByDomain("globex.com"); // not globally suppressed
    const enrolled = await enrollMod.enrollContact({
      scope: scope(),
      userId: ownerA,
      sequenceId,
      contactId: mark,
    });
    // Seed a tracking event + a timeline activity for mark.
    await core.ingestTrackingEvent(scope(), {
      type: "open",
      contactId: mark,
      outreachLogId: enrolled.logId,
      providerEventId: `open:${enrolled.logId}`,
    });

    // Pre-conditions present.
    const [pre] =
      await admin`SELECT count(*)::int AS n FROM outreach_log WHERE contact_id = ${mark}`;
    expect((pre as { n: number }).n).toBe(1);

    // The DSAR erasure (the contact-delete the cascade fans out from).
    await admin`DELETE FROM contacts WHERE id = ${mark}`;

    // outreach_log + activities are CASCADE-removed; email_event survives with contact_id NULLed (SET NULL).
    const [logN] =
      await admin`SELECT count(*)::int AS n FROM outreach_log WHERE contact_id = ${mark}`;
    expect((logN as { n: number }).n).toBe(0);
    const [actN] =
      await admin`SELECT count(*)::int AS n FROM activities WHERE contact_id = ${mark}`;
    expect((actN as { n: number }).n).toBe(0);
    const [evtNull] =
      await admin`SELECT count(*)::int AS n FROM email_event WHERE workspace_id = ${wsA} AND contact_id IS NULL AND event_type = 'open'`;
    expect((evtNull as { n: number }).n).toBe(1);
  });
});
