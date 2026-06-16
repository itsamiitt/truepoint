// outreach.itest.ts — the M9 Definition-of-Done proof on a real Postgres 16 (10/14 §3.5): Testcontainers
// by default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Run in its OWN process (the
// db client is a module singleton): `bun test ./packages/db/test/outreach.itest.ts`. The M9 core fns are
// imported by direct path (not yet on the @leadwolf/core barrel); existing core (runImport/revealContact)
// comes through the barrel.
//
// Proves (05 §13, 08 §3/§6, ADR-0009, ADR-0013): (1) create sequence + step + enroll a REVEALED contact →
// membership, outreach_status rollup, audits; (2) sending without the CAN-SPAM identity is BLOCKED at the
// send tx; (3) with it set, the send auto-appends the postal-address+unsubscribe footer and advances the
// log; (4) unrevealed contacts cannot enroll; (5) suppressed contacts are refused at the enroll gate;
// (6) enrollment is idempotent; (7) a hard bounce marks the log, auto-suppresses, and credits the charged
// reveal back (balance returns to 10); (8) the suppression row then blocks the NEXT send (the H5 send gate).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type SequenceModule = typeof import("../../core/src/outreach/createSequence.ts");
type EnrollModule = typeof import("../../core/src/outreach/enrollContact.ts");
type SendModule = typeof import("../../core/src/outreach/sendStep.ts");
type BounceModule = typeof import("../../core/src/outreach/handleBounce.ts");
type SenderModule = typeof import("../../core/src/outreach/senderPort.ts");
type OutboundEmail = import("../../core/src/outreach/senderPort.ts").OutboundEmail;

let dbHandle: ItestDb;
let core: Core;
let seqMod: SequenceModule;
let enrollMod: EnrollModule;
let sendMod: SendModule;
let bounceMod: BounceModule;
let senderMod: SenderModule;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let wsA = "";
let ownerA = "";
let sequenceId = "";
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
  {
    Email: "lena@initech.com",
    "First Name": "Lena",
    "Last Name": "Lee",
    Company: "Initech",
    Domain: "initech.com",
  },
];

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

async function balanceOf(tenantId: string): Promise<number> {
  const [r] = await admin`SELECT reveal_credit_balance AS b FROM tenants WHERE id = ${tenantId}`;
  return (r as { b: number }).b;
}

/** Run a rejecting call once and hand back the error (typed loosely for code/message assertions). */
async function caught(run: () => Promise<unknown>): Promise<{ code?: string } & Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as { code?: string } & Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("outreach");
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

  // env is set above, BEFORE any of these dynamic imports load @leadwolf/config / the db singleton.
  core = await import("../../core/src/index.ts");
  seqMod = await import("../../core/src/outreach/createSequence.ts");
  enrollMod = await import("../../core/src/outreach/enrollContact.ts");
  sendMod = await import("../../core/src/outreach/sendStep.ts");
  bounceMod = await import("../../core/src/outreach/handleBounce.ts");
  senderMod = await import("../../core/src/outreach/senderPort.ts");

  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS,
  });
  // Reveal jane (default verifier → unverified → charged 1): balance 10 → 9. Enrollment requires this.
  const revealed = await core.revealContact({
    scope: { tenantId: tenantA, workspaceId: wsA },
    userId: ownerA,
    contactId: await contactIdByDomain(wsA, "acme.com"),
    revealType: "email",
  });
  expect(revealed.creditsCharged).toBe(1);
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M9 outreach sequencing & suppression-gated send DoD", () => {
  const scope = () => ({ tenantId: tenantA, workspaceId: wsA });

  test("create sequence + step + enroll a revealed contact → membership, rollup, audits", async () => {
    const created = await seqMod.createSequence({
      scope: scope(),
      userId: ownerA,
      name: "Q3 Founders", // deliberately NO from/physical address — test 2 proves the send-tx block
    });
    sequenceId = created.id;

    const step = await seqMod.addStep({
      scope: scope(),
      userId: ownerA,
      sequenceId,
      subject: "Quick intro",
      body: "Hi Jane — saw Acme is growing. Worth a chat?",
    });
    expect(step.stepOrder).toBe(1);

    const jane = await contactIdByDomain(wsA, "acme.com");
    const enrolled = await enrollMod.enrollContact({
      scope: scope(),
      userId: ownerA,
      sequenceId,
      contactId: jane,
    });
    expect(enrolled.alreadyEnrolled).toBe(false);
    expect(enrolled.status).toBe("enrolled");
    janeLogId = enrolled.logId;

    const [c] = await admin`SELECT outreach_status FROM contacts WHERE id = ${jane}`;
    expect((c as { outreach_status: string }).outreach_status).toBe("in_sequence");
    const [a] = await admin`
      SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = ${tenantA} AND action = 'enroll' AND entity_id = ${jane}`;
    expect((a as { n: number }).n).toBe(1);
    const [s] = await admin`
      SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = ${tenantA} AND action = 'sequence.create' AND entity_id = ${sequenceId}`;
    expect((s as { n: number }).n).toBe(1);
  });

  test("sending is BLOCKED at the send tx until the CAN-SPAM identity is set (08 §6)", async () => {
    const outbox: OutboundEmail[] = [];
    const err = await caught(() =>
      sendMod.sendStep({
        scope: scope(),
        logId: janeLogId,
        sender: senderMod.staticSender(outbox),
      }),
    );
    expect(err.code).toBe("validation_error");
    expect(String(err.message)).toContain("CAN-SPAM");
    expect(outbox.length).toBe(0);

    const [l] = await admin`SELECT status, current_step FROM outreach_log WHERE id = ${janeLogId}`;
    expect((l as { status: string }).status).toBe("enrolled"); // log unchanged — the tx rolled back
    expect((l as { current_step: number }).current_step).toBe(0);
  });

  test("with the identity set, the send auto-appends the postal+unsubscribe footer and advances the log", async () => {
    await admin`
      UPDATE outreach_sequences
      SET from_address = 'sdr@acme.com', physical_address = '500 Howard St, San Francisco, CA 94105'
      WHERE id = ${sequenceId}`;

    const outbox: OutboundEmail[] = [];
    const result = await sendMod.sendStep({
      scope: scope(),
      logId: janeLogId,
      sender: senderMod.staticSender(outbox),
    });
    expect(result.sent).toBe(true);
    expect(result.step).toBe(1);
    expect(result.status).toBe("completed"); // single-step sequence completes on send 1

    expect(outbox.length).toBe(1);
    expect(outbox[0]!.to).toBe("jane@acme.com");
    expect(outbox[0]!.from).toBe("sdr@acme.com");
    expect(outbox[0]!.htmlBody).toContain("500 Howard St, San Francisco, CA 94105");
    expect(outbox[0]!.htmlBody).toContain("Unsubscribe");

    const [l] = await admin`SELECT status, current_step FROM outreach_log WHERE id = ${janeLogId}`;
    expect((l as { status: string }).status).toBe("completed");
    expect((l as { current_step: number }).current_step).toBe(1);

    const jane = await contactIdByDomain(wsA, "acme.com");
    const [a] = await admin`
      SELECT metadata FROM audit_log
      WHERE tenant_id = ${tenantA} AND action = 'send' AND entity_id = ${jane}`;
    expect((a as { metadata: { messageId: string } }).metadata.messageId).toBe(result.messageId);
  });

  test("an unrevealed contact cannot be enrolled", async () => {
    const mark = await contactIdByDomain(wsA, "globex.com");
    const err = await caught(() =>
      enrollMod.enrollContact({ scope: scope(), userId: ownerA, sequenceId, contactId: mark }),
    );
    expect(err.code).toBe("validation_error");
    expect(String(err.message)).toContain("Only revealed");
    const [n] = await admin`
      SELECT count(*)::int AS n FROM outreach_log WHERE contact_id = ${mark}`;
    expect((n as { n: number }).n).toBe(0);
  });

  test("a suppressed contact is refused at the enroll gate (08 §3)", async () => {
    // ADR-0013: a verified-invalid reveal charges 0 — lena becomes owned (enrollable) with the balance
    // untouched at 9, which keeps the credit-back arithmetic in the bounce test exact (back to 10).
    const lena = await contactIdByDomain(wsA, "initech.com");
    const revealed = await core.revealContact({
      scope: scope(),
      userId: ownerA,
      contactId: lena,
      revealType: "email",
      verifier: core.staticVerifier({ "lena@initech.com": "invalid" }),
    });
    expect(revealed.creditsCharged).toBe(0);

    const [k] = await admin`SELECT email_blind_index FROM contacts WHERE id = ${lena}`;
    await admin`
      INSERT INTO suppression_list (scope, tenant_id, workspace_id, match_type, email_blind_index, reason)
      VALUES ('workspace', ${tenantA}, ${wsA}, 'email', ${(k as { email_blind_index: Uint8Array }).email_blind_index}, 'manual_dnc')`;

    const err = await caught(() =>
      enrollMod.enrollContact({ scope: scope(), userId: ownerA, sequenceId, contactId: lena }),
    );
    expect(err.code).toBe("suppressed");
    const [n] = await admin`
      SELECT count(*)::int AS n FROM outreach_log WHERE contact_id = ${lena}`;
    expect((n as { n: number }).n).toBe(0);
  });

  // Runs BEFORE the bounce test on purpose: the bounce auto-suppresses jane, and the enroll gate would
  // (correctly) refuse her before the idempotency path could ever be reached.
  test("re-enrolling an enrolled contact is idempotent — one membership row, alreadyEnrolled", async () => {
    const jane = await contactIdByDomain(wsA, "acme.com");
    const again = await enrollMod.enrollContact({
      scope: scope(),
      userId: ownerA,
      sequenceId,
      contactId: jane,
    });
    expect(again.alreadyEnrolled).toBe(true);
    expect(again.logId).toBe(janeLogId);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM outreach_log
      WHERE sequence_id = ${sequenceId} AND contact_id = ${jane}`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("a hard bounce marks the log, auto-suppresses, and credits the charged reveal back (ADR-0013)", async () => {
    expect(await balanceOf(tenantA)).toBe(9); // 10 − jane(1) − lena(0, verified-invalid)

    const result = await bounceMod.handleBounce({ scope: scope(), logId: janeLogId });
    expect(result.bounced).toBe(true);
    expect(result.creditedBack).toBe(1);

    const [l] = await admin`SELECT status FROM outreach_log WHERE id = ${janeLogId}`;
    expect((l as { status: string }).status).toBe("bounced");
    const [s] = await admin`
      SELECT count(*)::int AS n FROM suppression_list
      WHERE workspace_id = ${wsA} AND reason = 'bounce' AND match_type = 'email'`;
    expect((s as { n: number }).n).toBe(1);

    expect(await balanceOf(tenantA)).toBe(10); // the bounced charge came back
    const [a] = await admin`
      SELECT metadata FROM audit_log WHERE tenant_id = ${tenantA} AND action = 'credit.adjust'`;
    const meta = (a as { metadata: { reason: string; amount: number } }).metadata;
    expect(meta.reason).toBe("bounce_credit_back");
    expect(meta.amount).toBe(1);
    const [sa] = await admin`
      SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = ${tenantA} AND action = 'suppression.add'`;
    expect((sa as { n: number }).n).toBe(1);
  });

  test("the bounce suppression then blocks the NEXT send in-tx (the H5 send gate)", async () => {
    await seqMod.addStep({
      scope: scope(),
      userId: ownerA,
      sequenceId,
      subject: "Re: Quick intro",
      body: "Bumping this — any thoughts?",
    });
    const outbox: OutboundEmail[] = [];
    const err = await caught(() =>
      sendMod.sendStep({
        scope: scope(),
        logId: janeLogId,
        sender: senderMod.staticSender(outbox),
      }),
    );
    expect(err.code).toBe("suppressed");
    expect(outbox.length).toBe(0); // nothing left the building
  });
});
