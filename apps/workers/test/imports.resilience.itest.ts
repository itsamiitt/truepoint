// imports.resilience.itest.ts — the T-704632ee Definition-of-Done proof: import observability + resilience.
// Real Postgres 16 + Redis 7 via Testcontainers (or external via ITEST_DATABASE_URL + ITEST_REDIS_URL). Named
// *.itest.ts so default `bun test` skips it; run in its OWN process (the db client is a module singleton):
//   bun test apps/workers/test/imports.resilience.itest.ts
//
// Proves: (1) STATUS/PROGRESS — a partial-bad import COMPLETES, the worker reports progress via
// job.updateProgress, and the per-row errors are surfaced on the job's returnvalue (what GET /import/:jobId
// reads). (2) RETRY + DEAD-LETTER — an import where every row fails throws, BullMQ retries it to exhaustion,
// and a PII-FREE record (no raw rows) lands in the dead-letter queue with the right scope + attemptsMade.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  IMPORTS_DLQ,
  IMPORTS_QUEUE,
  type ImportDeadLetter,
  type ImportProgress,
  type ImportSummary,
} from "@leadwolf/types";
import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "../../../packages/db/test/itestDb.ts";
import type { ImportJobData } from "../src/queues/imports.ts";

type ImportsModule = typeof import("../src/queues/imports.ts");
let processImport: ImportsModule["processImport"];
let deadLetterFailedImport: ImportsModule["deadLetterFailedImport"];

interface ItestRedis {
  url: string;
  stop(): Promise<void>;
}

let dbHandle: ItestDb;
let redisHandle: ItestRedis;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let wsA = "";
let ownerA = "";

let queueConn: IORedis;
let workerConn: IORedis;
let eventsConn: IORedis;
let dlqConn: IORedis;
let queue: Queue<ImportJobData>;
let worker: Worker<ImportJobData, ImportSummary>;
let queueEvents: QueueEvents;
let dlq: Queue<ImportDeadLetter>;

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
// One importable identity (jane has an email) + one un-importable row (no email/linkedin/sales-nav id).
const MIXED_ROWS = [
  { Email: "jane@acme.com", "First Name": "Jane", "Last Name": "Doe", Company: "Acme", Domain: "acme.com" },
  { "First Name": "NoId", "Last Name": "Person", Company: "Ghost", Domain: "ghost.com" },
];
// Both rows lack any identity key → every row errors → zero progress → job-level failure.
const ALL_BAD_ROWS = [
  { "First Name": "A", "Last Name": "One", Company: "Acme", Domain: "acme.com" },
  { "First Name": "B", "Last Name": "Two", Company: "Acme", Domain: "acme.com" },
];

async function startItestRedis(): Promise<ItestRedis> {
  const external = process.env.ITEST_REDIS_URL;
  if (external) return { url: external, stop: async () => {} };
  const { GenericContainer } = await import("testcontainers");
  const container = await new GenericContainer("redis:7")
    .withExposedPorts(6379)
    .withCommand(["redis-server", "--save", "", "--appendonly", "no"])
    .start();
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  return {
    url,
    stop: async () => {
      await container.stop();
    },
  };
}

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

/** Poll until `pred` is truthy or the timeout elapses (Date.now/setTimeout are fine under bun:test). */
async function until(pred: () => Promise<boolean>, timeoutMs = 15_000, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("condition not met within timeout");
}

beforeAll(async () => {
  dbHandle = await startItestDb("imports_resilience");
  redisHandle = await startItestRedis();

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.REDIS_URL = redisHandle.url;

  const { applyMigrations } = await import("../../../packages/db/src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));

  ({ processImport, deadLetterFailedImport } = await import("../src/queues/imports.ts"));

  queueConn = new IORedis(redisHandle.url, { maxRetriesPerRequest: null });
  workerConn = new IORedis(redisHandle.url, { maxRetriesPerRequest: null });
  eventsConn = new IORedis(redisHandle.url, { maxRetriesPerRequest: null });
  dlqConn = new IORedis(redisHandle.url, { maxRetriesPerRequest: null });
  queue = new Queue<ImportJobData>(IMPORTS_QUEUE, { connection: queueConn });
  queueEvents = new QueueEvents(IMPORTS_QUEUE, { connection: eventsConn });
  await queueEvents.waitUntilReady();
  dlq = new Queue<ImportDeadLetter>(IMPORTS_DLQ, { connection: dlqConn });
  worker = new Worker<ImportJobData, ImportSummary>(IMPORTS_QUEUE, processImport, {
    connection: workerConn,
  });
  // The exact dead-letter wiring register.ts uses in production.
  worker.on("failed", (job, err) => {
    void deadLetterFailedImport(dlq, job, err).catch(() => {});
  });
  await worker.waitUntilReady();
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await queueEvents?.close();
  await queue?.close();
  await dlq?.close();
  await queueConn?.quit();
  await workerConn?.quit();
  await eventsConn?.quit();
  await dlqConn?.quit();
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
  await redisHandle?.stop();
});

describe("T-704632ee import observability + resilience DoD", () => {
  test(
    "a partial-bad import completes, surfaces per-row errors, and reports progress (status read)",
    async () => {
      const data: ImportJobData = {
        scope: { tenantId: tenantA, workspaceId: wsA },
        importedByUserId: ownerA,
        sourceName: "manual",
        sourceFile: "mixed.csv",
        mapping: MAPPING,
        rows: MIXED_ROWS,
      };
      const job = await queue.add("import", data, { attempts: 1 });
      const summary = (await job.waitUntilFinished(queueEvents)) as ImportSummary;

      // One imported, one row errored — the import did NOT fail the job (partial progress).
      expect(summary.created).toBe(1);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]?.row).toBe(1); // the second (0-based) row had no identity key

      // What GET /import/:jobId reads back: completed state, the reported progress, and the summary.
      const fresh = await queue.getJob(String(job.id));
      expect(fresh).toBeDefined();
      expect(await fresh!.getState()).toBe("completed");
      const progress = fresh!.progress as ImportProgress;
      expect(progress.total).toBe(2);
      expect(progress.created).toBe(1);
      expect(progress.failed).toBe(1);
      expect((fresh!.returnvalue as ImportSummary).created).toBe(1);
    },
    60_000,
  );

  test(
    "an all-failed import retries to exhaustion and dead-letters a PII-free record",
    async () => {
      const data: ImportJobData = {
        scope: { tenantId: tenantA, workspaceId: wsA },
        importedByUserId: ownerA,
        sourceName: "manual",
        sourceFile: "all-bad.csv",
        mapping: MAPPING,
        rows: ALL_BAD_ROWS,
      };
      await queue.add("import", data, {
        attempts: 2,
        backoff: { type: "fixed", delay: 100 },
      });

      // After 2 attempts both fail, the worker dead-letters the job.
      await until(async () => (await dlq.getWaitingCount()) >= 1);

      const [dead] = await dlq.getJobs(["waiting"]);
      expect(dead).toBeDefined();
      const record = dead!.data as ImportDeadLetter;
      expect(record.workspaceId).toBe(wsA);
      expect(record.tenantId).toBe(tenantA);
      expect(record.attemptsMade).toBe(2);
      expect(record.failedReason).toContain("no progress");

      // PII-free: the dead-letter record carries scope + provenance only, NEVER the raw rows.
      expect(Object.keys(record).sort()).toEqual(
        [
          "attemptsMade",
          "failedReason",
          "importedByUserId",
          "originalJobId",
          "sourceFile",
          "sourceName",
          "tenantId",
          "workspaceId",
        ].sort(),
      );
      expect(JSON.stringify(record)).not.toContain("First Name");
    },
    60_000,
  );
});
