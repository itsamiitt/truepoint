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

  test("5. dispatch: only subscribed users are notified, only for subscribed families", async () => {
    const [acc] = await admin`
      SELECT id FROM accounts WHERE workspace_id = ${w1.workspaceId} AND master_company_id = ${companyId}`;
    const accountId = (acc as { id: string }).id;
    const scope = { tenantId: w1.tenantId, workspaceId: w1.workspaceId };

    // Watchlist containing the account; the owner subscribes to leadership ONLY.
    const watchlistId = await db.withTenantTx(scope, async (tx) => {
      const id = await db.watchlistRepository.create(tx, {
        ...scope,
        name: "Territory",
        createdByUserId: w1.ownerId,
      });
      await db.watchlistRepository.addMember(tx, {
        ...scope,
        watchlistId: id,
        accountId,
        addedByUserId: w1.ownerId,
      });
      await db.watchlistRepository.subscribe(tx, {
        ...scope,
        watchlistId: id,
        userId: w1.ownerId,
        families: ["leadership"],
      });
      return id;
    });
    expect(watchlistId).not.toBe("");

    // A second leadership signal → exactly one notification for the subscriber.
    const [s2] = await admin`
      INSERT INTO master_signals (subject_type, subject_id, type_code, payload, observed_at)
      VALUES ('company', ${companyId}, 'exec_departed', '{}'::jsonb, now()) RETURNING id`;
    void s2;
    const signals2 = await db.signalFanoutRepository.listNewCompanySignals(new Date(0), 10);
    const res = await core.fanoutSignalsToWorkspace(scope, signals2);
    expect(res.delivered).toBe(1); // only the new signal is fresh
    expect(res.notified).toBe(1);
    const notes = await admin`
      SELECT type, entity_id, user_id FROM notifications WHERE workspace_id = ${w1.workspaceId}`;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("account_signal");
    expect(notes[0]!.entity_id).toBe(accountId);
    expect(notes[0]!.user_id).toBe(w1.ownerId);

    // A hiring-family signal: delivered to the feed, but the subscription names leadership only.
    await admin`
      INSERT INTO master_signals (subject_type, subject_id, type_code, payload, observed_at)
      VALUES ('company', ${companyId}, 'headcount_surge', '{}'::jsonb, now())`;
    const signals3 = await db.signalFanoutRepository.listNewCompanySignals(new Date(0), 10);
    const res3 = await core.fanoutSignalsToWorkspace(scope, signals3);
    expect(res3.delivered).toBe(1);
    expect(res3.notified).toBe(0);

    // Redelivery: nothing new lands, nobody is re-notified.
    const resAgain = await core.fanoutSignalsToWorkspace(scope, signals3);
    expect(resAgain.delivered).toBe(0);
    expect(resAgain.notified).toBe(0);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM notifications WHERE workspace_id = ${w1.workspaceId}`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("7. account scoring (MI-S4): versioned row appended, fit cached onto accounts.icp_fit_score", async () => {
    const [acc] = await admin`
      SELECT id FROM accounts WHERE workspace_id = ${w1.workspaceId} AND master_company_id = ${companyId}`;
    const accountId = (acc as { id: string }).id;
    const res = await core.computeAccountScore({
      scope: { tenantId: w1.tenantId, workspaceId: w1.workspaceId },
      accountId,
    });
    // Fit: only domain is missing on the seeded account (name+bridge only) → sparse fit; momentum: three
    // fresh signals (leadership ×2 + hiring) clamp high. Pin the mechanics, not brittle exact values.
    expect(res.momentum).toBeGreaterThan(50);
    expect(res.composite).toBeGreaterThan(0);
    const [scoreRow] = await admin`
      SELECT model_version, icp_fit, breakdown FROM account_scores WHERE account_id = ${accountId}`;
    expect(scoreRow!.model_version).toBe("v1");
    expect(scoreRow!.breakdown.momentum.leadership).toBeGreaterThan(0);
    const [cached] = await admin`SELECT icp_fit_score FROM accounts WHERE id = ${accountId}`;
    expect(cached!.icp_fit_score).toBe(res.icpFit); // the trigger keeps the cache = FIT, not composite
  });

  test("6. RLS: each workspace reads only its own feed", async () => {
    const w1Feed = await db.withTenantTx(
      { tenantId: w1.tenantId, workspaceId: w1.workspaceId },
      (tx) => db.tenantSignalsRepository.listRecent(tx),
    );
    // Three signals landed for W1 across the suite (exec_hired, exec_departed, headcount_surge).
    expect(w1Feed).toHaveLength(3);
    expect(new Set(w1Feed.map((r) => r.family))).toEqual(new Set(["leadership", "hiring"]));

    const w2Feed = await db.withTenantTx(
      { tenantId: w2.tenantId, workspaceId: w2.workspaceId },
      (tx) => db.tenantSignalsRepository.listRecent(tx),
    );
    expect(w2Feed).toHaveLength(0);
  });
});
