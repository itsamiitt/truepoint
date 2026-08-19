// tenantSignals.itest.ts — behavioural proof of the MI-S6 signal fan-out (market-intelligence
// 06-architecture §2/§3): Layer-0 company signals reaching ONLY the workspaces holding a bridged
// account, as RLS-walled tenant_signals rows, with at-least-once redelivery collapsing on the
// (workspace, master_signal_id) unique wall. On a real Postgres (Testcontainers or ITEST_DATABASE_URL).
// Run in its OWN process: `bun test ./packages/db/test/tenantSignals.itest.ts`
//
// Proven:
//   1. ROUTING — the census names only the workspace whose account bridges to the signal's company.
//   2. DELIVERY — fanoutSignalsToWorkspace writes one row, attached to the bridged account; a workspace
//      with no bridge gets nothing even when offered the signal (the INSERT..SELECT finds no account).
//   3. IDEMPOTENCY — redelivery writes zero rows and leaves exactly one.
//   4. RLS — each workspace reads its own feed only; the other's is invisible under withTenantTx.
//
// Core is imported via the RELATIVE barrel (../../core/src/index.ts) — a @leadwolf/core dep is a Turbo cycle.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

async function seedTenantWorkspace(slug: string) {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

beforeAll(async () => {
  dbHandle = await startItestDb("tenant_signals");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("MI-S6 — company-signal fan-out into tenant_signals", () => {
  let w1: { tenantId: string; workspaceId: string; ownerId: string };
  let w2: { tenantId: string; workspaceId: string; ownerId: string };
  let companyId = "";
  let signalId = "";

  test("1. routing: the census names only the bridged workspace", async () => {
    w1 = await seedTenantWorkspace("sig-w1");
    w2 = await seedTenantWorkspace("sig-w2");

    const [c] = await admin`
      INSERT INTO master_companies (name, name_normalized)
      VALUES ('Signal Corp', 'signal corp') RETURNING id`;
    companyId = (c as { id: string }).id;
    // W1 bridges to the company; W2 holds an unrelated account.
    await admin`
      INSERT INTO accounts (tenant_id, workspace_id, name, master_company_id)
      VALUES (${w1.tenantId}, ${w1.workspaceId}, 'Signal Corp', ${companyId})`;
    await admin`
      INSERT INTO accounts (tenant_id, workspace_id, name)
      VALUES (${w2.tenantId}, ${w2.workspaceId}, 'Unrelated Inc')`;

    const [s] = await admin`
      INSERT INTO master_signals (subject_type, subject_id, type_code, headline, payload, observed_at)
      VALUES ('company', ${companyId}, 'exec_hired', 'Executive hired',
              '{"seniority":"vp"}'::jsonb, now())
      RETURNING id`;
    signalId = (s as { id: string }).id;

    const signals = await db.signalFanoutRepository.listNewCompanySignals(new Date(0), 10);
    expect(signals.map((x) => x.id)).toContain(signalId);
    const sig = signals.find((x) => x.id === signalId);
    expect(sig?.family).toBe("leadership");

    const workspaces = await db.signalFanoutRepository.listWorkspacesForCompanies([companyId]);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.workspaceId).toBe(w1.workspaceId);
  });

  test("2. delivery: the bridged workspace gets one row on its account; an unbridged one gets none", async () => {
    const signals = await db.signalFanoutRepository.listNewCompanySignals(new Date(0), 10);
    const res1 = await core.fanoutSignalsToWorkspace(
      { tenantId: w1.tenantId, workspaceId: w1.workspaceId },
      signals,
    );
    expect(res1.delivered).toBe(1);

    // Offered to W2 anyway (as an at-least-once sweep might): the INSERT..SELECT finds no bridged
    // account under W2's RLS, so nothing lands.
    const res2 = await core.fanoutSignalsToWorkspace(
      { tenantId: w2.tenantId, workspaceId: w2.workspaceId },
      signals,
    );
    expect(res2.delivered).toBe(0);

    const rows = await admin`
      SELECT workspace_id, account_id, type_code, family FROM tenant_signals`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspace_id).toBe(w1.workspaceId);
    expect(rows[0]!.type_code).toBe("exec_hired");
    expect(rows[0]!.account_id).not.toBeNull();
  });

  test("3. idempotency: redelivery collapses on the (workspace, signal) wall", async () => {
    const signals = await db.signalFanoutRepository.listNewCompanySignals(new Date(0), 10);
    const again = await core.fanoutSignalsToWorkspace(
      { tenantId: w1.tenantId, workspaceId: w1.workspaceId },
      signals,
    );
    expect(again.delivered).toBe(0);
    const [n] = await admin`SELECT count(*)::int AS n FROM tenant_signals`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("4. RLS: each workspace reads only its own feed", async () => {
    const w1Feed = await db.withTenantTx(
      { tenantId: w1.tenantId, workspaceId: w1.workspaceId },
      (tx) => db.tenantSignalsRepository.listRecent(tx),
    );
    expect(w1Feed).toHaveLength(1);
    expect(w1Feed[0]!.typeCode).toBe("exec_hired");
    expect(w1Feed[0]!.family).toBe("leadership");

    const w2Feed = await db.withTenantTx(
      { tenantId: w2.tenantId, workspaceId: w2.workspaceId },
      (tx) => db.tenantSignalsRepository.listRecent(tx),
    );
    expect(w2Feed).toHaveLength(0);
  });
});
