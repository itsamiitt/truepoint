// register.ts — the workers composition root: one shared Redis connection, the queue producers, and the
// processors wired to their queues (16 §3.2). Producers are exported so any app can submit work;
// startWorkers() boots the consumers. As new queues land (CRM sync, outreach delivery, …) register them here.

import { env } from "@leadwolf/config";
import type { ImportDeadLetter } from "@leadwolf/types";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { log } from "./logger.ts";
import { DEDUP_QUEUE, type DedupJobData, processDedup } from "./queues/dedup.ts";
import { DSAR_QUEUE, type DsarJobData, processDsar } from "./queues/dsar.ts";
import {
  ENRICHMENT_QUEUE,
  type EnrichmentJobData,
  processEnrichment,
} from "./queues/enrichment.ts";
import {
  FIRMOGRAPHICS_QUEUE,
  type FirmographicsJobData,
  processFirmographics,
} from "./queues/firmographics.ts";
import {
  IMPORTS_DLQ,
  IMPORTS_QUEUE,
  type ImportJobData,
  deadLetterFailedImport,
  processImport,
} from "./queues/imports.ts";
import { OUTREACH_QUEUE, type OutreachJobData, processOutreach } from "./queues/outreach.ts";
import { SCORING_QUEUE, type ScoringJobData, processScoring } from "./queues/scoring.ts";
import {
  EMAIL_SEQUENCE_TICK_QUEUE,
  type SequenceTickJobData,
  makeProcessSequenceTick,
} from "./queues/sequenceTick.ts";

// BullMQ requires maxRetriesPerRequest: null on the blocking connection.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const importQueue = new Queue<ImportJobData>(IMPORTS_QUEUE, { connection });
/** Dead-letter holding queue for import jobs that exhaust their retries (PII-free records). */
export const importDeadLetterQueue = new Queue<ImportDeadLetter>(IMPORTS_DLQ, { connection });
export const enrichmentQueue = new Queue<EnrichmentJobData>(ENRICHMENT_QUEUE, { connection });
export const scoringQueue = new Queue<ScoringJobData>(SCORING_QUEUE, { connection });
export const dsarQueue = new Queue<DsarJobData>(DSAR_QUEUE, { connection });
export const outreachQueue = new Queue<OutreachJobData>(OUTREACH_QUEUE, { connection });
export const dedupQueue = new Queue<DedupJobData>(DEDUP_QUEUE, { connection });
export const firmographicsQueue = new Queue<FirmographicsJobData>(FIRMOGRAPHICS_QUEUE, {
  connection,
});
// M12 P4: the leader-locked sequence scheduler (email_sequence_tick). A single repeatable job (stable
// jobId → deduped) fires every minute; the processor takes the Redis leader lock and claims due enrollments.
export const sequenceTickQueue = new Queue<SequenceTickJobData>(EMAIL_SEQUENCE_TICK_QUEUE, {
  connection,
});

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

/** Submit one enrollment-step delivery (05 §13; step delays arrive as BullMQ job delays). */
export async function enqueueOutreach(data: OutreachJobData, delayMs = 0): Promise<string> {
  const job = await outreachQueue.add("send", data, delayMs > 0 ? { delay: delayMs } : undefined);
  return String(job.id);
}

/** Register the single repeatable sequence-tick job (M12 P4). Stable jobId → BullMQ keeps exactly one. */
export async function scheduleSequenceTick(): Promise<void> {
  await sequenceTickQueue.add(
    "tick",
    {},
    { repeat: { every: 60_000 }, jobId: "email-sequence-tick" },
  );
}

/** Submit a per-workspace contact dedup pass (24 Phase-0.5; e.g. after an import or on a schedule). */
export async function enqueueDedup(data: DedupJobData): Promise<string> {
  const job = await dedupQueue.add("dedup", data);
  return String(job.id);
}

/** Submit a per-workspace firmographics rollup (24 Phase-0.5; surfaces intent_signals onto account facets). */
export async function enqueueFirmographics(data: FirmographicsJobData): Promise<string> {
  const job = await firmographicsQueue.add("firmographics", data);
  return String(job.id);
}

/** Attach structured completed/failed logging to a worker (per-queue observability). Never logs payloads. */
function instrument<T = unknown>(worker: Worker<T>, queue: string): Worker<T> {
  worker.on("completed", (job) => log.info("job completed", { queue, jobId: job.id }));
  worker.on("failed", (job, err) =>
    log.error("job failed", {
      queue,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err.message,
    }),
  );
  return worker;
}

/** Boot every queue consumer. Returns the workers so the entry can manage their lifecycle. */
export function startWorkers(): Worker[] {
  const importsWorker = instrument(
    new Worker<ImportJobData>(IMPORTS_QUEUE, processImport, { connection }),
    IMPORTS_QUEUE,
  );
  // Import jobs that exhaust their retries are dead-lettered (PII-free) for ops triage instead of being lost.
  importsWorker.on("failed", (job, err) => {
    void deadLetterFailedImport(importDeadLetterQueue, job, err).catch((e) =>
      log.error("imports: dead-letter routing failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  });
  // A completed import is where cross-source duplicates appear and new signals land → kick the (idempotent,
  // off-thread) per-workspace rollups so the duplicate + firmographic search facets stay current. Best-effort:
  // a rollup-enqueue failure never fails the import.
  importsWorker.on("completed", (job) => {
    const scope = job?.data?.scope;
    if (!scope) return;
    const data = { tenantId: scope.tenantId, workspaceId: scope.workspaceId };
    void enqueueDedup(data).catch((e) =>
      log.error("imports: dedup enqueue failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    void enqueueFirmographics(data).catch((e) =>
      log.error("imports: firmographics enqueue failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  });
  const workers = [
    importsWorker,
    instrument(
      new Worker<EnrichmentJobData>(ENRICHMENT_QUEUE, processEnrichment, { connection }),
      ENRICHMENT_QUEUE,
    ),
    instrument(
      new Worker<ScoringJobData>(SCORING_QUEUE, processScoring, { connection }),
      SCORING_QUEUE,
    ),
    instrument(new Worker<DsarJobData>(DSAR_QUEUE, processDsar, { connection }), DSAR_QUEUE),
    instrument(
      new Worker<OutreachJobData>(OUTREACH_QUEUE, processOutreach, { connection }),
      OUTREACH_QUEUE,
    ),
    instrument(new Worker<DedupJobData>(DEDUP_QUEUE, processDedup, { connection }), DEDUP_QUEUE),
    instrument(
      new Worker<FirmographicsJobData>(FIRMOGRAPHICS_QUEUE, processFirmographics, { connection }),
      FIRMOGRAPHICS_QUEUE,
    ),
    // M12 P4: the sequence-tick consumer. Leader-locked; claims due enrollments and enqueues each onto the
    // outreach queue (the existing send path). Best-effort registers the single repeatable job at boot.
    instrument(
      new Worker<SequenceTickJobData>(
        EMAIL_SEQUENCE_TICK_QUEUE,
        makeProcessSequenceTick(connection, async (e) => {
          // A per-(enrollment, target-step) jobId dedupes a re-claim across ticks: if a still-pending send for
          // this exact step is already queued, BullMQ keeps one — so a step is never advanced twice (P4 §A.4).
          await outreachQueue.add(
            "send",
            { tenantId: e.tenantId, workspaceId: e.workspaceId, logId: e.logId },
            { jobId: `seqstep:${e.logId}:${e.currentStep + 1}` },
          );
        }),
        { connection },
      ),
      EMAIL_SEQUENCE_TICK_QUEUE,
    ),
  ];
  void scheduleSequenceTick().catch((e) =>
    log.error("failed to schedule the sequence tick", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  return workers;
}
