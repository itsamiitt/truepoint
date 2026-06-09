// register.ts — the workers composition root: one shared Redis connection, the queue producers, and the
// processors wired to their queues (16 §3.2). Producers (enqueueImport) are exported so any app can submit
// work; startWorkers() boots the consumers. As new queues land (enrichment, scoring, …) register them here.

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "@leadwolf/config";
import { IMPORTS_QUEUE, processImport, type ImportJobData } from "./queues/imports.ts";

// BullMQ requires maxRetriesPerRequest: null on the blocking connection.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const importQueue = new Queue<ImportJobData>(IMPORTS_QUEUE, { connection });

/** Submit a parsed import for background processing (the async alternative to the inline api path). */
export async function enqueueImport(data: ImportJobData): Promise<void> {
  await importQueue.add("import", data);
}

/** Boot every queue consumer. Returns the workers so the entry can manage their lifecycle. */
export function startWorkers(): Worker[] {
  const importWorker = new Worker<ImportJobData>(IMPORTS_QUEUE, processImport, { connection });
  return [importWorker];
}
