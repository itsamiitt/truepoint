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
import {
  MASTER_BACKFILL_QUEUE,
  type MasterBackfillJobData,
  processMasterBackfill,
} from "./queues/masterBackfill.ts";
import {
  MASTER_BACKFILL_SWEEP_QUEUE,
  type MasterBackfillSweepJobData,
  makeProcessMasterBackfillSweep,
} from "./queues/masterBackfillSweep.ts";
import { OUTREACH_QUEUE, type OutreachJobData, processOutreach } from "./queues/outreach.ts";
import {
  RETENTION_SWEEP_QUEUE,
  type RetentionSweepJobData,
  makeProcessRetentionSweep,
} from "./queues/retentionSweep.ts";
import { SCORING_QUEUE, type ScoringJobData, processScoring } from "./queues/scoring.ts";
import {
  EMAIL_SEQUENCE_TICK_QUEUE,
  type SequenceTickJobData,
  makeProcessSequenceTick,
} from "./queues/sequenceTick.ts";
import {
  REVERIFICATION_QUEUE,
  type ReverificationJobData,
  processReverification,
} from "./queues/reverification.ts";
import {
  REVERIFICATION_SWEEP_QUEUE,
  type ReverificationSweepJobData,
  makeProcessReverificationSweep,
} from "./queues/reverificationSweep.ts";
import {
  DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE,
  type DataQualitySnapshotSweepJobData,
  makeProcessDataQualitySnapshotSweep,
} from "./queues/dataQualitySnapshotSweep.ts";

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
// Master-link backfill: re-resolves overlay contacts with NULL master_* bridges through the Phase-2′ resolver,
// per-workspace, batched + idempotent (PLAN_00 §11.5 / PLAN_07 Stage B).
export const masterBackfillQueue = new Queue<MasterBackfillJobData>(MASTER_BACKFILL_QUEUE, {
  connection,
});
// The scheduled fleet sweep that DRIVES the per-workspace backfill (PLAN_07 Stage B): one repeatable daily job
// enumerates workspaces with unresolved contacts and enqueues a per-workspace backfill for each.
export const masterBackfillSweepQueue = new Queue<MasterBackfillSweepJobData>(
  MASTER_BACKFILL_SWEEP_QUEUE,
  { connection },
);
// M12 P4: the leader-locked sequence scheduler (email_sequence_tick). A single repeatable job (stable
// jobId → deduped) fires every minute; the processor takes the Redis leader lock and claims due enrollments.
export const sequenceTickQueue = new Queue<SequenceTickJobData>(EMAIL_SEQUENCE_TICK_QUEUE, {
  connection,
});
// M12 P6: the daily leader-locked retention sweep (expired idempotency keys; cold partition DROP later).
export const retentionSweepQueue = new Queue<RetentionSweepJobData>(RETENTION_SWEEP_QUEUE, {
  connection,
});
// Freshness re-verification (ADR-0025): a per-workspace queue + the leader-locked daily sweep that fans out to it.
export const reverificationQueue = new Queue<ReverificationJobData>(REVERIFICATION_QUEUE, {
  connection,
});
export const reverificationSweepQueue = new Queue<ReverificationSweepJobData>(
  REVERIFICATION_SWEEP_QUEUE,
  { connection },
);
// Data Health snapshot (10 §5): the leader-locked daily sweep that captures a per-workspace trend point.
export const dataQualitySnapshotSweepQueue = new Queue<DataQualitySnapshotSweepJobData>(
  DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE,
  { connection },
);

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

/** Register the daily retention sweep (M12 P6). Stable jobId → exactly one repeatable. */
export async function scheduleRetentionSweep(): Promise<void> {
  await retentionSweepQueue.add(
    "sweep",
    {},
    { repeat: { every: 24 * 60 * 60_000 }, jobId: "email-retention-sweep" },
  );
}

/** Register the daily master-backfill sweep (PLAN_07 Stage B). Stable jobId → exactly one repeatable. */
export async function scheduleMasterBackfillSweep(): Promise<void> {
  await masterBackfillSweepQueue.add(
    "sweep",
    {},
    { repeat: { every: 24 * 60 * 60_000 }, jobId: "master-backfill-sweep" },
  );
}

/** Submit a per-workspace freshness re-verification (ADR-0025; from the sweep or on demand). Idempotent —
 *  only still-stale rows are touched — so a couple of backoff retries cover a transient verifier outage. */
export async function enqueueReverification(
  scope: { tenantId: string; workspaceId: string },
  opts?: { batchSize?: number },
): Promise<string> {
  const job = await reverificationQueue.add(
    "reverify",
    { scope, batchSize: opts?.batchSize },
    { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
  );
  return String(job.id);
}

/** Register the daily reverification sweep (ADR-0025). Stable jobId → exactly one repeatable. */
export async function scheduleReverificationSweep(): Promise<void> {
  await reverificationSweepQueue.add(
    "sweep",
    {},
    { repeat: { every: 24 * 60 * 60_000 }, jobId: "reverification-sweep" },
  );
}

/** Register the daily Data Health snapshot sweep (10 §5). Stable jobId → exactly one repeatable. */
export async function scheduleDataQualitySnapshotSweep(): Promise<void> {
  await dataQualitySnapshotSweepQueue.add(
    "sweep",
    {},
    { repeat: { every: 24 * 60 * 60_000 }, jobId: "data-quality-snapshot-sweep" },
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

/** Submit a per-workspace master-link backfill (PLAN_00 §11.5; e.g. one-off attach or on a schedule). */
export async function enqueueMasterBackfill(
  scope: { tenantId: string; workspaceId: string },
  opts?: { batchSize?: number },
): Promise<string> {
  const job = await masterBackfillQueue.add(
    "master-backfill",
    { scope, batchSize: opts?.batchSize },
    // Self-heal: if the processor throws (a row errored — see processMasterBackfill) BullMQ retries from a fresh
    // scan with exponential backoff. The job is idempotent (only still-NULL rows are re-resolved), so a retry
    // never double-mints; a keyless-only leftover succeeds (no throw) and never burns the retry budget.
    { attempts: 4, backoff: { type: "exponential", delay: 30_000 } },
  );
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
    // A completed import may have left rows with NULL master bridges (a resolution that failed non-fatally =
    // in-flight staging). Kick the idempotent per-workspace backfill so they resolve promptly rather than
    // waiting for the daily sweep. Best-effort — a failed enqueue never fails the import.
    void enqueueMasterBackfill(data).catch((e) =>
      log.error("imports: master-backfill enqueue failed", {
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
    // Master-link backfill consumer: per-workspace, idempotent re-resolution of NULL master_* bridges.
    instrument(
      new Worker<MasterBackfillJobData>(MASTER_BACKFILL_QUEUE, processMasterBackfill, {
        connection,
      }),
      MASTER_BACKFILL_QUEUE,
    ),
    // Master-link backfill SWEEP consumer (PLAN_07 Stage B): the leader-locked daily fan-out that enqueues a
    // per-workspace backfill for every workspace with unresolved contacts. enqueueMasterBackfill is injected.
    instrument(
      new Worker<MasterBackfillSweepJobData>(
        MASTER_BACKFILL_SWEEP_QUEUE,
        makeProcessMasterBackfillSweep(connection, enqueueMasterBackfill),
        { connection },
      ),
      MASTER_BACKFILL_SWEEP_QUEUE,
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
    // M12 P6: the retention sweep consumer (leader-locked daily).
    instrument(
      new Worker<RetentionSweepJobData>(
        RETENTION_SWEEP_QUEUE,
        makeProcessRetentionSweep(connection),
        { connection },
      ),
      RETENTION_SWEEP_QUEUE,
    ),
    // Freshness re-verification per-workspace consumer (ADR-0025): re-grades stale revealed contacts.
    instrument(
      new Worker<ReverificationJobData>(REVERIFICATION_QUEUE, processReverification, { connection }),
      REVERIFICATION_QUEUE,
    ),
    // Freshness re-verification SWEEP consumer: leader-locked daily fan-out enqueuing a per-workspace
    // re-verification for every workspace with stale revealed contacts. enqueueReverification is injected.
    instrument(
      new Worker<ReverificationSweepJobData>(
        REVERIFICATION_SWEEP_QUEUE,
        makeProcessReverificationSweep(connection, enqueueReverification),
        { connection },
      ),
      REVERIFICATION_SWEEP_QUEUE,
    ),
    // Data Health snapshot SWEEP consumer: leader-locked daily capture of a per-workspace trend point.
    instrument(
      new Worker<DataQualitySnapshotSweepJobData>(
        DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE,
        makeProcessDataQualitySnapshotSweep(connection),
        { connection },
      ),
      DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE,
    ),
  ];
  void scheduleSequenceTick().catch((e) =>
    log.error("failed to schedule the sequence tick", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  void scheduleRetentionSweep().catch((e) =>
    log.error("failed to schedule the retention sweep", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  void scheduleMasterBackfillSweep().catch((e) =>
    log.error("failed to schedule the master-backfill sweep", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  void scheduleReverificationSweep().catch((e) =>
    log.error("failed to schedule the reverification sweep", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  void scheduleDataQualitySnapshotSweep().catch((e) =>
    log.error("failed to schedule the data-quality snapshot sweep", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  return workers;
}
