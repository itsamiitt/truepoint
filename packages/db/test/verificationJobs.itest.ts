// verificationJobs.itest.ts — the freshness re-verification audit ledger's per-workspace RLS isolation on a real
// Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db
// client is a module singleton): `bun test ./packages/db/test/verificationJobs.itest.ts`.
//
// Proves: (1) a recorded run is readable in its own workspace; (2) it is INVISIBLE across workspaces (RLS) while
// the BYPASSRLS admin still sees it (so the row exists — only RLS hides it); (3) a row written under B's scope is
// invisible to A. This is the security backstop for the new workspace-scoped table (mirrors the enrichment_jobs
// isolation guarantee).

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

beforeAll(async () => {
  dbHandle = await startItestDb("verification-jobs");
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

describe("verification_jobs audit ledger: record + per-workspace RLS isolation", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
  const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

  test("a recorded run is readable in its own workspace", async () => {
    const base = new Date("2026-01-01T00:00:00.000Z");
    await db.withTenantTx(scopeA(), (tx) =>
      db.verificationJobRepository.record(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        startedAt: base,
        finishedAt: new Date(base.getTime() + 1000),
        scanned: 10,
        reverified: 7,
        errored: 1,
      }),
    );
    const rows = await db.withTenantTx(scopeA(), (tx) => db.verificationJobRepository.listRecent(tx));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scanned).toBe(10);
    expect(rows[0]!.reverified).toBe(7);
    expect(rows[0]!.errored).toBe(1);
  });

  test("workspace B cannot see workspace A's ledger rows (RLS), but the admin can", async () => {
    const rowsB = await db.withTenantTx(scopeB(), (tx) =>
      db.verificationJobRepository.listRecent(tx),
    );
    expect(rowsB).toHaveLength(0);
    // The BYPASSRLS admin/owner connection sees the row — proving it exists; only RLS hides it from B.
    const [count] = (await admin`
      SELECT count(*)::int AS n FROM verification_jobs`) as { n: number }[];
    expect(count!.n).toBe(1);
  });

  test("a row written under B's scope is invisible to A", async () => {
    await db.withTenantTx(scopeB(), (tx) =>
      db.verificationJobRepository.record(tx, {
        tenantId: tenantB,
        workspaceId: wsB,
        startedAt: new Date("2026-02-01T00:00:00.000Z"),
        finishedAt: new Date("2026-02-01T00:00:01.000Z"),
        scanned: 3,
        reverified: 3,
        errored: 0,
      }),
    );
    const rowsA = await db.withTenantTx(scopeA(), (tx) =>
      db.verificationJobRepository.listRecent(tx),
    );
    expect(rowsA).toHaveLength(1); // still only A's own row
    expect(rowsA[0]!.workspaceId).toBe(wsA);
  });
});
