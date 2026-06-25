// schedulerClaim.itest.ts — the M12 P4 leader-locked scheduler claim (email-planning/13 P4, 15 §A.4,
// known-gap #5). Run in its OWN process: `bun test ./packages/db/test/schedulerClaim.itest.ts`. Proves
// schedulerRepository.claimDueEnrollments (FOR UPDATE SKIP LOCKED):
//   (1) two CONCURRENT claims return DISJOINT sets — no enrollment is claimed twice (no double-advance);
//   (2) together they claim every DUE enrollment exactly once;
//   (3) a REPLIED enrollment is never claimed (auto-pause-on-reply lives in the claim's WHERE);
//   (4) a claim reserves (bumps last_event_at), so a non-due enrollment isn't picked up.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let tenantA = "";
let wsA = "";
let sequenceId = "";
const dueLogIds: string[] = [];
let repliedLogId = "";

async function seedContact(): Promise<string> {
  const [r] =
    await admin`INSERT INTO contacts (tenant_id, workspace_id) VALUES (${tenantA}, ${wsA}) RETURNING id`;
  return (r as { id: string }).id;
}
async function seedLog(contactId: string, status = "enrolled"): Promise<string> {
  const [r] = await admin`
    INSERT INTO outreach_log (tenant_id, workspace_id, sequence_id, contact_id, status)
    VALUES (${tenantA}, ${wsA}, ${sequenceId}, ${contactId}, ${status}) RETURNING id`;
  return (r as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("schedulerClaim");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  dbmod = await import("@leadwolf/db");

  admin = postgres(dbHandle.adminUrl, { max: 4, onnotice: () => {} });
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  const ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  // An ACTIVE sequence with a step 1 at delay 0 → every enrolled log with current_step 0 is due now.
  const [s] = await admin`
    INSERT INTO outreach_sequences (tenant_id, workspace_id, name, status) VALUES (${tenantA}, ${wsA}, 'Q3', 'active')
    RETURNING id`;
  sequenceId = (s as { id: string }).id;
  await admin`
    INSERT INTO outreach_steps (tenant_id, workspace_id, sequence_id, step_order, delay_hours, body)
    VALUES (${tenantA}, ${wsA}, ${sequenceId}, 1, 0, 'hi')`;

  for (let i = 0; i < 6; i++) {
    dueLogIds.push(await seedLog(await seedContact()));
  }
  repliedLogId = await seedLog(await seedContact(), "replied"); // auto-paused — never claimed
}, 180_000);

afterAll(async () => {
  await dbmod.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M12 P4 claimDueEnrollments (no double-advance)", () => {
  test("two concurrent claims are disjoint and together claim every due enrollment once", async () => {
    const [a, b] = await Promise.all([
      dbmod.schedulerRepository.claimDueEnrollments(100),
      dbmod.schedulerRepository.claimDueEnrollments(100),
    ]);
    const aIds = a.map((e) => e.logId);
    const bIds = b.map((e) => e.logId);

    // Disjoint — no enrollment claimed by both ticks (the no-double-advance guarantee).
    const overlap = aIds.filter((id) => bIds.includes(id));
    expect(overlap).toEqual([]);

    // Together they claim exactly the 6 due enrollments, once each.
    const union = new Set([...aIds, ...bIds]);
    expect(union.size).toBe(6);
    for (const id of dueLogIds) expect(union.has(id)).toBe(true);

    // The replied enrollment was auto-paused — never claimed by either.
    expect(union.has(repliedLogId)).toBe(false);

    // Every claim carries the step cursor used for the BullMQ dedup key.
    for (const e of [...a, ...b]) expect(e.currentStep).toBe(0);
  });

  test("a subsequent claim finds nothing (all due rows are leased 5 min into the future)", async () => {
    const again = await dbmod.schedulerRepository.claimDueEnrollments(100);
    // The lease pushed last_event_at into the future, so the previously-due rows are no longer due.
    expect(again.map((e) => e.logId).filter((id) => dueLogIds.includes(id))).toEqual([]);
  });
});
