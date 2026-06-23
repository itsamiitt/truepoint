// providerConfigs.itest.ts — Phase 2 DB layer on a real Postgres (Testcontainers or ITEST_DATABASE_URL):
// provider_configs is READABLE by the app role (global config) but NOT writable (RLS SELECT-only policy),
// the owner can upsert, and the month-to-date cross-tenant spend aggregation sums provider_calls.cost_micros
// into cents. Named *.itest.ts so default `bun test` skips it; run: `bun test packages/db/test/providerConfigs.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let owner: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("providerConfigs");
  await applyMigrations(dbHandle.adminUrl);
  owner = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await owner?.end();
  await app?.end();
  await dbHandle?.stop();
});

describe("Phase 2 provider_configs (13 §3.6)", () => {
  test("leadwolf_app can READ provider_configs (global config) but NOT write it", async () => {
    const rows = await app`SELECT provider FROM provider_configs`;
    expect(Array.isArray(rows)).toBe(true); // read allowed by the SELECT policy
    const err = await caught(
      () => app`INSERT INTO provider_configs (provider, label) VALUES ('apollo', 'Apollo')`,
    );
    expect(err.message).toMatch(/row-level security|permission denied/i);
  });

  test("the owner can upsert a provider config", async () => {
    await owner`
      INSERT INTO provider_configs (provider, label, enabled, monthly_budget_cents)
      VALUES ('apollo', 'Apollo', true, 50000)
      ON CONFLICT (provider) DO UPDATE SET monthly_budget_cents = 50000`;
    const [row] =
      await owner`SELECT monthly_budget_cents FROM provider_configs WHERE provider = 'apollo'`;
    expect((row as { monthly_budget_cents: number }).monthly_budget_cents).toBe(50000);
  });

  test("month-to-date spend sums provider_calls.cost_micros into cents (10_000 micros = 1¢)", async () => {
    const [t] =
      await owner`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme-pc') RETURNING id`;
    const tenantId = (t as { id: string }).id;
    const [w] = await owner`
      INSERT INTO workspaces (tenant_id, name, slug) VALUES (${tenantId}, 'ws', 'ws-pc') RETURNING id`;
    const wsId = (w as { id: string }).id;
    // $1.00 (1_000_000 micros) + $0.50 (500_000 micros) = 150¢.
    await owner`
      INSERT INTO provider_calls (tenant_id, workspace_id, provider_name, request_hash, status, cost_micros)
      VALUES (${tenantId}, ${wsId}, 'apollo', decode('01', 'hex'), 'miss', 1000000)`;
    await owner`
      INSERT INTO provider_calls (tenant_id, workspace_id, provider_name, request_hash, status, cost_micros)
      VALUES (${tenantId}, ${wsId}, 'apollo', decode('02', 'hex'), 'miss', 500000)`;
    const [agg] = await owner`
      SELECT coalesce(sum(cost_micros), 0)::bigint AS micros FROM provider_calls WHERE provider_name = 'apollo'`;
    const cents = Math.round(Number((agg as { micros: string }).micros) / 10000);
    expect(cents).toBe(150);
  });
});
