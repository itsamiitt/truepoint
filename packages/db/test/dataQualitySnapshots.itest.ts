// dataQualitySnapshots.itest.ts — the Data Health trend store's per-workspace RLS isolation on a real Postgres 16
// (run in its OWN process: `bun test ./packages/db/test/dataQualitySnapshots.itest.ts`). Proves (1) a recorded
// snapshot is readable in its own workspace; (2) it is INVISIBLE across workspaces (RLS) while the BYPASSRLS admin
// still sees it; (3) a row written under B's scope is invisible to A. The security backstop for the new table.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let tenantA = "";
let wsA = "";
let tenantB = "";
let wsB = "";

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id };
}

const METRICS = {
  total: 5,
  withName: 5,
  withEmail: 4,
  withPhone: 2,
  withTitle: 3,
  withCompany: 4,
  withLinkedin: 1,
  withLocation: 2,
  emailValid: 3,
  emailRisky: 0,
  emailInvalid: 1,
  emailCatchAll: 0,
  emailUnverified: 0,
  emailUnknown: 0,
  phoneValid: 2,
  phoneInvalid: 0,
  phoneMobile: 1,
  phoneLandline: 1,
  phoneVoip: 0,
  fresh: 3,
  stale: 1,
  neverVerified: 1,
};

beforeAll(async () => {
  dbHandle = await startItestDb("data-quality-snapshots");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  // env is set above, BEFORE this dynamic import loads @leadwolf/config / the db singleton.
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("data_quality_snapshots trend store: record + per-workspace RLS isolation", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
  const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

  test("a recorded snapshot is readable in its own workspace", async () => {
    await db.withTenantTx(scopeA(), (tx) =>
      db.dataQualitySnapshotRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        metrics: METRICS,
      }),
    );
    const rows = await db.withTenantTx(scopeA(), (tx) =>
      db.dataQualitySnapshotRepository.listRecent(tx),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metrics as typeof METRICS).total).toBe(5);
    expect((rows[0]!.metrics as typeof METRICS).phoneMobile).toBe(1);
  });

  test("workspace B cannot see workspace A's snapshots (RLS), but the admin can", async () => {
    const rowsB = await db.withTenantTx(scopeB(), (tx) =>
      db.dataQualitySnapshotRepository.listRecent(tx),
    );
    expect(rowsB).toHaveLength(0);
    const [count] = (await admin`
      SELECT count(*)::int AS n FROM data_quality_snapshots`) as { n: number }[];
    expect(count!.n).toBe(1);
  });

  test("a row written under B's scope is invisible to A", async () => {
    await db.withTenantTx(scopeB(), (tx) =>
      db.dataQualitySnapshotRepository.record(tx, {
        tenantId: tenantB,
        workspaceId: wsB,
        metrics: METRICS,
      }),
    );
    const rowsA = await db.withTenantTx(scopeA(), (tx) =>
      db.dataQualitySnapshotRepository.listRecent(tx),
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.workspaceId).toBe(wsA);
  });
});
