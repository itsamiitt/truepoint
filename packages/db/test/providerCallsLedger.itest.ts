// providerCallsLedger.itest.ts — the 0109 provider_calls ledger fix, proven on a real Postgres 16
// (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Named *.itest.ts so default
// `bun test` skips it; CI is the runner.
//
// THE DEFECT THIS GUARDS AGAINST RETURNING: pre-0109 the unique was (workspace_id, request_hash) while
// the hash is provider-independent and enrichContact records one row PER ATTEMPT under the same hash with
// onConflictDoNothing — so a miss-then-hit run silently dropped the hit row: its cost never counted in
// spendSince, and findCached (status='hit') missed forever, re-paying the missing provider on every call.
//
// Proves: (1) two attempts under the SAME hash from DIFFERENT providers BOTH persist;
// (2) a duplicate (workspace, hash, provider) triple still collapses (replay-safe);
// (3) findCachedFields unions per-field coverage and treats a legacy null filled_fields row as "all";
// (4) spendSince counts every attempt's cost (the pre-0109 undercount is gone);
// (5) spendSinceByProvider splits the same total by provider.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("../src/index.ts");

let dbHandle: ItestDb;
let dbApi: Db;
let admin: ReturnType<typeof postgres>;

let tenantA = "";
let wsA = "";

const HASH = Buffer.from(new Uint8Array(32).fill(7)); // one request — every attempt shares it

beforeAll(async () => {
  dbHandle = await startItestDb("providerCallsLedger");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme') RETURNING id`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, 'acme', 'acme', true, NULL) RETURNING id`;
  tenantA = t!.id;
  wsA = w!.id;

  dbApi = await import("../src/index.ts");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("provider_calls ledger (0109)", () => {
  test("two attempts under the same hash from different providers BOTH persist", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    await dbApi.withTenantTx(scope, async (tx) => {
      // The exact shape of a miss-then-hit waterfall run: same hash, two providers.
      await dbApi.providerCallRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        providerName: "apollo",
        requestHash: HASH,
        status: "miss",
        costMicros: 30_000,
      });
      await dbApi.providerCallRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        providerName: "pdl",
        requestHash: HASH,
        status: "hit",
        costMicros: 40_000,
        responsePayload: { data: { work_email: "cached@example.test" } },
        filledFields: ["email"],
        latencyMs: 412,
      });
    });

    const [n] = await admin`
      SELECT count(*)::int AS n FROM provider_calls WHERE workspace_id = ${wsA} AND request_hash = ${HASH}`;
    expect((n as { n: number }).n).toBe(2); // pre-0109 this was 1 — the hit row vanished
  });

  test("a duplicate (workspace, hash, provider) triple still collapses — replay-safe", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        providerName: "pdl",
        requestHash: HASH,
        status: "hit",
        costMicros: 40_000, // a BullMQ retry re-recording the same attempt
        filledFields: ["email"],
      }),
    );
    const [n] = await admin`
      SELECT count(*)::int AS n
      FROM provider_calls WHERE workspace_id = ${wsA} AND request_hash = ${HASH} AND provider_name = 'pdl'`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("a retry after a zero-cost non-answer UPGRADES the row in place (paid row never dropped)", async () => {
    const retryHash = Buffer.from(new Uint8Array(32).fill(8));
    const scope = { tenantId: tenantA, workspaceId: wsA };
    // Run 1: the vendor throttled us — zero-cost rate_limited row.
    await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        providerName: "clearbit",
        requestHash: retryHash,
        status: "rate_limited",
        costMicros: 0,
      }),
    );
    // Run 2 (retry): the call goes through and is PAID — must not vanish into onConflictDoNothing.
    await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        providerName: "clearbit",
        requestHash: retryHash,
        status: "hit",
        costMicros: 20_000,
        responsePayload: { person: { email: "x@y.z" } },
        filledFields: ["email"],
      }),
    );
    const rows = await admin`
      SELECT status, cost_micros::int AS cost, filled_fields
      FROM provider_calls WHERE workspace_id = ${wsA} AND request_hash = ${retryHash}`;
    expect(rows.length).toBe(1); // upgraded in place, not duplicated
    expect((rows[0] as { status: string }).status).toBe("hit");
    expect((rows[0] as { cost: number }).cost).toBe(20_000); // 0 + 20k
    expect((rows[0] as { filled_fields: unknown }).filled_fields).toEqual(["email"]);

    // …but a PAID row is immutable: a duplicate hit record is a no-op, cost not double-counted.
    await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        providerName: "clearbit",
        requestHash: retryHash,
        status: "hit",
        costMicros: 20_000,
        filledFields: ["email"],
      }),
    );
    const [after] = await admin`
      SELECT cost_micros::int AS cost FROM provider_calls
      WHERE workspace_id = ${wsA} AND request_hash = ${retryHash}`;
    expect((after as { cost: number }).cost).toBe(20_000);
  });

  test("findCachedFields reports answeredProviders (hit + paid miss; throttles excluded)", async () => {
    const cached = await dbApi.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      dbApi.providerCallRepository.findCachedFields(tx, wsA, HASH),
    );
    // From the earlier tests: apollo missed (paid), pdl hit — both ANSWERED this hash.
    expect([...cached.answeredProviders].sort()).toEqual(["apollo", "pdl"]);
  });

  test("findCachedFields unions per-field coverage across hit rows", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        providerName: "coresignal",
        requestHash: HASH,
        status: "hit",
        costMicros: 35_000,
        responsePayload: { phone: "+15550100" },
        filledFields: ["phone"],
      }),
    );

    const cached = await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.findCachedFields(tx, wsA, HASH),
    );
    expect(cached.coveredFields).not.toBe("all");
    expect([...(cached.coveredFields as string[])].sort()).toEqual(["email", "phone"]);
    expect(cached.byProvider.map((r) => r.providerName).sort()).toEqual(["coresignal", "pdl"]);
    // The miss row never enters the cache read.
    expect(cached.byProvider.some((r) => r.providerName === "apollo")).toBe(false);
  });

  test("a legacy row (null filled_fields) reads as covering the WHOLE request", async () => {
    const legacyHash = Buffer.from(new Uint8Array(32).fill(9));
    await admin`
      INSERT INTO provider_calls (tenant_id, workspace_id, provider_name, request_hash, status, cost_micros, response_payload)
      VALUES (${tenantA}, ${wsA}, 'zoominfo', ${legacyHash}, 'hit', 60000, '{"person":{}}'::jsonb)`;

    const cached = await dbApi.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      dbApi.providerCallRepository.findCachedFields(tx, wsA, legacyHash),
    );
    expect(cached.coveredFields).toBe("all");
    expect(cached.byProvider[0]?.filledFields).toBeNull();
  });

  test("spendSince counts EVERY attempt's cost; spendSinceByProvider splits it", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const total = await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.spendSince(tx, wsA, since),
    );
    // 30k (apollo miss) + 40k (pdl hit) + 35k (coresignal hit) + 60k (legacy zoominfo)
    // + 20k (clearbit retry-upgrade) = 185k. Pre-0109 the multi-attempt rows were dropped.
    expect(total).toBe(185_000);

    const byProvider = await dbApi.withTenantTx(scope, (tx) =>
      dbApi.providerCallRepository.spendSinceByProvider(tx, wsA, since),
    );
    const map = Object.fromEntries(byProvider.map((r) => [r.providerName, r.totalMicros]));
    expect(map).toEqual({
      apollo: 30_000,
      pdl: 40_000,
      coresignal: 35_000,
      zoominfo: 60_000,
      clearbit: 20_000,
    });
  });

  // LAST on purpose: this seeds additional rows and would shift the exact spendSince totals above.
  test("waterfallStatsByProvider aggregates the window; verify rows excluded; rates null-not-zero", async () => {
    // Seed a verified-valid pdl hit (verification jsonb) + a verify row that must NOT count as a vendor.
    const statsHash = Buffer.from(new Uint8Array(32).fill(11));
    await admin`
      INSERT INTO provider_calls
        (tenant_id, workspace_id, provider_name, request_hash, status, cost_micros, latency_ms, filled_fields, verification)
      VALUES
        (${tenantA}, ${wsA}, 'pdl', ${statsHash}, 'hit', 40000, 300, '["email"]'::jsonb,
         '{"email":{"status":"valid","verifier":"static_fixture"}}'::jsonb),
        (${tenantA}, ${wsA}, 'verify:email:pdl', ${statsHash}, 'hit', 0, 50, '[]'::jsonb, NULL)`;

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const stats = await dbApi.withPrivilegedTx((tx) =>
      dbApi.providerConfigRepository.waterfallStatsByProvider(tx, since, 30),
    );
    expect(stats["verify:email:pdl"]).toBeUndefined(); // verifier metering, not a vendor
    const pdl = stats.pdl;
    expect(pdl).toBeDefined();
    // Two pdl hits in the window (the earlier ledger test's + this one) → both counted.
    expect(pdl?.attempts).toBeGreaterThanOrEqual(2);
    expect(pdl?.verifiedValid).toBe(1);
    expect(pdl?.hitRate).not.toBeNull();
    expect(pdl?.p95LatencyMs).not.toBeNull();
    expect(pdl?.costPerVerifiedValidMicros).toBeGreaterThan(0);
    // A provider with rows but zero hits keeps null rates where the denominator is zero.
    const apollo = stats.apollo;
    expect(apollo?.hits).toBe(0);
    expect(apollo?.verifiedValidRate).toBeNull();
  });
});
