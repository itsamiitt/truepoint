// forgeQuarantine.itest.ts — proves P-01.8: the parse quarantine lane is PERSISTED. Selection/shape/parse drift
// was routed to a bare console.warn and lost; insertQuarantine now writes one row per (raw_capture_id, route) into
// forge.quarantine and is idempotent — a re-quarantine of the same capture+route refreshes the reason, never
// duplicates. Real Postgres (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts), own process.
// Writes run under withForgeTx (SET LOCAL ROLE leadwolf_forge), mirroring the parse worker's quarantine adapter.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeQuarantine");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl); // applies through 0074 → creates forge.quarantine
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

async function seedCapture(): Promise<string> {
  const [rc] = await admin`
    INSERT INTO forge.raw_captures
      (source, endpoint, schema_version, content_hash, target_tenant_id, payload_inline, byte_size)
    VALUES ('chrome_extension', 'voyager/identity/profiles', '1-0-0',
            ${`hash-${crypto.randomUUID()}`}, '00000000-0000-4000-8000-0000000000aa', '{}', 2)
    RETURNING id::text`;
  return (rc as { id: string }).id;
}

describe("forge quarantine persists (P-01.8)", () => {
  test("insert persists the drift with route + reason, FK'd to the capture", async () => {
    const rawCaptureId = await seedCapture();
    await dbmod.withForgeTx((tx) =>
      dbmod.insertQuarantine(tx, {
        rawCaptureId,
        route: "NO_ACTIVE_VERSION",
        reason: "no active parser version for voyager/identity/profiles@1-0-0",
      }),
    );
    const rows = (await admin`
      SELECT route, reason FROM forge.quarantine WHERE raw_capture_id = ${rawCaptureId}`) as Array<{
      route: string;
      reason: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].route).toBe("NO_ACTIVE_VERSION");
    expect(rows[0].reason).toContain("no active parser version");
  });

  test("re-quarantine converges (idempotent on raw_capture_id, route) — refreshes reason, never duplicates", async () => {
    const rawCaptureId = await seedCapture();
    const put = (reason: string) =>
      dbmod.withForgeTx((tx) =>
        dbmod.insertQuarantine(tx, { rawCaptureId, route: "SHAPE_DRIFT", reason }),
      );
    await put("fingerprint drift: fp-aaa");
    await put("fingerprint drift: fp-bbb"); // same capture+route, later delivery

    const rows = await admin`
      SELECT reason FROM forge.quarantine WHERE raw_capture_id = ${rawCaptureId} AND route = 'SHAPE_DRIFT'`;
    expect(rows.length).toBe(1); // one row per (capture, route)
    expect((rows[0] as { reason: string }).reason).toBe("fingerprint drift: fp-bbb"); // reason refreshed
  });

  test("distinct routes for the same capture are distinct rows", async () => {
    const rawCaptureId = await seedCapture();
    await dbmod.withForgeTx(async (tx) => {
      await dbmod.insertQuarantine(tx, { rawCaptureId, route: "NO_PARSER", reason: "a" });
      await dbmod.insertQuarantine(tx, { rawCaptureId, route: "PARSE_QUARANTINE", reason: "b" });
    });
    const [cnt] = await admin`
      SELECT count(*)::int AS n FROM forge.quarantine WHERE raw_capture_id = ${rawCaptureId}`;
    expect((cnt as { n: number }).n).toBe(2);
  });
});
