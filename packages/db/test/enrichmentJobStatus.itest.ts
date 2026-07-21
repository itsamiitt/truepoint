// enrichmentJobStatus.itest.ts — the G-ENR-4 workspace-scoping proof for the customer-visible enrichment
// job-status surface, on a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL). Requires the
// generated src/migrations. Named *.itest.ts so default `bun test` skips it; run in its OWN process (the db
// client is a module singleton): `bun test packages/db/test/enrichmentJobStatus.itest.ts`.
//
// Proves the READ path the status endpoints / polling UI use is strictly workspace-isolated and maps the
// control-row counters correctly. Two tenants/workspaces (A=acme, B=globex) each get enrichment jobs; then via
// the core query helper (which runs through withTenantTx + RLS):
//   (1) listEnrichmentJobs(A) returns ONLY A's jobs (B's never leak), most-recent first;
//   (2) the derived progress fraction + failed count + ISO timestamps match the seeded counters;
//   (3) getEnrichmentJobStatus(A, <B's job id>) returns null — RLS hides a foreign workspace's job (404 at the
//       edge), and getEnrichmentJobStatus(A, <A's job id>) returns it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

/** Insert a control-plane enrichment_jobs row directly (admin, bypassing RLS) so we control its counters. */
async function seedJob(args: {
  tenantId: string;
  workspaceId: string;
  sourceName: string;
  status: string;
  total: number;
  processed: number;
  matched: number;
  enriched: number;
  charged: number;
  failedReason?: string | null;
}): Promise<string> {
  const [j] = await admin`
    INSERT INTO enrichment_jobs
      (tenant_id, workspace_id, source_file, source_name, status,
       total_rows, processed_rows, matched_rows, enriched_rows, charged_rows,
       started_at, completed_at, failed_reason)
    VALUES
      (${args.tenantId}, ${args.workspaceId}, ${`s3://bucket/${args.sourceName}`}, ${args.sourceName},
       ${args.status}, ${args.total}, ${args.processed}, ${args.matched}, ${args.enriched},
       ${args.charged}, now(), ${args.status === "completed" || args.status === "failed" ? admin`now()` : null},
       ${args.failedReason ?? null})
    RETURNING id`;
  return (j as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("enrichmentJobStatus");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  core = await import("../../core/src/index.ts");

  // A: two jobs (a running one then a completed one — inserted last so it is most-recent).
  await seedJob({
    tenantId: tenantA,
    workspaceId: wsA,
    sourceName: "a-running.csv",
    status: "running",
    total: 100,
    processed: 40,
    matched: 30,
    enriched: 25,
    charged: 10,
  });
  await seedJob({
    tenantId: tenantA,
    workspaceId: wsA,
    sourceName: "a-failed.csv",
    status: "failed",
    total: 50,
    processed: 50,
    matched: 20,
    enriched: 18,
    charged: 5,
    failedReason: "provider budget exhausted",
  });

  // B: one job that must NEVER surface in A's list/detail.
  await seedJob({
    tenantId: tenantB,
    workspaceId: wsB,
    sourceName: "b-secret.csv",
    status: "completed",
    total: 10,
    processed: 10,
    matched: 10,
    enriched: 10,
    charged: 3,
  });
}, 240_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("G-ENR-4 enrichment job-status surface — workspace scoping + mapping", () => {
  const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
  // These tests assert the RLS workspace wall + DTO mapping, not the owner scope: a scoped:false viewer
  // short-circuits the jobVisibility predicate to workspace-wide (the shipped behavior; T-V4 parity).
  const wsWideViewer = () =>
    ({ userId: "00000000-0000-0000-0000-000000000000", role: "owner", scoped: false }) as const;

  test("listEnrichmentJobs(A) returns ONLY A's jobs, most-recent first; B's never leak", async () => {
    const jobs = await core.listEnrichmentJobs({ scope: scopeA(), viewer: wsWideViewer() });
    expect(jobs.length).toBe(2);
    // Most-recent first → the failed job (inserted last) leads.
    expect(jobs[0]!.sourceName).toBe("a-failed.csv");
    expect(jobs[1]!.sourceName).toBe("a-running.csv");
    // None of B's jobs surfaced.
    expect(jobs.map((j) => j.sourceName)).not.toContain("b-secret.csv");
  });

  test("derives progress, failed count, and failure reason from the control-row counters", async () => {
    const jobs = await core.listEnrichmentJobs({ scope: scopeA(), viewer: wsWideViewer() });
    const running = jobs.find((j) => j.sourceName === "a-running.csv")!;
    expect(running.progress).toBeCloseTo(0.4, 5); // 40 / 100
    // In-flight: the rows not yet matched are still pending, NOT failed → failed reads 0 until settled.
    expect(running.counts.failed).toBe(0);
    expect(running.failedReason).toBeNull();

    const failed = jobs.find((j) => j.sourceName === "a-failed.csv")!;
    expect(failed.status).toBe("failed");
    expect(failed.progress).toBe(1); // 50 / 50
    // Settled (terminal): 50 processed − 20 matched = 30 genuinely unresolved rows.
    expect(failed.counts.failed).toBe(30);
    expect(failed.failedReason).toBe("provider budget exhausted");
    expect(failed.completedAt).not.toBeNull();
  });

  test("getEnrichmentJobStatus is RLS-scoped: A sees its own job, B's id resolves to null", async () => {
    const jobs = await core.listEnrichmentJobs({ scope: scopeA(), viewer: wsWideViewer() });
    const aJobId = jobs[0]!.jobId;
    const own = await core.getEnrichmentJobStatus({ scope: scopeA(), viewer: wsWideViewer(), jobId: aJobId });
    expect(own?.jobId).toBe(aJobId);

    // B's job id — fetched with admin (bypassing RLS) — must be invisible to A (null → 404 at the edge).
    const [bRow] = await admin`SELECT id FROM enrichment_jobs WHERE workspace_id = ${wsB} LIMIT 1`;
    const bJobId = (bRow as { id: string }).id;
    const leaked = await core.getEnrichmentJobStatus({ scope: scopeA(), viewer: wsWideViewer(), jobId: bJobId });
    expect(leaked).toBeNull();
  });
});
