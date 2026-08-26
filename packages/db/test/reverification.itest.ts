// reverification.itest.ts — the S-09 freshness re-verification loop on a real Postgres 16
// (run in its OWN process: `bun test ./packages/db/test/reverification.itest.ts`).
//
// `runReverification` had NO test of any kind. It is the loop that keeps S-09 honest — "minimize the
// likelihood a record's person has left the company" — and it is also a loop that SPENDS money, one verifier
// call per stale row. Both of its worst failure modes are silent:
//
//   1. Resetting `last_verified_at` without actually re-grading. The module says so itself: "re-grading
//      nothing must NOT reset the freshness clock and falsely mark records fresh". If that guard breaks,
//      every record in the product reports as freshly verified forever and the whole S-09 signal is a lie —
//      with nothing failing, no error, and a Data Health page full of green.
//   2. Re-verifying rows it should not. The in-use gate (revealed only) and the SLA cutoff are what bound
//      verifier spend; widening either quietly multiplies the bill.
//
// Everything here injects the verifier, so no vendor is called and no money is spent. What is NOT covered:
// the deadline/abort + checkpoint-cursor contract, which deserves its own file — flagged rather than faked.

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

/**
 * Pin the per-tenant flag EXPLICITLY, in both directions.
 *
 * Migration 0119 set `global_enabled = true` on every defined flag, so "no override row" no longer means
 * "off" — a test that seeds nothing inherits whatever the global default happens to be, and reads as passing
 * for the wrong reason. Every flag-dependent assertion in this file states the value it wants.
 */
async function setFlag(enabled: boolean): Promise<void> {
  // feature_flags' primary key column is `key`, not `flag_key` — only the OVERRIDE table uses `flag_key`.
  await admin`
    INSERT INTO feature_flags (key, description, global_enabled)
    VALUES (${FLAG_KEY}, 'reverification (itest)', false)
    ON CONFLICT (key) DO NOTHING`;
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
    VALUES (${FLAG_KEY}, ${tenantId}::uuid, ${enabled})
    ON CONFLICT (flag_key, tenant_id) DO UPDATE SET enabled = ${enabled}`;
}

/** A contact with encrypted PII. `lastVerifiedAt: null` means "never verified" — which the predicate treats
 *  as stale, the same as a past-SLA timestamp. */
async function seedContact(input: {
  email: string;
  isRevealed: boolean;
  lastVerifiedAt: Date | null;
}): Promise<string> {
  const enc = core.encryptPii(input.email);
  // `revealed_by_user_id` and `revealed_at` are not decoration: two CHECK constraints
  // (contacts_reveal_by / contacts_reveal_at) require each to be non-null exactly when is_revealed is true.
  // Seeding `is_revealed = true` alone is rejected by the database, which is the constraint doing its job —
  // an "is revealed but by nobody, at no time" row could never be audited.
  const revealedBy = input.isRevealed ? userId : null;
  const revealedAt = input.isRevealed ? new Date("2020-01-01T00:00:00Z") : null;
  const [row] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name, email_enc, email_status,
                          is_revealed, revealed_by_user_id, revealed_at, last_verified_at)
    VALUES (${tenantId}::uuid, ${workspaceId}::uuid, 'Test', 'Person', ${enc}, 'unverified',
            ${input.isRevealed}, ${revealedBy}, ${revealedAt}, ${input.lastVerifiedAt})
    RETURNING id`;
  return row!.id as string;
}

async function readContact(
  id: string,
): Promise<{ email_status: string; last_verified_at: Date | null }> {
  const [row] = await admin`
    SELECT email_status, last_verified_at FROM contacts WHERE id = ${id}::uuid`;
  return row as { email_status: string; last_verified_at: Date | null };
}

/** A verifier that grades everything `valid` and counts its calls — the stand-in for Reacher. Counting is the
 *  point: "how many rows did we pay for" is the assertion that bounds spend. */
function countingVerifier(): {
  name: string;
  calls: string[];
  verify: (e: string) => Promise<"valid">;
} {
  const calls: string[] = [];
  return {
    name: "itest_counting",
    calls,
    verify: (email: string) => {
      calls.push(email);
      return Promise.resolve("valid" as const);
    },
  };
}

beforeAll(async () => {
  dbHandle = await startItestDb("reverification");
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

  // env is set above, BEFORE these dynamic imports load @leadwolf/config / the db singleton.
  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("runReverification", () => {
  const scope = () => ({ tenantId, workspaceId });

  test("a pass-through verifier does NOT reset the freshness clock", async () => {
    // THE assertion this file exists for. Re-grading nothing must leave the clock alone; resetting it would
    // mark every record fresh while nothing was actually verified.
    await setFlag(true);
    const stale = new Date("2020-01-01T00:00:00Z");
    const id = await seedContact({
      email: "passthrough@example.com",
      isRevealed: true,
      lastVerifiedAt: stale,
    });

    const result = await core.runReverification(scope(), {
      verifier: core.passThroughVerifier,
      phoneVerifier: core.formatOnlyPhoneVerifier,
    });

    expect(result).toEqual({ scanned: 0, reverified: 0, errored: 0 });
    const after = await readContact(id);
    expect(after.last_verified_at?.toISOString()).toBe(stale.toISOString());
  });

  test("the per-tenant flag is opt-in: disabled means no work and no spend", async () => {
    await setFlag(false);
    const verifier = countingVerifier();
    const stale = new Date("2020-02-01T00:00:00Z");
    const id = await seedContact({
      email: "flagoff@example.com",
      isRevealed: true,
      lastVerifiedAt: stale,
    });

    const result = await core.runReverification(scope(), { verifier });

    expect(result).toEqual({ scanned: 0, reverified: 0, errored: 0 });
    expect(verifier.calls).toEqual([]); // not merely "no writes" — no vendor call was paid for
    const after = await readContact(id);
    expect(after.last_verified_at?.toISOString()).toBe(stale.toISOString());
  });

  test("a revealed, past-SLA contact is re-graded and its clock resets", async () => {
    await setFlag(true);
    const verifier = countingVerifier();
    const stale = new Date("2020-03-01T00:00:00Z");
    const now = new Date("2026-08-22T12:00:00Z");
    const id = await seedContact({
      email: "stale@example.com",
      isRevealed: true,
      lastVerifiedAt: stale,
    });

    const result = await core.runReverification(scope(), { verifier, now });

    expect(verifier.calls).toContain("stale@example.com");
    expect(result.reverified).toBeGreaterThanOrEqual(1);
    const after = await readContact(id);
    expect(after.email_status).toBe("valid");
    // The clock moved off the seeded value — the row has left the stale set.
    expect(after.last_verified_at).not.toBeNull();
    expect(after.last_verified_at!.getTime()).toBeGreaterThan(stale.getTime());
  });

  test("an UNREVEALED contact is never verified — the in-use gate is what bounds spend", async () => {
    await setFlag(true);
    const verifier = countingVerifier();
    const stale = new Date("2020-04-01T00:00:00Z");
    const id = await seedContact({
      email: "unrevealed@example.com",
      isRevealed: false,
      lastVerifiedAt: stale,
    });

    await core.runReverification(scope(), { verifier, now: new Date("2026-08-22T12:00:00Z") });

    expect(verifier.calls).not.toContain("unrevealed@example.com");
    const after = await readContact(id);
    expect(after.last_verified_at?.toISOString()).toBe(stale.toISOString());
    expect(after.email_status).toBe("unverified");
  });

  test("a contact verified within the SLA is left alone", async () => {
    await setFlag(true);
    const verifier = countingVerifier();
    const now = new Date("2026-08-22T12:00:00Z");
    const fresh = new Date(now.getTime() - 60 * 60 * 1000); // an hour ago — comfortably inside any SLA
    const id = await seedContact({
      email: "fresh@example.com",
      isRevealed: true,
      lastVerifiedAt: fresh,
    });

    await core.runReverification(scope(), { verifier, now });

    expect(verifier.calls).not.toContain("fresh@example.com");
    const after = await readContact(id);
    expect(after.last_verified_at?.toISOString()).toBe(fresh.toISOString());
  });
});
