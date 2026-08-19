// providerOrigins.itest.ts — behavioural proof of the data-source ORIGIN fleet (provider_origins, 0117)
// and the two consumers built on it: the failover-chain client and the customer account-refresh lane
// (docs/planning/linkedin-source-ingestion/). Run in its OWN process:
//   bun test ./packages/db/test/providerOrigins.itest.ts
//
// Proofs:
//   1. THE WALL — leadwolf_app is denied on provider_origins (42501): the table holds sealed keys and is
//      NOT master_*-prefixed, so the explicit REVOKE (not the convention loop) is what protects it.
//   2. REGISTRY SEMANTICS — priority-ordered active list, paused rows excluded, sealed key decrypts back
//      through the origin router (sealOriginKey → loadOrigins roundtrip).
//   3. FAILOVER CHAIN — origin A 500s → chain moves to B and succeeds; A's health counters record the
//      failure, B's the success. A 404 REJECTION stops the chain (B never called — a bad URL won't get
//      better on another origin).
//   4. ACCOUNT REFRESH E2E — tenant account with a LinkedIn URL → stubbed vendor fetch → provider_calls
//      ledger row (workspace-scoped, paid hit) → the company document LANDS in Layer 0; a second refresh
//      inside the cache window reuses the cached payload (no second vendor call).
//
// DB error capture uses try/catch, NEVER expect(...).rejects (the pooled-connection hang trap).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

// Relative source-barrel import (NOT a devDep — the Turbo ^build cycle rule).
type CoreModule = typeof import("../../core/src/index.ts");
type DbModule = typeof import("@leadwolf/db");

const PERMISSION_DENIED = "42501";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let core: CoreModule;
let dbmod: DbModule;
let tenantId = "";
let workspaceId = "";

const COMPANY_PAYLOAD = {
  schema_version: 2,
  company_id: 296229,
  public_identifier: "origin-itest-co",
  name: "Origin Itest Co",
  industry: "Software",
  type: "Privately Held",
  website: "www.origin-itest.com",
  employee_count: 120,
  headcount: {
    total: 120,
    as_of: "2026-08",
    monthly: [
      { month: "2026-07", count: 118 },
      { month: "2026-08", count: 120 },
    ],
    by_function: [],
  },
};

beforeAll(async () => {
  dbHandle = await startItestDb("providerOrigins");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.LINKEDIN_SOURCE_LANDING_ENABLED = "true";
  process.env.PROVENANCE_EVENTS_ENABLED = "true";
  process.env.LINKEDIN_ACCOUNT_REFRESH_ENABLED = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");

  const [t] =
    await admin`INSERT INTO tenants (name, slug) VALUES ('origins','origins') RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'main', 'main', true, NULL) RETURNING id`;
  workspaceId = (w as { id: string }).id;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("provider_origins — the origin fleet (0117)", () => {
  let originA = "";
  let originB = "";

  test("1. the wall: leadwolf_app is denied (explicit REVOKE, not the master_* convention)", async () => {
    let code: string | null = null;
    try {
      await app`SELECT count(*) FROM provider_origins`;
    } catch (e) {
      code = (e as { code?: string }).code ?? null;
    }
    expect(code).toBe(PERMISSION_DENIED);
  });

  test("2. registry semantics: priority order, paused exclusion, sealed-key roundtrip", async () => {
    const sealedA = core.sealOriginKey("key-for-origin-a-x7Q2");
    const sealedB = core.sealOriginKey("key-for-origin-b-p9Z1");
    await dbmod.withPrivilegedTx(async (tx) => {
      originA = await dbmod.providerOriginRepository.create(tx, {
        provider: "linkedin_api",
        label: "a",
        baseUrl: "https://a.origin-itest.example",
        apiKeyEnc: sealedA.apiKeyEnc,
        apiKeyHint: sealedA.apiKeyHint,
        priority: 10,
      });
      originB = await dbmod.providerOriginRepository.create(tx, {
        provider: "linkedin_api",
        label: "b",
        baseUrl: "https://b.origin-itest.example",
        apiKeyEnc: sealedB.apiKeyEnc,
        apiKeyHint: sealedB.apiKeyHint,
        priority: 20,
      });
      // A paused origin must never enter the chain.
      const paused = await dbmod.providerOriginRepository.create(tx, {
        provider: "linkedin_api",
        label: "paused",
        baseUrl: "https://paused.origin-itest.example",
        apiKeyEnc: null,
        apiKeyHint: null,
        priority: 1,
      });
      await dbmod.providerOriginRepository.setPaused(tx, paused, true);
    });
    expect(sealedA.apiKeyHint).toBe("…x7Q2");

    core.invalidateOriginCache();
    const origins = await core.loadOrigins("linkedin_api");
    expect(origins.map((o) => o.host)).toEqual([
      "a.origin-itest.example",
      "b.origin-itest.example",
    ]);
    expect(origins[0]!.apiKey).toBe("key-for-origin-a-x7Q2"); // sealed → stored → decrypted roundtrip
  });

  test("3a. failover: A 500s → B answers; health counters record both", async () => {
    core.invalidateOriginCache();
    const calls: string[] = [];
    const transport: Parameters<typeof core.fetchLinkedinCompany>[2] = (url) => {
      calls.push(new URL(url).host);
      if (url.includes("a.origin-itest")) return Promise.resolve({ status: 500, json: null });
      return Promise.resolve({ status: 200, json: COMPANY_PAYLOAD });
    };
    const result = await core.fetchLinkedinCompany(
      "https://www.linkedin.com/sales/company/296229",
      {},
      transport,
    );
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["a.origin-itest.example", "b.origin-itest.example"]);
    // POST path is the vendor contract path on both attempts.
    const [a] = await admin`
      SELECT consecutive_failures, last_error FROM provider_origins WHERE id = ${originA}`;
    expect(a!.consecutive_failures).toBe(1);
    expect(a!.last_error).toBe("http 500");
    const [b] = await admin`
      SELECT consecutive_failures, last_ok_at FROM provider_origins WHERE id = ${originB}`;
    expect(b!.consecutive_failures).toBe(0);
    expect(b!.last_ok_at).not.toBeNull();
  });

  test("3b. a vendor REJECTION (404) stops the chain — the second origin is never asked", async () => {
    core.invalidateOriginCache();
    const calls: string[] = [];
    const transport: Parameters<typeof core.fetchLinkedinCompany>[2] = (url) => {
      calls.push(new URL(url).host);
      return Promise.resolve({ status: 404, json: { error: "unknown company" } });
    };
    const result = await core.fetchLinkedinCompany(
      "https://www.linkedin.com/sales/company/0",
      {},
      transport,
    );
    expect(result).toEqual({ status: "rejected", httpStatus: 404 });
    expect(calls).toEqual(["a.origin-itest.example"]); // chain stopped at the first honest answer
  });

  test("4. account refresh E2E: fetch(stub) → provider_calls ledger → Layer-0 landing → cached second run", async () => {
    const [acc] = await admin`
      INSERT INTO accounts (tenant_id, workspace_id, name, linkedin_company_url)
      VALUES (${tenantId}, ${workspaceId}, 'Origin Itest Co',
              'https://www.linkedin.com/company/origin-itest-co')
      RETURNING id`;
    const accountId = (acc as { id: string }).id;

    let vendorCalls = 0;
    const stubFetch: typeof core.fetchLinkedinCompany = () => {
      vendorCalls += 1;
      return Promise.resolve({ status: "ok", payload: COMPANY_PAYLOAD, originId: null });
    };

    const first = await core.refreshAccount({
      scope: { tenantId, workspaceId },
      accountId,
      fetchCompany: stubFetch,
    });
    expect(first).toEqual({ status: "landed", cacheHit: false });
    expect(vendorCalls).toBe(1);

    // The workspace ledger row: a PAID hit under the linkedin_api provider name.
    const [ledger] = await admin`
      SELECT provider_name, status, cost_micros FROM provider_calls
       WHERE workspace_id = ${workspaceId} AND provider_name = 'linkedin_api'`;
    expect(ledger!.status).toBe("hit");
    expect(Number(ledger!.cost_micros)).toBeGreaterThan(0);

    // The document LANDED: golden company with the numeric id + the headcount series.
    const [company] = await admin`
      SELECT id, name, ownership_type FROM master_companies WHERE linkedin_company_id = '296229'`;
    expect(company!.name).toBe("Origin Itest Co");
    expect(company!.ownership_type).toBe("private");
    const [points] = await admin`
      SELECT count(*)::int AS n FROM master_company_headcount
       WHERE master_company_id = ${company!.id}`;
    expect(points!.n).toBe(2);

    // Second refresh inside the 24h window: served from the provider_calls cache — no vendor call, and
    // the landing no-ops on the identical content hash.
    const second = await core.refreshAccount({
      scope: { tenantId, workspaceId },
      accountId,
      fetchCompany: stubFetch,
    });
    expect("cacheHit" in second && second.cacheHit).toBe(true);
    expect(vendorCalls).toBe(1);
  });

  test("4b. an account with NO LinkedIn identity refuses honestly", async () => {
    const [acc] = await admin`
      INSERT INTO accounts (tenant_id, workspace_id, name)
      VALUES (${tenantId}, ${workspaceId}, 'No Identity Inc') RETURNING id`;
    const result = await core.refreshAccount({
      scope: { tenantId, workspaceId },
      accountId: (acc as { id: string }).id,
    });
    expect(result).toEqual({ status: "no_identity" });
  });
});
