// forgeAuditChain.itest.ts — proves P-01.18: the promotion audit log is a LINEAR, GENESIS-rooted hash chain even
// though each append reads the head then writes. promoteVerifiedRecord serializes the append with a
// transaction-scoped advisory lock, so concurrent promotions can't both read the same head and FORK the chain (a
// fork silently destroys tamper-evidence). We assert the chain links across sequential promotions, that an
// idempotent replay writes no audit row, and — best-effort — that two overlapping promotions still don't fork.
// Real Postgres (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts); writes under withForgeTx.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeAuditChain");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 4, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

function promote(contentHash: string) {
  return dbmod.withForgeTx((tx) =>
    dbmod.promoteVerifiedRecord(tx, {
      candidate: { contentHash, entityKind: "person", fields: { name: "Test" }, confidence: 0.95 },
      approvalRequestId: crypto.randomUUID(),
      approvedByUserId: crypto.randomUUID(),
    }),
  );
}

async function chainRows() {
  return (await admin`
    SELECT seq, prev_hash, row_hash FROM forge.forge_audit_log ORDER BY seq ASC`) as Array<{
    seq: number;
    prev_hash: string;
    row_hash: string;
  }>;
}

/** The chain is well-formed iff it is rooted at GENESIS and every row links to its immediate predecessor. */
function assertLinear(rows: Array<{ prev_hash: string; row_hash: string }>) {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].prev_hash).toBe("GENESIS");
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].prev_hash).toBe(rows[i - 1].row_hash); // no fork — one row can only follow one predecessor
  }
}

describe("forge audit log hash chain (P-01.18)", () => {
  test("sequential promotions form a linear, GENESIS-rooted chain", async () => {
    const a = await promote(`hash-${crypto.randomUUID()}`);
    const b = await promote(`hash-${crypto.randomUUID()}`);
    expect(a.written).toBe(true);
    expect(b.written).toBe(true);
    assertLinear(await chainRows());
  });

  test("idempotent replay (same content_hash) writes no second audit row", async () => {
    const h = `hash-${crypto.randomUUID()}`;
    const first = await promote(h);
    const [before] = await admin`SELECT count(*)::int AS n FROM forge.forge_audit_log`;
    const replay = await promote(h);
    const [after] = await admin`SELECT count(*)::int AS n FROM forge.forge_audit_log`;
    expect(first.written).toBe(true);
    expect(replay.written).toBe(false); // duplicate content_hash → early return before the audit append
    expect((after as { n: number }).n).toBe((before as { n: number }).n);
  });

  test("concurrent promotions do not fork the chain (advisory lock serializes the append)", async () => {
    // Fire a burst of overlapping promotions; the advisory lock must still yield a single linear chain.
    await Promise.all(
      Array.from({ length: 8 }, () => promote(`hash-${crypto.randomUUID()}`)),
    );
    assertLinear(await chainRows());
  });
});
