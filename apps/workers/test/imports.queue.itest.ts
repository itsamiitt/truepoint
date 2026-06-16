// imports.queue.itest.ts — the T-b30a403b Definition-of-Done proof: a parsed import ENQUEUED onto the
// `imports` queue (exactly as the apps/api producer does) is drained by a real BullMQ Worker(processImport)
// and lands contacts under tenant scope, with RLS isolating them for the non-BYPASSRLS leadwolf_app role.
// Real Postgres 16 + real Redis 7 via Testcontainers by default, or external servers via ITEST_DATABASE_URL
// + ITEST_REDIS_URL (CI service containers). Named *.itest.ts so default `bun test` skips it; run explicitly
// in its OWN process (the db client is a module singleton):
//   bun test apps/workers/test/imports.queue.itest.ts
//
// Proves: (1) enqueue → worker → DB round-trip persists the imported contacts for tenant A and the worker's
// processImport returns the new-vs-matched summary; (2) RLS isolates them — a leadwolf_app session scoped to
// tenant B's workspace sees zero of tenant A's contacts, and fails closed when the workspace GUC is unset.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IMPORTS_QUEUE, type ImportSummary } from "@leadwolf/types";
import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "../../../packages/db/test/itestDb.ts";
// Type-only import — erased at runtime, so it does NOT eagerly load the db client (parse stays API-side; the
// payload IS a RunImportInput). processImport itself is loaded lazily below, after DATABASE_URL is set.
import type { ImportJobData } from "../src/queues/imports.ts";

type ImportsModule = typeof import("../src/queues/imports.ts");
let processImport: ImportsModule["processImport"];

interface ItestRedis {
  url: string;
  stop(): Promise<void>;
}

let dbHandle: ItestDb;
let redisHandle: ItestRedis;
let admin: ReturnType<typeof postgres>;
let appUrl = "";
let tenantA = "";
let wsA = "";
let wsB = "";
let ownerA = "";

let queueConn: IORedis;
let workerConn: IORedis;
let eventsConn: IORedis;
let queue: Queue<ImportJobData>;
let worker: Worker<ImportJobData, ImportSummary>;
let queueEvents: QueueEvents;

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
// Two distinct identities → two contacts created.
const ROWS = [
  { Email: "jane@acme.com", "First Name": "Jane", "Last Name": "Doe", Company: "Acme", Domain: "acme.com" },
  { Email: "john@acme.com", "First Name": "John", "Last Name": "Roe", Company: "Acme", Domain: "acme.com" },
];

async function startItestRedis(): Promise<ItestRedis> {
  const external = process.env.ITEST_REDIS_URL;
  if (external) return { url: external, stop: async () => {} };
  // Throwaway container (requires Docker). Mirrors docker-compose.yml's redis:7 (no persistence).
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

async function countContacts(workspaceId: string): Promise<number> {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${workspaceId}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("imports_queue");
  redisHandle = await startItestRedis();

  // Bind config/db to the test database BEFORE importing the worker (which pulls in @leadwolf/core → db).
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.REDIS_URL = redisHandle.url;
  appUrl = dbHandle.appUrl;

  const { applyMigrations } = await import("../../../packages/db/src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ workspaceId: wsB } = await seedWorkspace("globex"));

  ({ processImport } = await import("../src/queues/imports.ts"));

  // Real BullMQ producer + consumer over the shared queue name — the exact apps/api → apps/workers path.
  // BullMQ requires maxRetriesPerRequest: null on its blocking connections.
  queueConn = new IORedis(redisHandle.url, { maxRetriesPerRequest: null });
  workerConn = new IORedis(redisHandle.url, { maxRetriesPerRequest: null });
  eventsConn = new IORedis(redisHandle.url, { maxRetriesPerRequest: null });
  queue = new Queue<ImportJobData>(IMPORTS_QUEUE, { connection: queueConn });
  queueEvents = new QueueEvents(IMPORTS_QUEUE, { connection: eventsConn });
  await queueEvents.waitUntilReady();
  worker = new Worker<ImportJobData, ImportSummary>(IMPORTS_QUEUE, processImport, {
    connection: workerConn,
  });
  await worker.waitUntilReady();
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await queueEvents?.close();
  await queue?.close();
  await queueConn?.quit();
  await workerConn?.quit();
  await eventsConn?.quit();
  // Drain the @leadwolf/db singleton pool — its open sockets otherwise keep the runner alive.
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
  await redisHandle?.stop();
});

describe("T-b30a403b async import DoD: enqueue → worker → DB, RLS-scoped", () => {
  test(
    "a queued import is drained by the worker and persists tenant A's contacts",
    async () => {
      const data: ImportJobData = {
        scope: { tenantId: tenantA, workspaceId: wsA },
        importedByUserId: ownerA,
        sourceName: "manual",
        sourceFile: "acme.csv",
        mapping: MAPPING,
        rows: ROWS,
      };
      const job = await queue.add("import", data);
      const summary = (await job.waitUntilFinished(queueEvents)) as ImportSummary;

      expect(summary.created).toBe(2);
      expect(summary.matched).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.errors).toHaveLength(0);
      expect(await countContacts(wsA)).toBe(2);
    },
    60_000,
  );

  test("RLS isolates the imported contacts for leadwolf_app and fails closed when the GUC is unset", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const seenA = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM contacts`;
        return (r as { n: number }).n;
      });
      expect(seenA).toBe(2);

      const seenB = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM contacts`;
        return (r as { n: number }).n;
      });
      expect(seenB).toBe(0);

      const seenUnset = await app.begin(async (tx) => {
        const [r] = await tx`SELECT count(*)::int AS n FROM contacts`;
        return (r as { n: number }).n;
      });
      expect(seenUnset).toBe(0);
    } finally {
      await app.end();
    }
  });
});
