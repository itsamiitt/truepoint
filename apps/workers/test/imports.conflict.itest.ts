// imports.conflict.itest.ts — Unit 6 DoD proof: the explicit conflict policy (G-IMP-5) is honored end-to-end
// by the worker, and a partial-bad import surfaces the rejected-rows artifact (G-IMP-1) in its summary. Real
// Postgres 16 + Redis 7 via Testcontainers (or external via ITEST_DATABASE_URL + ITEST_REDIS_URL). Named
// *.itest.ts so default `bun test` skips it; run in its OWN process (the db client is a module singleton):
//   bun test apps/workers/test/imports.conflict.itest.ts
//
// Proves: (1) SKIP (the safe default) keeps an existing contact untouched on a match and counts it as a
// duplicate — NOT a silent overwrite (the old G-IMP-5 gap); (2) OVERWRITE updates the matched contact;
// (3) REJECTED rows (no identity key) never land and travel back in summary.rejectedRows with a reason.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IMPORTS_QUEUE, type ImportSummary } from "@leadwolf/types";
import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "../../../packages/db/test/itestDb.ts";
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
let tenantA = "";
let wsA = "";
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
  jobTitle: "Title",
};

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

async function jobTitleOf(workspaceId: string): Promise<string | null> {
  const [r] = await admin`
    SELECT job_title FROM contacts WHERE workspace_id = ${workspaceId} ORDER BY created_at LIMIT 1`;
  return (r as { job_title: string | null } | undefined)?.job_title ?? null;
}

async function countContacts(workspaceId: string): Promise<number> {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${workspaceId}`;
  return (r as { n: number }).n;
}

async function runImportJob(data: ImportJobData): Promise<ImportSummary> {
  const job = await queue.add("import", data, { attempts: 1 });
  return (await job.waitUntilFinished(queueEvents)) as ImportSummary;
}

beforeAll(async () => {
  dbHandle = await startItestDb("imports_conflict");
  redisHandle = await startItestRedis();

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.REDIS_URL = redisHandle.url;

  const { applyMigrations } = await import("../../../packages/db/src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  ({ processImport } = await import("../src/queues/imports.ts"));

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
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
  await redisHandle?.stop();
});

describe("Unit 6 — conflict policy (G-IMP-5) + rejected-rows artifact (G-IMP-1)", () => {
  test("SKIP keeps the existing contact untouched and counts the match as a duplicate", async () => {
    ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("skipco"));
    // Seed an existing contact (title = Original).
    const first = await runImportJob({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "first.csv",
      mapping: MAPPING,
      conflictPolicy: "skip",
      rows: [{ Email: "dup@acme.com", "First Name": "Dup", Title: "Original" }],
    });
    expect(first.created).toBe(1);

    // Re-import the SAME identity with a new title under SKIP — must NOT overwrite.
    const second = await runImportJob({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "second.csv",
      mapping: MAPPING,
      conflictPolicy: "skip",
      rows: [{ Email: "dup@acme.com", "First Name": "Dup", Title: "Changed" }],
    });
    expect(second.created).toBe(0);
    expect(second.matched).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await countContacts(wsA)).toBe(1);
    expect(await jobTitleOf(wsA)).toBe("Original"); // unchanged — no silent last-writer-wins
  }, 60_000);

  test("OVERWRITE updates the matched contact in place", async () => {
    ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("overco"));
    await runImportJob({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "first.csv",
      mapping: MAPPING,
      conflictPolicy: "overwrite",
      rows: [{ Email: "dup@acme.com", "First Name": "Dup", Title: "Original" }],
    });
    const second = await runImportJob({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "second.csv",
      mapping: MAPPING,
      conflictPolicy: "overwrite",
      rows: [{ Email: "dup@acme.com", "First Name": "Dup", Title: "Changed" }],
    });
    expect(second.matched).toBe(1);
    expect(second.duplicates).toBe(0);
    expect(await countContacts(wsA)).toBe(1);
    expect(await jobTitleOf(wsA)).toBe("Changed"); // overwritten
  }, 60_000);

  test("KEEP_BOTH inserts a non-matching row but holds a matching row back as a duplicate (no constraint error)", async () => {
    ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("keepco"));
    await runImportJob({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "first.csv",
      mapping: MAPPING,
      conflictPolicy: "keep_both",
      rows: [{ Email: "existing@acme.com", "First Name": "Existing", Title: "Rep" }],
    });
    const second = await runImportJob({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "second.csv",
      mapping: MAPPING,
      conflictPolicy: "keep_both",
      rows: [
        { Email: "existing@acme.com", "First Name": "Existing", Title: "Changed" }, // matches → duplicate
        { Email: "brandnew@acme.com", "First Name": "New", Title: "Rep" }, // no match → created
      ],
    });
    // The match is held back as a duplicate (NOT a unique-constraint reject), the new identity is created.
    expect(second.created).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(second.rejected).toBe(0); // crucially: keep_both does NOT throw a constraint violation
    expect(second.matched).toBe(0);
    expect(await countContacts(wsA)).toBe(2);
  }, 60_000);

  test("a row with no identity key is REJECTED with a reason and never lands (rejected-rows artifact)", async () => {
    ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("rejco"));
    const summary = await runImportJob({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "mixed.csv",
      mapping: MAPPING,
      conflictPolicy: "skip",
      rows: [
        { Email: "ok@acme.com", "First Name": "Ok", Title: "Rep" }, // valid
        { "First Name": "NoId", Title: "Ghost" }, // rejected: no identity key
      ],
    });
    expect(summary.created).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.rejectedRows).toHaveLength(1);
    expect(summary.rejectedRows[0]?.row).toBe(1);
    expect(summary.rejectedRows[0]?.field).toBeNull();
    expect(summary.rejectedRows[0]?.reason).toContain("no email");
    // The artifact echoes the RAW row so the user can fix and re-import it.
    expect(summary.rejectedRows[0]?.raw["First Name"]).toBe("NoId");
    expect(await countContacts(wsA)).toBe(1);
  }, 60_000);
});
