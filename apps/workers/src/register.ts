// register.ts — the workers composition root: one shared Redis connection, the queue producers, and the
// processors wired to their queues (16 §3.2). Producers are exported so any app can submit work;
// startWorkers() boots the consumers. As new queues land (CRM sync, outreach delivery, …) register them here.

import { env } from "@leadwolf/config";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { DSAR_QUEUE, type DsarJobData, processDsar } from "./queues/dsar.ts";
import {
  ENRICHMENT_QUEUE,
  type EnrichmentJobData,
  processEnrichment,
} from "./queues/enrichment.ts";
import { IMPORTS_QUEUE, type ImportJobData, processImport } from "./queues/imports.ts";
import { SCORING_QUEUE, type ScoringJobData, processScoring } from "./queues/scoring.ts";

// BullMQ requires maxRetriesPerRequest: null on the blocking connection.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const importQueue = new Queue<ImportJobData>(IMPORTS_QUEUE, { connection });
export const enrichmentQueue = new Queue<EnrichmentJobData>(ENRICHMENT_QUEUE, { connection });
export const scoringQueue = new Queue<ScoringJobData>(SCORING_QUEUE, { connection });
export const dsarQueue = new Queue<DsarJobData>(DSAR_QUEUE, { connection });

/** Submit a parsed import for background processing (the async alternative to the inline api path). */
export async function enqueueImport(data: ImportJobData): Promise<void> {
  await importQueue.add("import", data);
}

/** Submit an on-demand enrichment (09 §2: POST /enrichment/:entity/:id returns a job ref). */
export async function enqueueEnrichment(data: EnrichmentJobData): Promise<string> {
  const job = await enrichmentQueue.add("enrich", data);
  return String(job.id);
}

/** Submit a re-score; the appended scores row syncs contacts.priority_score via trigger. */
export async function enqueueScoring(data: ScoringJobData): Promise<string> {
  const job = await scoringQueue.add("score", data);
  return String(job.id);
}

/** Submit a VERIFIED DSAR for privileged processing (08 §4; the staff workflow enqueues this). */
export async function enqueueDsar(data: DsarJobData): Promise<string> {
  const job = await dsarQueue.add("dsar", data);
  return String(job.id);
}

/** Boot every queue consumer. Returns the workers so the entry can manage their lifecycle. */
export function startWorkers(): Worker[] {
  return [
    new Worker<ImportJobData>(IMPORTS_QUEUE, processImport, { connection }),
    new Worker<EnrichmentJobData>(ENRICHMENT_QUEUE, processEnrichment, { connection }),
    new Worker<ScoringJobData>(SCORING_QUEUE, processScoring, { connection }),
    new Worker<DsarJobData>(DSAR_QUEUE, processDsar, { connection }),
  ];
}
