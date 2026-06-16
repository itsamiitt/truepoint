// queue.ts — the import feature's BullMQ *producer*. The API parses the CSV, then enqueues a RunImportInput
// onto the shared `imports` queue; the apps/workers *consumer* (processImport) drains it and runs the SAME
// packages/core pipeline (one implementation, two transports — 16 §3.2). Producer and consumer are decoupled
// by BullMQ: they share only the queue NAME (IMPORTS_QUEUE, @leadwolf/types) and the Redis URL
// (env.REDIS_URL) — never each other's code, so the `apps-never-import-apps` boundary holds (16 §5).

import { env } from "@leadwolf/config";
import type { RunImportInput } from "@leadwolf/core";
import { IMPORTS_QUEUE } from "@leadwolf/types";
import { type Job, Queue } from "bullmq";
import IORedis from "ioredis";

/** The job payload IS a RunImportInput — rows are parsed on the API before enqueue (parse stays API-side, M1). */
export type ImportJobData = RunImportInput;

// Lazily opened on first use so merely importing this module (e.g. mounting the router) never dials Redis.
// BullMQ requires maxRetriesPerRequest: null on its connection.
let queue: Queue<ImportJobData> | undefined;
function importQueue(): Queue<ImportJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<ImportJobData>(IMPORTS_QUEUE, {
      connection,
      defaultJobOptions: {
        // Retry transient/systemic failures with exponential backoff; the worker dead-letters on exhaustion.
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        // Retain terminal jobs briefly so the status endpoint can be polled after the job settles.
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/** Enqueue a parsed import for background processing; returns the BullMQ job id the importer can poll. */
export async function enqueueImport(data: ImportJobData): Promise<string> {
  const job = await importQueue().add("import", data);
  return String(job.id);
}

/** Fetch an import job by id for status polling; undefined if unknown (never enqueued, or evicted). */
export async function getImportJob(jobId: string): Promise<Job<ImportJobData> | undefined> {
  return importQueue().getJob(jobId);
}
