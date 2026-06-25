// sendGate.itest.ts — the M12 P1 send-gate proof on a real Postgres 16 (email-planning/13 P1, 13 §4). Run in
// its OWN process: `bun test ./packages/db/test/sendGate.itest.ts`. Proves dispatchOutreachSend — the gate
// that wraps the UNCHANGED M9 sendStep:
//   (1) REFUSES a send whose sending domain is not DNS-verified (D2/D3) — no message leaves, no log advance;
//   (2) once verified, SENDS via the resolved (dark) adapter and CONSUMES one unit of the per-tenant quota;
//   (3) REFUSES once the quota is exhausted (SendQuotaExceededError) without advancing the log;
//   (4) REFUSES a from-address with no connected mailbox (D2).
// It reuses the M9 import/reveal/sequence machinery exactly as outreach.itest.ts does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type SeqMod = typeof import("../../core/src/outreach/createSequence.ts");
type EnrollMod = typeof import("../../core/src/outreach/enrollContact.ts");
type DispatchMod = typeof import("../../core/src/email/dispatchOutreachSend.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let seqMod: SeqMod;
let enrollMod: EnrollMod;
let dispatchMod: DispatchMod;

let tenantA = "";
let wsA = "";
let ownerA = "";
let domainId = "";
let janeSeqId = "";
let janeLogId = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
const ROWS = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "mark@globex.com",
    "First Name": "Mark",
    "Last Name": "Roe",
    Company: "Globex",
    Domain: "globex.com",
  },
];

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

async function quotaUsed(): Promise<number> {
  const [r] = await admin`SELECT email_send_used AS u FROM tenants WHERE id = ${tenantA}`;
  return (r as { u: number }).u;
}

async function caught(run: () => Promise<unknown>): Promise<{ code?: string } & Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as { code?: string } & Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("sendGate");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance, email_send_quota, email_send_used)
    VALUES ('acme','acme',10,2,0) RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  core = await import("../../core/src/index.ts");
  seqMod = await import("../../core/src/outreach/createSequence.ts");
  enrollMod = await import("../../core/src/outreach/enrollContact.ts");
  dispatchMod = await import("../../core/src/email/dispatchOutreachSend.ts");

  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS,
  });
  await core.revealContact({
    scope: { tenantId: tenantA, workspaceId: wsA },
    userId: ownerA,
    contactId: await contactIdByDomain(wsA, "acme.com"),
    revealType: "email",
  });

  // A sending domain (starts UNVERIFIED) + a connected mailbox for the from-address, bound to it.
  const [d] = await admin`
    INSERT INTO sending_domain (tenant_id, domain, status) VALUES (${tenantA}, 'acme.com', 'pending')
    RETURNING id`;
  domainId = (d as { id: string }).id;
  await admin`
    INSERT INTO mailbox_integration
      (tenant_id, workspace_id, owner_user_id, provider, address, sending_domain_id, status)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, 'smtp', 'sdr@acme.com', ${domainId}, 'connected')`;

  // A 3-step sequence WITH the CAN-SPAM identity (so sendStep itself never blocks) — lets two sends reuse one log.
  const created = await seqMod.createSequence({
    scope: { tenantId: tenantA, workspaceId: wsA },
    userId: ownerA,
    name: "Q3 Founders",
    fromAddress: "sdr@acme.com",
    physicalAddress: "500 Howard St, San Francisco, CA 94105",
  });
  janeSeqId = created.id;
  for (let i = 0; i < 3; i++) {
    await seqMod.addStep({
      scope: { tenantId: tenantA, workspaceId: wsA },
      userId: ownerA,
      sequenceId: janeSeqId,
      subject: `Touch ${i + 1}`,
      body: `Hi Jane — touch ${i + 1}.`,
    });
  }
  const enrolled = await enrollMod.enrollContact({
    scope: { tenantId: tenantA, workspaceId: wsA },
    userId: ownerA,
    sequenceId: janeSeqId,
    contactId: await contactIdByDomain(wsA, "acme.com"),
  });
  janeLogId = enrolled.logId;
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M12 P1 send-gate (dispatchOutreachSend)", () => {
  const scope = () => ({ tenantId: tenantA, workspaceId: wsA });

  test("refuses while the sending domain is NOT DNS-verified (D2/D3) — nothing sends, quota untouched", async () => {
    const err = await caught(() =>
      dispatchMod.dispatchOutreachSend({ scope: scope(), logId: janeLogId }),
    );
    expect(err.code).toBe("validation_error");
    expect(String(err.message)).toContain("not DNS-verified");
    expect(await quotaUsed()).toBe(0);
    const [l] = await admin`SELECT current_step FROM outreach_log WHERE id = ${janeLogId}`;
    expect((l as { current_step: number }).current_step).toBe(0);
  });

  test("once verified, sends via the resolved adapter and consumes one quota unit", async () => {
    await admin`UPDATE sending_domain SET status = 'verified' WHERE id = ${domainId}`;
    const r1 = await dispatchMod.dispatchOutreachSend({ scope: scope(), logId: janeLogId });
    expect(r1.sent).toBe(true);
    expect(r1.step).toBe(1);
    expect(await quotaUsed()).toBe(1);
  });

  test("a second send consumes the second unit (quota now exhausted at 2/2)", async () => {
    const r2 = await dispatchMod.dispatchOutreachSend({ scope: scope(), logId: janeLogId });
    expect(r2.step).toBe(2);
    expect(await quotaUsed()).toBe(2);
  });

  test("refuses the next send over quota (SendQuotaExceededError) without advancing the log", async () => {
    const err = await caught(() =>
      dispatchMod.dispatchOutreachSend({ scope: scope(), logId: janeLogId }),
    );
    expect(err.code).toBe("send_quota_exceeded");
    expect(await quotaUsed()).toBe(2); // the over-cap send asserted BEFORE consuming — usage unchanged
    const [l] = await admin`SELECT current_step FROM outreach_log WHERE id = ${janeLogId}`;
    expect((l as { current_step: number }).current_step).toBe(2);
  });

  test("refuses a from-address with no connected mailbox (D2)", async () => {
    // A second sequence from an address with no connected mailbox; enroll the (revealed) mark.
    await core.revealContact({
      scope: scope(),
      userId: ownerA,
      contactId: await contactIdByDomain(wsA, "globex.com"),
      revealType: "email",
    });
    const seq = await seqMod.createSequence({
      scope: scope(),
      userId: ownerA,
      name: "Ghost",
      fromAddress: "ghost@acme.com", // no connected mailbox for this address
      physicalAddress: "500 Howard St, San Francisco, CA 94105",
    });
    await seqMod.addStep({
      scope: scope(),
      userId: ownerA,
      sequenceId: seq.id,
      subject: "Hi",
      body: "Hello.",
    });
    const enrolled = await enrollMod.enrollContact({
      scope: scope(),
      userId: ownerA,
      sequenceId: seq.id,
      contactId: await contactIdByDomain(wsA, "globex.com"),
    });
    const err = await caught(() =>
      dispatchMod.dispatchOutreachSend({ scope: scope(), logId: enrolled.logId }),
    );
    expect(err.code).toBe("validation_error");
    expect(String(err.message)).toContain("No connected mailbox");
  });
});
