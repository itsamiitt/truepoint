// importJobs.itest.ts — the bulk COPY-staging import control plane's per-workspace RLS isolation on a real
// Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the
// db client is a module singleton): `bun test ./packages/db/test/importJobs.itest.ts`.
//
// Proves: (1) a created job is readable in its own workspace; (2) it is INVISIBLE across workspaces (RLS) while
// the BYPASSRLS admin still sees it (so the row exists — only RLS hides it); (3) a job written under B's scope
// is invisible to A; (4) the high-volume `import_job_rows` ledger (denormalized workspace_id) is isolated too.
// This is the security backstop for the new workspace-scoped tables (mirrors the enrichment_jobs guarantee).

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
  dbHandle = await startItestDb("import-jobs");
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

describe("import_jobs control plane: create + per-workspace RLS isolation", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
  const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });
  // These tests assert the RLS workspace wall, not the owner scope: a scoped:false viewer short-circuits
  // the jobVisibility predicate to workspace-wide (the shipped behavior; T-V4 parity). The owner-scope
  // matrix has its own itest (jobVisibility.itest.ts).
  const wsWideViewer = () =>
    ({ userId: "00000000-0000-0000-0000-000000000000", role: "owner", scoped: false }) as const;

  test("a created job is readable in its own workspace", async () => {
    const created = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.createJob(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        sourceFile: "s3://acme/contacts.csv",
        sourceName: "contacts.csv",
        idempotencyKey: "acme-upload-1",
      }),
    );
    expect(created.created).toBe(true);

    const jobs = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.listJobs(tx, wsWideViewer()),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.sourceName).toBe("contacts.csv");
    expect(jobs[0]!.status).toBe("queued");

    const job = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.getJob(tx, wsWideViewer(), created.id),
    );
    expect(job?.id).toBe(created.id);
    expect(job?.workspaceId).toBe(wsA);
  });

  test("workspace B cannot see workspace A's jobs (RLS), but the admin can", async () => {
    const jobsB = await db.withTenantTx(scopeB(), (tx) =>
      db.importJobRepository.listJobs(tx, wsWideViewer()),
    );
    expect(jobsB).toHaveLength(0);
    // The BYPASSRLS admin/owner connection sees the row — proving it exists; only RLS hides it from B.
    const [count] = (await admin`
      SELECT count(*)::int AS n FROM import_jobs`) as { n: number }[];
    expect(count!.n).toBe(1);
  });

  test("a job written under B's scope is invisible to A", async () => {
    await db.withTenantTx(scopeB(), (tx) =>
      db.importJobRepository.createJob(tx, {
        tenantId: tenantB,
        workspaceId: wsB,
        sourceFile: "s3://globex/leads.csv",
        sourceName: "leads.csv",
      }),
    );
    const jobsA = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.listJobs(tx, wsWideViewer()),
    );
    expect(jobsA).toHaveLength(1); // still only A's own job
    expect(jobsA[0]!.workspaceId).toBe(wsA);
  });

  test("import_job_rows (denormalized workspace_id) is isolated per workspace too", async () => {
    // Build a fresh job + chunk + two ledger rows entirely under A's scope, in one tx (chunks inherit RLS
    // through the parent job; each row carries its own workspace_id for the direct WITH CHECK).
    await db.withTenantTx(scopeA(), async (tx) => {
      const job = await db.importJobRepository.createJob(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        sourceFile: "s3://acme/rows.csv",
        sourceName: "rows.csv",
      });
      const chunkId = await db.importJobRepository.createChunk(tx, {
        jobId: job.id,
        chunkIndex: 0,
        rowStart: 0,
        rowEnd: 1,
      });
      await db.importJobRepository.insertJobRows(tx, [
        { jobId: job.id, chunkId, rowIndex: 0, workspaceId: wsA, outcome: "created" },
        { jobId: job.id, chunkId, rowIndex: 1, workspaceId: wsA, outcome: "rejected" },
      ]);
    });

    const rowsA = await db.withTenantTx(scopeA(), (tx) =>
      tx.select().from(db.schema.importJobRows),
    );
    expect(rowsA).toHaveLength(2);

    const rowsB = await db.withTenantTx(scopeB(), (tx) =>
      tx.select().from(db.schema.importJobRows),
    );
    expect(rowsB).toHaveLength(0);

    const [count] = (await admin`
      SELECT count(*)::int AS n FROM import_job_rows`) as { n: number }[];
    expect(count!.n).toBe(2);
  });
});
