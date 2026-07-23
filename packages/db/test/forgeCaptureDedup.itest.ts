// forgeCaptureDedup.itest.ts — proves P-01.12 at the DB level: raw-capture dedup is scoped to the tenant. The
// same content_hash lands once PER TENANT (a replay within a tenant dedups) but lands independently across
// tenants (no cross-tenant existence oracle, no poisoning). Backs the unit-level proof in forge-core/ingest.test
// with the real ON CONFLICT (target_tenant_id, content_hash) + the uniq_raw_captures_tenant_content_hash index.
// Real Postgres (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts); writes under withForgeTx.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("forgeCaptureDedup");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl); // applies through 0075 → per-tenant unique
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

function insert(targetTenantId: string, contentHash: string) {
  return dbmod.withForgeTx((tx) =>
    dbmod.landRawCapture(tx, {
      source: "chrome_extension",
      endpoint: "voyager/identity/profiles",
      schemaVersion: "1-0-0",
      contentHash,
      contentType: "application/json",
      targetTenantId,
      consentSnapshot: {},
      payloadInline: "{}",
      payloadRef: null,
      byteSize: 2,
      isGzipped: false,
    }),
  );
}

describe("forge raw-capture dedup is per-tenant (P-01.12)", () => {
  test("same content_hash: dedups within a tenant, lands independently across tenants", async () => {
    const contentHash = `hash-${crypto.randomUUID()}`;

    const a1 = await insert(TENANT_A, contentHash);
    const a2 = await insert(TENANT_A, contentHash); // replay in the same tenant
    const b1 = await insert(TENANT_B, contentHash); // same hash, different tenant

    expect(a1.landed).toBe(true);
    expect(a2.landed).toBe(false); // per-tenant idempotency — the replay dedups
    expect(b1.landed).toBe(true); // NOT deduped by tenant A → no cross-tenant oracle / poisoning

    const [cnt] = await admin`
      SELECT count(*)::int AS n FROM forge.raw_captures WHERE content_hash = ${contentHash}`;
    expect((cnt as { n: number }).n).toBe(2); // one row per tenant, not one global row
  });

  test("the dedup index is (target_tenant_id, content_hash), not the old global content_hash unique", async () => {
    const [idx] = await admin`
      SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'forge' AND indexname = 'uniq_raw_captures_tenant_content_hash'`;
    expect(idx).toBeTruthy();
    expect((idx as { indexdef: string }).indexdef).toContain("target_tenant_id");
    const oldIdx = await admin`
      SELECT 1 FROM pg_indexes
        WHERE schemaname = 'forge' AND indexname = 'uniq_raw_captures_content_hash'`;
    expect(oldIdx.length).toBe(0); // the global oracle index is gone
  });
});
