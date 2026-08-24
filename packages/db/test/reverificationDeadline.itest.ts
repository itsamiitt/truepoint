// reverificationDeadline.itest.ts — the deadline/abort + checkpoint-cursor contract of `runReverification`
// (run in its OWN process: `bun test ./packages/db/test/reverificationDeadline.itest.ts`).
//
// reverification.itest.ts covers what the loop DOES; this covers what happens when the queue's deadline kills
// it mid-run. That contract is stated in the module's doc comment and is easy to get subtly wrong in either
// direction, with money on both sides:
//
//   • advance the cursor past rows the killed wave never verified → the resumed attempt SKIPS them; they stay
//     stale until some later full sweep notices, and S-09 quietly degrades for those records.
//   • fail to advance it after a fully-stamped batch → the resume RE-READS and RE-PAYS for rows already
//     verified, which is a vendor bill rather than a wrong answer.
//
// Neither shows up as an error. The loop's own comment is precise about the intent — "On an abort mid-batch
// the cursor deliberately does NOT advance ... no skips, no re-pays" — so these tests pin that sentence.
//
// One implementation detail makes the mid-batch case testable at all: the abort is observed per ROW inside the
// bounded verify fan-out, and `aborted` is latched immediately AFTER the wave (reverifyContacts.ts, right
// before the stamp). A verifier that aborts synchronously on its first call therefore lets exactly one row
// through — every later lane sees the flag before it starts. That is what makes "partial tally, stamped work
// preserved, no checkpoint" observable rather than a race.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

// Relative source-barrel import, NOT a @leadwolf/core devDep: a db→core devDependency creates a Turbo
// ^build cycle that breaks typecheck (the established cross-package test-import rule in this repo).
type CoreModule = typeof import("../../core/src/index.ts");
type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: CoreModule;
let db: DbModule;
let tenantId = "";
let workspaceId = "";
let userId = "";

const FLAG_KEY = "data_health.reverification";
const NOW = new Date("2026-08-22T12:00:00Z");
/** Any stamp lands after this; the seeded clocks are all in 2020. */
const STAMP_FLOOR = new Date("2026-01-01T00:00:00Z");

/** Seed one stale, revealed contact. `index` drives last_verified_at so the keyset order is deterministic —
 *  the loop sorts worst-first on coalesce(last_verified_at, created_at), so distinct values pin the order. */
async function seedStale(index: number): Promise<string> {
  const enc = core.encryptPii(`row${index}@example.com`);
  const [row] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name, email_enc, email_status,
                          is_revealed, revealed_by_user_id, revealed_at, last_verified_at)
    VALUES (${tenantId}::uuid, ${workspaceId}::uuid, 'Row', ${String(index)}, ${enc}, 'unverified',
            true, ${userId}::uuid, ${new Date("2020-01-01T00:00:00Z")},
            ${new Date(Date.UTC(2020, 0, index + 1))})
    RETURNING id`;
  return row!.id as string;
}

/** How many of this workspace's contacts have been stamped fresh by a run. */
async function stampedCount(): Promise<number> {
  const [row] = await admin`
    SELECT count(*)::int AS n FROM contacts
    WHERE workspace_id = ${workspaceId}::uuid AND last_verified_at > ${STAMP_FLOOR}`;
  return (row as { n: number }).n;
}

async function clearContacts(): Promise<void> {
  await admin`DELETE FROM contacts WHERE workspace_id = ${workspaceId}::uuid`;
}

/** Grades everything valid, records every email it was asked about, and can abort on the Nth call. */
function verifierThatAbortsOn(
  call: number | null,
  controller: AbortController | null,
): { name: string; calls: string[]; verify: (email: string) => Promise<"valid"> } {
  const calls: string[] = [];
  return {
    name: "itest_deadline",
    calls,
    verify: (email: string) => {
      calls.push(email);
      // Synchronous abort: every lane that has not started yet will see the flag before its first statement.
      if (call !== null && calls.length === call) controller?.abort();
      return Promise.resolve("valid" as const);
    },
  };
}

beforeAll(async () => {
  dbHandle = await startItestDb("reverification-deadline");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.PII_ENCRYPTION_KEY = "itest-pii-encryption-key-01234567";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme', 'acme', 100) RETURNING id`;
  tenantId = t!.id as string;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  userId = u!.id as string;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${tenantId}::uuid, ${userId}::uuid, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}::uuid, 'acme', 'acme', true, ${userId}::uuid) RETURNING id`;
  workspaceId = w!.id as string;

  // Flag pinned ON explicitly — migration 0119 made global_enabled true for every defined flag, so seeding
  // nothing would inherit the global default and pass for the wrong reason.
  await admin`
    INSERT INTO feature_flags (key, description, global_enabled)
    VALUES (${FLAG_KEY}, 'reverification (itest)', false) ON CONFLICT (key) DO NOTHING`;
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
    VALUES (${FLAG_KEY}, ${tenantId}::uuid, true)
    ON CONFLICT (flag_key, tenant_id) DO UPDATE SET enabled = true`;

  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("runReverification — deadline, abort and the checkpoint cursor", () => {
  const scope = () => ({ tenantId, workspaceId });

  test("an already-aborted signal does no work and spends nothing", async () => {
    await clearContacts();
    await seedStale(0);
    const controller = new AbortController();
    controller.abort();
    const verifier = verifierThatAbortsOn(null, null);

    const result = await core.runReverification(scope(), {
      verifier: verifier as never,
      now: NOW,
      signal: controller.signal,
    });

    expect(result).toEqual({ scanned: 0, reverified: 0, errored: 0 });
    expect(verifier.calls).toEqual([]);
    expect(await stampedCount()).toBe(0);
  });

  test("an abort mid-batch keeps the graded work, reports a PARTIAL tally, and emits no checkpoint", async () => {
    // The core of the contract. 12 rows in ONE batch; the verifier aborts on its first call, so exactly one
    // row is graded and the rest of the wave stands down. The cursor must NOT advance past the ungraded rows.
    await clearContacts();
    for (let i = 0; i < 12; i += 1) await seedStale(i);
    const controller = new AbortController();
    const verifier = verifierThatAbortsOn(1, controller);
    const checkpoints: { sortKey: Date; id: string }[] = [];

    const result = await core.runReverification(scope(), {
      verifier: verifier as never,
      batchSize: 20,
      now: NOW,
      signal: controller.signal,
      onCheckpoint: (c) => {
        checkpoints.push(c);
      },
    });

    // Work actually done is kept — the row was paid for, so its grade is stamped rather than discarded.
    expect(result.reverified).toBe(1);
    expect(result.scanned).toBe(1);
    expect(await stampedCount()).toBe(1);
    // And the cursor did NOT advance: no checkpoint means the resume re-reads from the same place and the
    // eleven ungraded rows are still in the stale set rather than skipped past.
    expect(checkpoints).toEqual([]);
  });

  test("a clean run checkpoints after every fully-stamped batch", async () => {
    await clearContacts();
    for (let i = 0; i < 5; i += 1) await seedStale(i);
    const verifier = verifierThatAbortsOn(null, null);
    const checkpoints: { sortKey: Date; id: string }[] = [];

    const result = await core.runReverification(scope(), {
      verifier: verifier as never,
      batchSize: 2, // 5 rows → batches of 2, 2, 1
      now: NOW,
      onCheckpoint: (c) => {
        checkpoints.push(c);
      },
    });

    expect(result.reverified).toBe(5);
    expect(verifier.calls).toHaveLength(5);
    expect(await stampedCount()).toBe(5);
    // One per batch, including the short final page.
    expect(checkpoints).toHaveLength(3);
    // The cursor advances monotonically — it is a keyset position, not a page number.
    for (let i = 1; i < checkpoints.length; i += 1) {
      expect(checkpoints[i]!.sortKey.getTime()).toBeGreaterThanOrEqual(
        checkpoints[i - 1]!.sortKey.getTime(),
      );
    }
  });

  test("resuming from a checkpoint does not re-pay for rows already verified", async () => {
    // The other half of the contract: the resume must start AFTER the cursor. Re-reading from the top would
    // be correct-but-expensive — every already-graded row billed a second time.
    await clearContacts();
    for (let i = 0; i < 5; i += 1) await seedStale(i);

    const first = verifierThatAbortsOn(null, null);
    const checkpoints: { sortKey: Date; id: string }[] = [];
    await core.runReverification(scope(), {
      verifier: first as never,
      batchSize: 2,
      now: NOW,
      onCheckpoint: (c) => {
        checkpoints.push(c);
      },
    });
    expect(first.calls).toHaveLength(5);

    // Rewind each row to the SAME clock it was seeded with, not to one shared value. The cursor is a keyset
    // position over (last_verified_at, id) — collapsing every row onto one timestamp moves them all after the
    // cursor and the resume legitimately re-reads everything. That is what a first version of this test did,
    // and it failed for its own reason rather than the code's.
    for (let i = 0; i < 5; i += 1) {
      await admin`
        UPDATE contacts SET last_verified_at = ${new Date(Date.UTC(2020, 0, i + 1))}
        WHERE workspace_id = ${workspaceId}::uuid AND last_name = ${String(i)}`;
    }

    const second = verifierThatAbortsOn(null, null);
    await core.runReverification(scope(), {
      verifier: second as never,
      batchSize: 2,
      now: NOW,
      resumeCursor: checkpoints[0]!,
    });

    // checkpoints[0] is the position after the first batch (rows 0 and 1), so the resume must verify exactly
    // rows 2, 3 and 4 — and must NOT bill for 0 and 1 again.
    expect(second.calls.sort()).toEqual([
      "row2@example.com",
      "row3@example.com",
      "row4@example.com",
    ]);
  });
});
