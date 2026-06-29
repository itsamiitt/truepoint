// platformAdminReads.itest.ts — CI-ONLY coverage for the data-management platform-admin CROSS-TENANT reads
// (ADR-0032 / 13 §3; data-management A4/A5 + provider health 13 §3.6) on a real Postgres 16 (Testcontainers by
// default, or ITEST_DATABASE_URL — see itestDb.ts). There is NO Postgres/bun in the authoring sandbox, so this
// is CI-only: it CANNOT be run here. Run in its OWN process (the db client is a module singleton):
//   `bun test ./packages/db/test/platformAdminReads.itest.ts`
//
// These three cross-tenant platform reads had ZERO itest coverage. This proves them END-TO-END against the
// SHIPPED methods (no query is re-implemented here — the real functions are called, like retention.itest does),
// each run under withPlatformTx (the audited owner / RLS-bypass path), seeding rows via the owner connection
// anchored to a fixed NOW for recency determinism:
//
//   1. platformAdminRepository.recentImportJobs — cross-tenant: rows for BOTH tenants, each carrying the joined
//      tenant NAME + the job metadata/tallies, newest-first; the projection carries NO import_job_rows column /
//      imported-contact PII (asserted by exact key-shape + a seeded PII marker that never appears).
//   2. platformAdminRepository.recentRetentionRuns — cross-tenant: both tenants' runs with class / mode /
//      candidate+deleted counts / cutoff window + the joined tenant NAME (retention_runs is counts-only, no PII).
//   3. providerConfigRepository.recentHealthByProvider — per-provider status counts SUMMED across tenants over
//      the `since` window (one OLD row outside the window proves the filter excludes it), fed through the SHIPPED
//      @leadwolf/types deriveProviderHealth to assert the derived status per provider.
//   4. The read is AUDITED — every withPlatformTx call appends exactly one append-only platform_audit_log row
//      for the action used (delta-asserted; platform_audit_log is append-only so it is NEVER cleared — mirrors
//      platformAuditLog.itest's append-only posture + listsStaffNoAccess.itest's delta assertion).
//
// The withPlatformTx invocation (actor `{ userId, ip }`, action string, no target for a plain cross-tenant list
// read) + the exact action strings mirror the SHIPPED api callers: apps/api/src/features/admin/routes.ts →
// "admin.list_import_jobs" / "admin.list_retention_runs"; features/admin/providerConfigs.ts →
// "admin.list_provider_configs". The read cap (Math.min(limit, PLATFORM_READ_LIMIT)) is already reviewed; this
// exercises the DEFAULT limit and asserts correctness / cross-tenant visibility / ordering — NOT the cap volume
// (no 500+ row seeding).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ProviderCallStatusCounts, deriveProviderHealth } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>; // the migration/owner connection — the withPlatformTx writer/seeder
let db: Db;

let staffUserId = ""; // the platform STAFF actor for withPlatformTx (platform_audit_log.actor_user_id is NOT NULL)
let tenantA = "";
let wsA = "";
let tenantB = "";
let wsB = "";
// seedWorkspace sets tenants.name = slug, so the joined tenantName equals the slug we passed.
const TENANT_A_NAME = "acme";
const TENANT_B_NAME = "globex";

// A fixed wall-clock so seeded created_at / called_at recency is deterministic (cutoffs/ordering/since-window
// all key off it) — mirrors retention.itest's NOW anchor.
const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const daysBeforeNow = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);
const hoursBeforeNow = (n: number): Date => new Date(NOW.getTime() - n * HOUR_MS);

interface Scope {
  tenantId: string;
  workspaceId: string;
}

const scopeA = (): Scope => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = (): Scope => ({ tenantId: tenantB, workspaceId: wsB });

// The staff actor shape mirrors listsStaffNoAccess.itest / the api admin routes' actorOf: { userId, ip }.
const actor = (): { userId: string; ip: string } => ({ userId: staffUserId, ip: "10.0.0.1" });

// The EXACT projection keys the staff reads expose — used to prove no extra (PII / row-level) column rides.
const IMPORT_JOB_KEYS = [
  "avScanStatus",
  "completedAt",
  "createdAt",
  "failedReason",
  "jobId",
  "rowsCreated",
  "rowsMatched",
  "rowsRejected",
  "rowsTotal",
  "sourceName",
  "status",
  "tenantId",
  "tenantName",
];
const RETENTION_RUN_KEYS = [
  "candidateCount",
  "cutoff",
  "dataClass",
  "deletedCount",
  "mode",
  "runFinishedAt",
  "runStartedAt",
  "tenantId",
  "tenantName",
];

// ── Seeders (owner connection: the controlled created_at/called_at the reads key off can only be set here, and
// these are cross-tenant rows the app role could never write) ────────────────────────────────────────────────
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

interface ImportJobSeed {
  sourceName: string;
  status: string;
  avScanStatus: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsMatched: number;
  rowsRejected: number;
  createdAt: Date;
  completedAt: Date | null;
  failedReason: string | null;
}

async function seedImportJob(scope: Scope, f: ImportJobSeed): Promise<string> {
  const [j] = await admin`
    INSERT INTO import_jobs
      (tenant_id, workspace_id, source_file, source_name, status, av_scan_status,
       rows_total, rows_created, rows_matched, rows_rejected, created_at, completed_at, failed_reason)
    VALUES (${scope.tenantId}, ${scope.workspaceId}, ${`s3://itest/${f.sourceName}`}, ${f.sourceName},
            ${f.status}, ${f.avScanStatus}, ${f.rowsTotal}, ${f.rowsCreated}, ${f.rowsMatched},
            ${f.rowsRejected}, ${f.createdAt}, ${f.completedAt}, ${f.failedReason})
    RETURNING id`;
  return j!.id as string;
}

// A high-volume import_job_rows row carrying a recognizable PII marker. The staff read selects from import_jobs
// ONLY (never an import_job_rows row), so this must NEVER surface — seeding it makes that boundary concrete.
async function seedImportJobRowWithPii(jobId: string, scope: Scope, piiMarker: string): Promise<void> {
  const [chunk] = await admin`
    INSERT INTO import_job_chunks (job_id, chunk_index, row_start, row_end)
    VALUES (${jobId}, 0, 0, 1) RETURNING id`;
  await admin`
    INSERT INTO import_job_rows (job_id, chunk_id, row_index, workspace_id, outcome, reject_reason)
    VALUES (${jobId}, ${chunk!.id}, 0, ${scope.workspaceId}, 'rejected', ${piiMarker})`;
}

interface RetentionRunSeed {
  dataClass: string;
  mode: string;
  candidateCount: number;
  deletedCount: number;
  cutoff: Date | null;
  runStartedAt: Date;
  runFinishedAt: Date;
  createdAt: Date;
}

async function seedRetentionRun(tenantId: string, f: RetentionRunSeed): Promise<void> {
  await admin`
    INSERT INTO retention_runs
      (tenant_id, data_class, mode, candidate_count, deleted_count, cutoff,
       run_started_at, run_finished_at, created_at)
    VALUES (${tenantId}, ${f.dataClass}, ${f.mode}, ${f.candidateCount}, ${f.deletedCount},
            ${f.cutoff}, ${f.runStartedAt}, ${f.runFinishedAt}, ${f.createdAt})`;
}

let providerCallSeq = 0;
async function seedProviderCall(
  scope: Scope,
  provider: string,
  status: "hit" | "miss" | "rate_limited" | "error",
  calledAt: Date,
): Promise<void> {
  // request_hash is bytea + UNIQUE per (workspace_id, request_hash); a monotonically increasing hex keeps every
  // seeded call distinct (mirrors providerConfigs.itest's decode(.., 'hex') request_hash idiom).
  const hex = (++providerCallSeq).toString(16).padStart(8, "0");
  await admin`
    INSERT INTO provider_calls (tenant_id, workspace_id, provider_name, request_hash, status, called_at)
    VALUES (${scope.tenantId}, ${scope.workspaceId}, ${provider}, decode(${hex}, 'hex'), ${status}, ${calledAt})`;
}

beforeAll(async () => {
  dbHandle = await startItestDb("platformAdminReads");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace(TENANT_A_NAME));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace(TENANT_B_NAME));

  // A real staff user id for the actor (like listsStaffNoAccess.itest uses its tenant owner — not a random uuid).
  const [staff] = await admin`INSERT INTO users (email) VALUES ('staff@platform.test') RETURNING id`;
  staffUserId = staff!.id as string;

  // env is set ABOVE, BEFORE this dynamic import loads @leadwolf/config / the db singleton (mirrors
  // retention.itest / listsStaffNoAccess.itest — @leadwolf/types is config-free, so it stays a static import).
  db = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

beforeEach(async () => {
  // platform_audit_log is append-only (a DB trigger blocks DELETE), so it is NEVER cleared — the audit case
  // asserts a +1 DELTA instead. import_jobs cascades to its chunks + rows.
  await admin`DELETE FROM import_jobs`;
  await admin`DELETE FROM retention_runs`;
  await admin`DELETE FROM provider_calls`;
});

describe("platform-admin cross-tenant reads (ADR-0032; data-management A4/A5 + provider health)", () => {
  test("recentImportJobs is cross-tenant: both tenants, joined tenant name, newest-first, no row PII", async () => {
    const jobA1 = await seedImportJob(scopeA(), {
      sourceName: "acme-old.csv",
      status: "completed",
      avScanStatus: "clean",
      rowsTotal: 100,
      rowsCreated: 90,
      rowsMatched: 5,
      rowsRejected: 5,
      createdAt: daysBeforeNow(3),
      completedAt: daysBeforeNow(3),
      failedReason: null,
    });
    // Seed an import_job_rows row carrying a recognizable PII marker — the staff read must NEVER surface it.
    await seedImportJobRowWithPii(jobA1, scopeA(), "leaked@pii.test");

    const jobA2 = await seedImportJob(scopeA(), {
      sourceName: "acme-new.csv",
      status: "failed",
      avScanStatus: "clean",
      rowsTotal: 50,
      rowsCreated: 0,
      rowsMatched: 0,
      rowsRejected: 50,
      createdAt: daysBeforeNow(1),
      completedAt: null,
      failedReason: "chunk 3 av-scan failed",
    });
    const jobB1 = await seedImportJob(scopeB(), {
      sourceName: "globex.csv",
      status: "running",
      avScanStatus: "pending",
      rowsTotal: 200,
      rowsCreated: 10,
      rowsMatched: 2,
      rowsRejected: 0,
      createdAt: daysBeforeNow(2),
      completedAt: null,
      failedReason: null,
    });

    // SHIPPED method via the audited platform path — action + NO target, exactly like apps/api admin routes.
    const jobs = await db.withPlatformTx(actor(), "admin.list_import_jobs", (tx) =>
      db.platformAdminRepository.recentImportJobs(tx),
    );

    expect(jobs).toHaveLength(3);

    // Cross-tenant: rows for BOTH tenants are present (this read spans every tenant — the whole point).
    const tenantIds = new Set(jobs.map((j) => j.tenantId));
    expect(tenantIds.has(tenantA)).toBe(true);
    expect(tenantIds.has(tenantB)).toBe(true);

    // Newest-first by created_at: A2 (1d) > B1 (2d) > A1 (3d).
    expect(jobs.map((j) => j.jobId)).toEqual([jobA2, jobB1, jobA1]);
    expect(jobs[0]!.createdAt.getTime()).toBeGreaterThan(jobs[1]!.createdAt.getTime());
    expect(jobs[1]!.createdAt.getTime()).toBeGreaterThan(jobs[2]!.createdAt.getTime());

    const byId = new Map(jobs.map((j) => [j.jobId, j]));
    const rowA1 = byId.get(jobA1)!;
    const rowA2 = byId.get(jobA2)!;
    const rowB1 = byId.get(jobB1)!;

    // The tenant NAME join (the org name — the customer's, not a person's PII) rides each row.
    expect(rowA1.tenantName).toBe(TENANT_A_NAME);
    expect(rowA2.tenantName).toBe(TENANT_A_NAME);
    expect(rowB1.tenantName).toBe(TENANT_B_NAME);

    // The genuinely-useful monitoring columns (status / av-scan / tallies / completion / failure) ride through.
    expect(rowA1.status).toBe("completed");
    expect(rowA1.avScanStatus).toBe("clean");
    expect(rowA1.rowsTotal).toBe(100);
    expect(rowA1.rowsCreated).toBe(90);
    expect(rowA1.rowsMatched).toBe(5);
    expect(rowA1.rowsRejected).toBe(5);
    expect(rowA1.completedAt).not.toBeNull();
    expect(rowA1.failedReason).toBeNull();
    expect(rowA2.status).toBe("failed");
    expect(rowA2.failedReason).toBe("chunk 3 av-scan failed");
    expect(rowA2.completedAt).toBeNull();
    expect(rowB1.status).toBe("running");
    expect(rowB1.avScanStatus).toBe("pending");

    // Privacy: the projection is import_jobs METADATA only — EXACTLY the allowed keys, and NO import_job_rows
    // column / imported-contact PII anywhere in the payload (the seeded reject_reason marker never appears).
    expect(Object.keys(rowA1).sort()).toEqual([...IMPORT_JOB_KEYS].sort());
    expect(JSON.stringify(jobs)).not.toContain("leaked@pii.test");
  });

  test("recentRetentionRuns is cross-tenant: both tenants' runs with counts/class/window + tenant name", async () => {
    await seedRetentionRun(tenantA, {
      dataClass: "verification_jobs",
      mode: "shadow",
      candidateCount: 12,
      deletedCount: 0,
      cutoff: daysBeforeNow(730),
      runStartedAt: daysBeforeNow(1),
      runFinishedAt: daysBeforeNow(1),
      createdAt: daysBeforeNow(1),
    });
    await seedRetentionRun(tenantA, {
      dataClass: "import_job_rows",
      mode: "enforce",
      candidateCount: 7,
      deletedCount: 7,
      cutoff: daysBeforeNow(365),
      runStartedAt: daysBeforeNow(2),
      runFinishedAt: daysBeforeNow(2),
      createdAt: daysBeforeNow(2),
    });
    await seedRetentionRun(tenantB, {
      dataClass: "activities",
      mode: "shadow",
      candidateCount: 3,
      deletedCount: 0,
      cutoff: daysBeforeNow(365),
      runStartedAt: hoursBeforeNow(36),
      runFinishedAt: hoursBeforeNow(36),
      createdAt: hoursBeforeNow(36),
    });

    const runs = await db.withPlatformTx(actor(), "admin.list_retention_runs", (tx) =>
      db.platformAdminRepository.recentRetentionRuns(tx),
    );

    expect(runs).toHaveLength(3);

    // Cross-tenant: runs for BOTH tenants are present.
    const tenantIds = new Set(runs.map((r) => r.tenantId));
    expect(tenantIds.has(tenantA)).toBe(true);
    expect(tenantIds.has(tenantB)).toBe(true);

    // Newest-first by created_at: A.verification_jobs (1d) > B.activities (36h) > A.import_job_rows (2d).
    expect(runs.map((r) => r.dataClass)).toEqual([
      "verification_jobs",
      "activities",
      "import_job_rows",
    ]);

    const verif = runs.find((r) => r.dataClass === "verification_jobs")!;
    expect(verif.tenantId).toBe(tenantA);
    expect(verif.tenantName).toBe(TENANT_A_NAME);
    expect(verif.mode).toBe("shadow");
    expect(verif.candidateCount).toBe(12);
    expect(verif.deletedCount).toBe(0);
    expect(verif.cutoff).not.toBeNull();

    const importRun = runs.find((r) => r.dataClass === "import_job_rows")!;
    expect(importRun.tenantId).toBe(tenantA);
    expect(importRun.mode).toBe("enforce");
    expect(importRun.candidateCount).toBe(7);
    expect(importRun.deletedCount).toBe(7);

    const activities = runs.find((r) => r.dataClass === "activities")!;
    expect(activities.tenantId).toBe(tenantB);
    expect(activities.tenantName).toBe(TENANT_B_NAME);
    expect(activities.mode).toBe("shadow");
    expect(activities.candidateCount).toBe(3);
    expect(activities.deletedCount).toBe(0);

    // retention_runs is counts-only — the projection has EXACTLY the allowed keys (no createdAt, no PII).
    expect(Object.keys(verif).sort()).toEqual([...RETENTION_RUN_KEYS].sort());
  });

  test("recentHealthByProvider sums per provider across tenants, honoring the `since` window", async () => {
    const since = hoursBeforeNow(24);
    const within = hoursBeforeNow(1); // inside the window
    const outside = hoursBeforeNow(48); // OUTSIDE the window — must be excluded by the `since` filter

    // apollo across BOTH tenants, all within the window: 8 miss + 1 error + 1 rate_limited live calls + 3 cache
    // hits → degraded. (A) 5 miss, 1 error, 2 hit; (B) 3 miss, 1 rate_limited, 1 hit.
    await seedProviderCall(scopeA(), "apollo", "miss", within);
    await seedProviderCall(scopeA(), "apollo", "miss", within);
    await seedProviderCall(scopeA(), "apollo", "miss", within);
    await seedProviderCall(scopeA(), "apollo", "miss", within);
    await seedProviderCall(scopeA(), "apollo", "miss", within);
    await seedProviderCall(scopeA(), "apollo", "error", within);
    await seedProviderCall(scopeA(), "apollo", "hit", within);
    await seedProviderCall(scopeA(), "apollo", "hit", within);
    await seedProviderCall(scopeB(), "apollo", "miss", within);
    await seedProviderCall(scopeB(), "apollo", "miss", within);
    await seedProviderCall(scopeB(), "apollo", "miss", within);
    await seedProviderCall(scopeB(), "apollo", "rate_limited", within);
    await seedProviderCall(scopeB(), "apollo", "hit", within);
    // OLD apollo miss OUTSIDE the window — if the `since` filter were broken this would push miss to 9.
    await seedProviderCall(scopeA(), "apollo", "miss", outside);

    // clearbit across BOTH tenants, all within the window: only errors → down. (A) 2 error; (B) 1 error.
    await seedProviderCall(scopeA(), "clearbit", "error", within);
    await seedProviderCall(scopeA(), "clearbit", "error", within);
    await seedProviderCall(scopeB(), "clearbit", "error", within);

    const health = await db.withPlatformTx(actor(), "admin.list_provider_configs", (tx) =>
      db.providerConfigRepository.recentHealthByProvider(tx, since),
    );

    // Per-provider counts are the CROSS-TENANT sums within the window — the OLD apollo miss is excluded (8, not 9).
    const expectedApollo: ProviderCallStatusCounts = { hit: 3, miss: 8, rateLimited: 1, error: 1 };
    const expectedClearbit: ProviderCallStatusCounts = { hit: 0, miss: 0, rateLimited: 0, error: 3 };
    expect(health.apollo).toEqual(expectedApollo);
    expect(health.clearbit).toEqual(expectedClearbit);

    // The SHIPPED derive turns the real aggregated counts into a status per provider.
    expect(deriveProviderHealth(health.apollo!)).toBe("degraded");
    expect(deriveProviderHealth(health.clearbit!)).toBe("down");
  });

  test("the platform read is audited: each withPlatformTx call appends exactly one platform_audit_log row", async () => {
    const action = "admin.list_import_jobs";
    // platform_audit_log is append-only (never cleared), so assert a +1 DELTA for this action (mirrors
    // platformAuditLog.itest's append-only posture + listsStaffNoAccess.itest's delta assertion). The read
    // itself can return zero rows (none seeded here) — withPlatformTx still writes the audit row in-tx.
    const [before] = await admin`
      SELECT count(*)::int AS n FROM platform_audit_log WHERE action = ${action}`;
    const beforeN = (before as { n: number }).n;

    await db.withPlatformTx(actor(), action, (tx) =>
      db.platformAdminRepository.recentImportJobs(tx),
    );

    const [after] = await admin`
      SELECT count(*)::int AS n FROM platform_audit_log WHERE action = ${action}`;
    expect((after as { n: number }).n).toBe(beforeN + 1);

    // The newest row for the action names the staff actor + the action (the audited owner path wrote it in-tx).
    const [latest] = await admin`
      SELECT actor_user_id, action FROM platform_audit_log
      WHERE action = ${action} ORDER BY occurred_at DESC LIMIT 1`;
    const r = latest as { actor_user_id: string; action: string };
    expect(r.actor_user_id).toBe(staffUserId);
    expect(r.action).toBe(action);
  });
});
