// forgeSyncState.itest.ts — proves P-01.20: the sync stage now advances sync_state to 'synced' and records the
// forge<->master crosswalk in master_id_map. Both were previously left empty — the console showed 0 synced and
// reconciliation had no map. Real Postgres (Testcontainers / ITEST_DATABASE_URL), own process; writes under
// withForgeTx (leadwolf_forge).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeSyncState");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("forge sync state + master_id_map (P-01.20)", () => {
  test("markSyncStateSynced advances a verified record's state pending -> synced", async () => {
    const verifiedId = crypto.randomUUID();
    await admin`
      INSERT INTO forge.sync_state (entity_kind, verified_id) VALUES ('person', ${verifiedId})`;
    await dbmod.withForgeTx((tx) => dbmod.markSyncStateSynced(tx, verifiedId));
    const [row] = await admin`
      SELECT status FROM forge.sync_state WHERE verified_id = ${verifiedId}`;
    expect((row as { status: string }).status).toBe("synced");
  });

  test("upsertMasterIdMap records the crosswalk and converges on forge_id (idempotent)", async () => {
    const forgeId = crypto.randomUUID();
    const masterId = crypto.randomUUID();
    const put = (syncedVersion: number) =>
      dbmod.withForgeTx((tx) =>
        dbmod.upsertMasterIdMap(tx, {
          forgeId,
          masterId,
          entityKind: "person",
          contentHash: "deadbeef",
          syncedVersion,
        }),
      );
    await put(1);
    await put(2); // a re-drain at a later version converges, does not duplicate

    const rows = await admin`
      SELECT master_id::text AS master_id, synced_version
        FROM forge.master_id_map WHERE forge_id = ${forgeId}`;
    expect(rows.length).toBe(1); // one row per forge_id
    expect((rows[0] as { master_id: string }).master_id).toBe(masterId);
    expect((rows[0] as { synced_version: number }).synced_version).toBe(2); // converged to the latest
  });
});
