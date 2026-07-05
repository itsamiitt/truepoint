// importFairness.itest.ts — S-Q2's test gate (import-redesign 15 §T-P1 seq 13; T-Q4's mechanics half):
// the per-workspace job cap parks overflow in `deferred` at commit (decideFastAdmission), a deferred claim
// at-cap RE-ENQUEUES (cooperative transport loop) instead of running, the promotion pass flips the OLDEST
// deferred job into freed headroom exactly once, a below-cap deferred claim promotes-and-runs, and the
// chunk-window helper honors the K/∞-sentinel contract. The full mixed-load contention scenario (whale +
// fast p95 wait — T-Q4's load half) is nightly-soak territory (12 S-P4, TP-3); the mechanics proven here
// are what that scenario composes. Real Postgres; NO Redis (the BullMQ transport is injected as a
// collector, exactly how the worker injects the real producer).
// Run explicitly, own process: bun test apps/workers/test/importFairness.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "../../../packages/db/test/itestDb.ts";

type Core = typeof import("@leadwolf/core");
type Db = typeof import("@leadwolf/db");
let core: Core;
let dbm: Db;

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let wsA = "";
let ownerA = "";

const MAPPING = { email: "Email", firstName: "First Name" };
const ROWS = [{ Email: "cap@acme.com", "First Name": "Cap" }];

async function createJob(status: "queued" | "deferred"): Promise<string> {
  const { id } = await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
    dbm.importJobRepository.createJob(tx, {
      tenantId: tenantA,
      workspaceId: wsA,
      createdByUserId: ownerA,
      sourceFile: `inline:${crypto.randomUUID()}`,
      sourceName: "manual",
      status,
      columnMapping: MAPPING,
      processingMode: "fast",
      sourceFilename: "cap.csv",
    }),
  );
  return id;
}

async function setStatus(jobId: string, status: string): Promise<void> {
  await admin`UPDATE import_jobs SET status = ${status} WHERE id = ${jobId}`;
}

async function getStatus(jobId: string): Promise<string> {
  const [r] = await admin`SELECT status FROM import_jobs WHERE id = ${jobId}`;
  return (r as { status: string }).status;
}

beforeAll(async () => {
  dbHandle = await startItestDb("import_fairness");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  // The knobs under test — set BEFORE the config singleton loads (dynamic imports below).
  process.env.IMPORT_WORKSPACE_JOB_CAP = "1";
  process.env.IMPORT_CHUNK_WINDOW = "2";

  const { applyMigrations } = await import("../../../packages/db/src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme', 'acme') RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  core = await import("@leadwolf/core");
  dbm = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("S-Q2 — per-workspace cap: admission at commit", () => {
  test("below cap ⇒ queued; at cap (an executing job) ⇒ deferred; terminal jobs free the slot", async () => {
    const idle = await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      core.decideFastAdmission(tx, wsA),
    );
    expect(idle).toBe("queued");

    const runningJob = await createJob("queued");
    await setStatus(runningJob, "running");
    const atCap = await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      core.decideFastAdmission(tx, wsA),
    );
    expect(atCap).toBe("deferred");

    await setStatus(runningJob, "completed");
    const freed = await dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, (tx) =>
      core.decideFastAdmission(tx, wsA),
    );
    expect(freed).toBe("queued"); // terminal states never occupy a slot
  }, 60_000);
});

describe("S-Q2 — deferred claim: cooperative re-check", () => {
  test("at cap: the claim re-enqueues (deferrals+1) and touches neither the row nor the workspace", async () => {
    const blocker = await createJob("queued");
    await setStatus(blocker, "running");
    const deferredJob = await createJob("deferred");

    const requeues: number[] = [];
    const result = await core.runFastImport({
      scope: { tenantId: tenantA, workspaceId: wsA },
      jobId: deferredJob,
      input: { sourceName: "manual", mapping: MAPPING, rows: ROWS },
      deferrals: 0,
      requeueDeferred: async (n) => {
        requeues.push(n);
      },
    });

    expect(result.deferred).toBe(true);
    expect(result.finalized).toBe(false);
    expect(requeues).toEqual([1]); // exactly one re-enqueue, deferral counter advanced
    expect(await getStatus(deferredJob)).toBe("deferred"); // row untouched — the sweep owns the flip
    await setStatus(blocker, "completed");
    await setStatus(deferredJob, "cancelled"); // park it out of later censuses
  }, 60_000);

  test("below cap: a deferred claim promotes and runs to terminal in one pass", async () => {
    const deferredJob = await createJob("deferred");
    const result = await core.runFastImport({
      scope: { tenantId: tenantA, workspaceId: wsA },
      jobId: deferredJob,
      input: { sourceName: "manual", mapping: MAPPING, rows: ROWS },
      deferrals: 1,
      requeueDeferred: async () => {
        throw new Error("must not requeue below cap");
      },
    });
    expect(result.deferred ?? false).toBe(false);
    expect(result.finalized).toBe(true);
    expect(await getStatus(deferredJob)).toBe("completed");
  }, 120_000);
});

describe("S-Q2 — leader-sweep promotion pass: oldest-first, metered into headroom", () => {
  test("one freed slot promotes exactly the OLDEST deferred job; queued jobs count against headroom", async () => {
    const older = await createJob("deferred");
    const newer = await createJob("deferred");

    // Headroom 1 (cap 1, nothing executing/queued): exactly one promotion, the older row.
    const first = await core.promoteDeferredForWorkspace({ tenantId: tenantA, workspaceId: wsA });
    expect(first.map((j) => j.id)).toEqual([older]);
    expect(await getStatus(older)).toBe("queued");
    expect(await getStatus(newer)).toBe("deferred");

    // The freshly-queued job now occupies the headroom: a second pass promotes nothing.
    const second = await core.promoteDeferredForWorkspace({ tenantId: tenantA, workspaceId: wsA });
    expect(second).toEqual([]);

    // Enumeration feeds the sweep: this workspace is listed while a deferred row exists.
    const listed = await dbm.importJobRepository.listDeferredWorkspaces();
    expect(listed.some((s) => s.workspaceId === wsA)).toBe(true);

    await setStatus(older, "completed");
    await setStatus(newer, "cancelled");
  }, 60_000);
});

describe("S-Q2 — chunk window helper (dormant copy-mode config)", () => {
  test("K bounds the fan-out; 0 is the ∞ sentinel (legacy enqueue-all)", () => {
    expect(core.chunkWindowLimit(2, 5)).toBe(2);
    expect(core.chunkWindowLimit(2, 1)).toBe(1);
    expect(core.chunkWindowLimit(0, 5)).toBe(5);
    expect(core.chunkWindowLimit(undefined, 5)).toBe(5);
  });
});
