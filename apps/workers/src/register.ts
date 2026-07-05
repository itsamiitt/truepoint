// register.ts — the workers composition root: one shared Redis connection, the queue producers, and the
// processors wired to their queues (16 §3.2). Producers are exported so any app can submit work;
// startWorkers() boots the consumers. As new queues land (CRM sync, outreach delivery, …) register them here.

import { env } from "@leadwolf/config";
import {
  FastImportFailedError,
  defaultEmailVerifier,
  defaultPhoneVerifier,
  diskFileStore,
  markFastImportFailed,
  registerEmailProviders,
} from "@leadwolf/core";
import { db, notificationRepository, outboxRepository } from "@leadwolf/db";
import { defaultProviders } from "@leadwolf/integrations";
import {
  BULK_ENRICHMENT_DRIVE_TOPIC,
  type BulkEnrichmentDeadLetter,
  type BulkImportDeadLetter,
  type BulkImportScope,
  type BulkRevealDeadLetter,
  type ImportDeadLetter,
  bulkEnrichmentJobDataSchema,
} from "@leadwolf/types";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { type WorkerDeadLetter, extractScope, makeDeadLetterHandler } from "./deadLetter.ts";
import { log } from "./logger.ts";
import { createRedisMailboxThrottle } from "./mailboxThrottle.ts";
import {
  type QueueDepth,
  recordCompleted,
  recordFailed,
  renderPromMetrics,
} from "./metrics.ts";
import { type OutboxRelayHandle, startOutboxRelay } from "./outboxRelay.ts";
import {
  BILLING_RECON_SWEEP_QUEUE,
  type BillingReconSweepJobData,
  makeProcessBillingReconSweep,
} from "./queues/billingReconSweep.ts";
import {
  BULK_ENRICHMENT_DLQ,
  BULK_ENRICHMENT_QUEUE,
  type BulkEnrichmentJobData,
  deadLetterFailedBulkEnrichment,
  makeProcessBulkEnrichment,
} from "./queues/bulkEnrichment.ts";
import {
  BULK_IMPORTS_DLQ,
  BULK_IMPORTS_QUEUE,
  type BulkImportJobData,
  type UnifiedImportJobData,
  deadLetterFailedBulkImport,
  makeProcessBulkImport,
} from "./queues/bulkImports.ts";
import {
  BULK_REVEAL_DLQ,
  BULK_REVEAL_QUEUE,
  type BulkRevealJobData,
  deadLetterFailedBulkReveal,
  makeProcessBulkReveal,
} from "./queues/bulkReveal.ts";
import {
  DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE,
  type DataQualitySnapshotSweepJobData,
  makeProcessDataQualitySnapshotSweep,
} from "./queues/dataQualitySnapshotSweep.ts";
import {
  DATA_RETENTION_SWEEP_QUEUE,
  type DataRetentionSweepJobData,
  makeProcessDataRetentionSweep,
} from "./queues/dataRetentionSweep.ts";
import { DEDUP_DLQ, DEDUP_QUEUE, type DedupJobData, processDedup } from "./queues/dedup.ts";
import { DSAR_DLQ, DSAR_QUEUE, type DsarJobData, processDsar } from "./queues/dsar.ts";
import {
  ENRICHMENT_DLQ,
  ENRICHMENT_QUEUE,
  type EnrichmentJobData,
  processEnrichment,
} from "./queues/enrichment.ts";
import { ER_SWEEP_QUEUE, type ErSweepJobData, makeProcessErSweep } from "./queues/erSweep.ts";
import {
  FIRMOGRAPHICS_DLQ,
  FIRMOGRAPHICS_QUEUE,
  type FirmographicsJobData,
  processFirmographics,
} from "./queues/firmographics.ts";
import {
  GMAIL_INBOX_POLL_QUEUE,
  type GmailInboxPollJobData,
  makeProcessGmailInboxPoll,
} from "./queues/gmailInboxPollSweep.ts";
import {
  IMPORTS_DLQ,
  IMPORTS_QUEUE,
  type ImportJobData,
  deadLetterFailedImport,
  processImport,
} from "./queues/imports.ts";
import {
  LEDGER_BACKFILL_SWEEP_QUEUE,
  type LedgerBackfillSweepJobData,
  makeProcessLedgerBackfillSweep,
} from "./queues/ledgerBackfillSweep.ts";
import {
  LOW_BALANCE_NOTIFIER_SWEEP_QUEUE,
  type LowBalanceNotifierSweepJobData,
  makeProcessLowBalanceNotifierSweep,
} from "./queues/lowBalanceNotifierSweep.ts";
import {
  MASTER_BACKFILL_DLQ,
  MASTER_BACKFILL_QUEUE,
  type MasterBackfillJobData,
  processMasterBackfill,
} from "./queues/masterBackfill.ts";
import {
  MASTER_BACKFILL_SWEEP_QUEUE,
  type MasterBackfillSweepJobData,
  makeProcessMasterBackfillSweep,
} from "./queues/masterBackfillSweep.ts";
import {
  OUTREACH_DLQ,
  OUTREACH_QUEUE,
  type OutreachJobData,
  makeProcessOutreach,
} from "./queues/outreach.ts";
import {
  PROJECTION_SWEEP_QUEUE,
  type ProjectionSweepJobData,
  makeProcessProjectionSweep,
} from "./queues/projectionSweep.ts";
import {
  RETENTION_SWEEP_QUEUE,
  type RetentionSweepJobData,
  makeProcessRetentionSweep,
} from "./queues/retentionSweep.ts";
import {
  REVERIFICATION_DLQ,
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
  SCORING_DLQ,
  SCORING_QUEUE,
  type ScoringJobData,
  processScoring,
} from "./queues/scoring.ts";
import {
  EMAIL_SEQUENCE_TICK_QUEUE,
  type SequenceTickJobData,
  makeProcessSequenceTick,
} from "./queues/sequenceTick.ts";
import {
  SUBSCRIPTION_DUNNING_SWEEP_QUEUE,
  type SubscriptionDunningSweepJobData,
  makeProcessSubscriptionDunningSweep,
} from "./queues/subscriptionDunningSweep.ts";
import {
  SUBSCRIPTION_GRANT_SWEEP_QUEUE,
  type SubscriptionGrantSweepJobData,
  makeProcessSubscriptionGrantSweep,
} from "./queues/subscriptionGrantSweep.ts";
import {
  EMAIL_TOKEN_REFRESH_QUEUE,
  type TokenRefreshJobData,
  makeProcessTokenRefresh,
} from "./queues/tokenRefresh.ts";
import { startRealtimeRelay } from "./realtimeRelay.ts";
import {
  DSAR_RETRY,
  ENRICHMENT_RETRY,
  MASTER_BACKFILL_RETRY,
  OUTREACH_RETRY,
  REVERIFICATION_RETRY,
  SCORING_RETRY,
} from "./retryPolicies.ts";
import { SWEEP_WORKER_TUNING, deadlineMs, eventTuning } from "./tuning.ts";
import { withDeadline } from "./withDeadline.ts";

// BullMQ requires maxRetriesPerRequest: null on the blocking connection.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

/** Bounded Redis readiness probe (worker-platform plan 15 §2.2 item 0.3 / re-audit F14). With
 *  maxRetriesPerRequest: null (required by BullMQ, above) a wedged Redis makes ioredis reconnect forever and
 *  BUFFER commands instead of erroring — a bare PING would hang, so racing it against a timeout is the only
 *  reliable detection. Never throws; the health server gates it behind a consecutive-failure threshold.
 *  Caveat (F14): BullMQ duplicates blocking-consumer clients internally, so this probes the shared connection
 *  as a same-endpoint proxy; probing the blocking client directly comes with the per-role connection split. */
export async function redisReadinessProbe(timeoutMs = 500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pong = await Promise.race([
      connection.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("redis ping timed out")), timeoutMs);
      }),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
// The scheduled survivorship-projection sweep (prospect-database-platform I1 / Phase 05): one repeatable daily job
// drains projection_outbox + rebuilds each dirty cluster's SHADOW quality/freshness seams from the evidence log.
export const projectionSweepQueue = new Queue<ProjectionSweepJobData>(PROJECTION_SWEEP_QUEUE, {
  connection,
});
// The scheduled probabilistic-ER shadow sweep (prospect-database-platform I5): scores candidate person pairs and
// proposes match_links(review_status='pending') for human review. INERT while ER_SHADOW_ENABLED is off.
export const erSweepQueue = new Queue<ErSweepJobData>(ER_SWEEP_QUEUE, { connection });
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
// Retention SHADOW sweep (data-management #6, phase 2): the leader-locked daily sweep that, per ACTIVE tenant,
// COUNTS candidate rows per data class and records a retention_runs evidence row. Deletes nothing (flag-gated).
export const dataRetentionSweepQueue = new Queue<DataRetentionSweepJobData>(
  DATA_RETENTION_SWEEP_QUEUE,
  { connection },
);
// M12 P1: the proactive OAuth token-refresh sweep (leader-locked, every 2 min) — refreshes tokens nearing
// expiry off the send path so a send never pays the refresh latency.
export const tokenRefreshQueue = new Queue<TokenRefreshJobData>(EMAIL_TOKEN_REFRESH_QUEUE, {
  connection,
});

// ── /metrics collection (worker-platform plan 15 §6 — Phase 4) ─────────────────────────────────────────────

/** Bound a Redis read so a wedged connection (maxRetriesPerRequest: null buffers forever) can never hang the
 *  /metrics scrape. Rejects on expiry; the caller's allSettled turns that into an omitted row. */
function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("metrics read timed out")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Gather live queue depths + the outbox relay-lag and render the Prometheus text served on GET /metrics
 * (health.ts). Reads the module-level producer handles (every always-on queue, DLQ, and sweep). Each read is
 * individually bounded and a failed read is OMITTED — honest-unknown, never a fabricated zero row (the
 * systemHealthProbes contract). The per-queue completed/failed counters are fed by instrument().
 */
export async function collectWorkerMetricsText(): Promise<string> {
  const specs: ReadonlyArray<{ name: string; queue: Pick<Queue, "getJobCounts"> }> = [
    { name: IMPORTS_QUEUE, queue: importQueue },
    { name: IMPORTS_DLQ, queue: importDeadLetterQueue },
    { name: ENRICHMENT_QUEUE, queue: enrichmentQueue },
    { name: ENRICHMENT_DLQ, queue: enrichmentDeadLetterQueue },
    { name: SCORING_QUEUE, queue: scoringQueue },
    { name: SCORING_DLQ, queue: scoringDeadLetterQueue },
    { name: DSAR_QUEUE, queue: dsarQueue },
    { name: DSAR_DLQ, queue: dsarDeadLetterQueue },
    { name: OUTREACH_QUEUE, queue: outreachQueue },
    { name: OUTREACH_DLQ, queue: outreachDeadLetterQueue },
    { name: DEDUP_QUEUE, queue: dedupQueue },
    { name: DEDUP_DLQ, queue: dedupDeadLetterQueue },
    { name: FIRMOGRAPHICS_QUEUE, queue: firmographicsQueue },
    { name: FIRMOGRAPHICS_DLQ, queue: firmographicsDeadLetterQueue },
    { name: MASTER_BACKFILL_QUEUE, queue: masterBackfillQueue },
    { name: MASTER_BACKFILL_DLQ, queue: masterBackfillDeadLetterQueue },
    { name: REVERIFICATION_QUEUE, queue: reverificationQueue },
    { name: REVERIFICATION_DLQ, queue: reverificationDeadLetterQueue },
    // Sweeps: depth is ~1 repeatable by design, but the failed count + reachability matter.
    { name: MASTER_BACKFILL_SWEEP_QUEUE, queue: masterBackfillSweepQueue },
    { name: PROJECTION_SWEEP_QUEUE, queue: projectionSweepQueue },
    { name: ER_SWEEP_QUEUE, queue: erSweepQueue },
    { name: EMAIL_SEQUENCE_TICK_QUEUE, queue: sequenceTickQueue },
    { name: RETENTION_SWEEP_QUEUE, queue: retentionSweepQueue },
    { name: REVERIFICATION_SWEEP_QUEUE, queue: reverificationSweepQueue },
    { name: DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE, queue: dataQualitySnapshotSweepQueue },
    { name: DATA_RETENTION_SWEEP_QUEUE, queue: dataRetentionSweepQueue },
    { name: EMAIL_TOKEN_REFRESH_QUEUE, queue: tokenRefreshQueue },
  ];

  const settled = await Promise.allSettled(
    specs.map(async (s) => {
      const counts = await bounded(
        s.queue.getJobCounts("waiting", "active", "failed", "delayed"),
        1_500,
      );
      return {
        queue: s.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      } satisfies QueueDepth;
    }),
  );
  const depths = settled
    .filter((r): r is PromiseFulfilledResult<QueueDepth> => r.status === "fulfilled")
    .map((r) => r.value);

  // Relay lag (re-audit F1): the outbox's oldest unpublished row. A DB blip reads as null (omitted gauge).
  const outboxOldestPendingSeconds = await bounded(
    outboxRepository.oldestPendingAgeSeconds(),
    1_500,
  ).catch(() => null);

  return renderPromMetrics({ depths, outboxOldestPendingSeconds });
}

// ── Dead-letter holding queues (worker-platform plan 15 §2.2, item 0.2) ────────────────────────────────────
// One per retryable event queue, mirroring importDeadLetterQueue above: a job that exhausts its retry budget
// is recorded as a PII-FREE record (deadLetter.ts — scope + provenance + reason, never the payload) for ops
// triage instead of sitting invisibly in the BullMQ failed set. Sweeps get none: leader-gated, idempotent,
// re-run on schedule.
export const enrichmentDeadLetterQueue = new Queue<WorkerDeadLetter>(ENRICHMENT_DLQ, {
  connection,
});
export const scoringDeadLetterQueue = new Queue<WorkerDeadLetter>(SCORING_DLQ, { connection });
export const dsarDeadLetterQueue = new Queue<WorkerDeadLetter>(DSAR_DLQ, { connection });
export const outreachDeadLetterQueue = new Queue<WorkerDeadLetter>(OUTREACH_DLQ, { connection });
export const dedupDeadLetterQueue = new Queue<WorkerDeadLetter>(DEDUP_DLQ, { connection });
export const firmographicsDeadLetterQueue = new Queue<WorkerDeadLetter>(FIRMOGRAPHICS_DLQ, {
  connection,
});
export const masterBackfillDeadLetterQueue = new Queue<WorkerDeadLetter>(MASTER_BACKFILL_DLQ, {
  connection,
});
export const reverificationDeadLetterQueue = new Queue<WorkerDeadLetter>(REVERIFICATION_DLQ, {
  connection,
});

/** Submit a parsed import for background processing (the async alternative to the inline api path). */
export async function enqueueImport(data: ImportJobData): Promise<void> {
  await importQueue.add("import", data);
}

/** Submit an on-demand enrichment (09 §2: POST /enrichment/:entity/:id returns a job ref). */
export async function enqueueEnrichment(data: EnrichmentJobData): Promise<string> {
  const job = await enrichmentQueue.add("enrich", data, ENRICHMENT_RETRY);
  return String(job.id);
}

/** Submit a re-score; the appended scores row syncs contacts.priority_score via trigger. */
export async function enqueueScoring(data: ScoringJobData): Promise<string> {
  const job = await scoringQueue.add("score", data, SCORING_RETRY);
  return String(job.id);
}

/** Submit a VERIFIED DSAR for privileged processing (08 §4; the staff workflow enqueues this). */
export async function enqueueDsar(data: DsarJobData): Promise<string> {
  const job = await dsarQueue.add("dsar", data, DSAR_RETRY);
  return String(job.id);
}

/** Submit one enrollment-step delivery (05 §13; step delays arrive as BullMQ job delays). Retry is capped at
 *  attempts=2 — the double-send bound; see OUTREACH_RETRY in retryPolicies.ts before raising it. */
export async function enqueueOutreach(data: OutreachJobData, delayMs = 0): Promise<string> {
  const job = await outreachQueue.add(
    "send",
    data,
    delayMs > 0 ? { ...OUTREACH_RETRY, delay: delayMs } : OUTREACH_RETRY,
  );
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

/** Register the repeatable OAuth token-refresh sweep (M12 P1). Stable jobId → exactly one repeatable. */
export async function scheduleTokenRefresh(): Promise<void> {
  await tokenRefreshQueue.add(
    "refresh",
    {},
    { repeat: { every: 2 * 60_000 }, jobId: "email-token-refresh" },
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

/** Register the daily survivorship-projection sweep (prospect-database-platform I1). Stable jobId → exactly one
 *  repeatable. Additive: a no-op while INGESTION_EVIDENCE_ENABLED is off (the outbox stays empty). */
export async function scheduleProjectionSweep(): Promise<void> {
  await projectionSweepQueue.add(
    "sweep",
    {},
    { repeat: { every: 24 * 60 * 60_000 }, jobId: "projection-sweep" },
  );
}

/** Register the daily probabilistic-ER shadow sweep (prospect-database-platform I5). Stable jobId → exactly one
 *  repeatable. Additive: the processor returns immediately while ER_SHADOW_ENABLED is off (proposes nothing). */
export async function scheduleErSweep(): Promise<void> {
  await erSweepQueue.add("sweep", {}, { repeat: { every: 24 * 60 * 60_000 }, jobId: "er-sweep" });
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
    REVERIFICATION_RETRY,
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

/** Register the daily retention SHADOW sweep (data-management #6, phase 2). Stable jobId → exactly one
 *  repeatable. Harmless to schedule unconditionally: each per-tenant pass is gated by the per-tenant
 *  retention_engine_enabled flag (off by default) and DELETES NOTHING (counts + records only). */
export async function scheduleDataRetentionSweep(): Promise<void> {
  await dataRetentionSweepQueue.add(
    "sweep",
    {},
    { repeat: { every: 24 * 60 * 60_000 }, jobId: "data-retention-sweep" },
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
    MASTER_BACKFILL_RETRY,
  );
  return String(job.id);
}

// Phase 3 (ADR-0027): the outbox relay handle, set by startWorkers when the bulk-enrichment block runs.
let outboxRelay: OutboxRelayHandle | undefined;

/** Stop background relays (Phase 3): halts the outbox relay's schedule and awaits its in-flight tick. The
 *  entrypoint calls this FIRST in the drain so no new drive publish races the worker close. No-op when the
 *  bulk-enrichment block never started a relay (flag off). Safe to call more than once. */
export async function stopBackgroundRelays(): Promise<void> {
  const relay = outboxRelay;
  outboxRelay = undefined;
  await relay?.stop();
}

/** Attach structured completed/failed logging + metrics counters to a worker (per-queue observability), plus
 *  — when a dead-letter queue is provided (0.2) — routing of retry-exhausted jobs onto it as PII-free records
 *  (deadLetter.ts). Log lines carry the tenant/workspace scope when the payload exposes it (Phase 4, doc 19
 *  §1 tenant tags — UUIDs only via extractScope, never payload fields). Never logs payloads. */
function instrument<T = unknown>(
  worker: Worker<T>,
  queue: string,
  deadLetterQueue?: Queue<WorkerDeadLetter>,
): Worker<T> {
  worker.on("completed", (job) => {
    recordCompleted(queue);
    log.info("job completed", { queue, jobId: job.id, ...extractScope(job.data) });
  });
  worker.on("failed", (job, err) => {
    recordFailed(queue);
    log.error("job failed", {
      queue,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err.message,
      ...extractScope(job?.data),
    });
  });
  if (deadLetterQueue) worker.on("failed", makeDeadLetterHandler<T>(queue, deadLetterQueue));
  return worker;
}

/** Boot every queue consumer. Returns the workers so the entry can manage their lifecycle. */
export function startWorkers(): Worker[] {
  // Wire the email send adapters + OAuth provider before the outreach consumer can process a real send (M12 P1):
  // a Gmail send refreshes its token via the registered OAuth provider, so this must run at boot.
  registerEmailProviders();

  // Per-mailbox send-rate throttle (WARM-001). Conservative fixed defaults (10 burst, 1/sec ≈ 60/min); the P5
  // warmup ramp makes this per-mailbox/day. A throttled send is deferred (re-enqueued), never dropped.
  const mailboxThrottle = createRedisMailboxThrottle(connection, { capacity: 10, refillPerSec: 1 });

  const importsWorker = instrument(
    new Worker<ImportJobData>(
      IMPORTS_QUEUE,
      withDeadline(IMPORTS_QUEUE, deadlineMs(IMPORTS_QUEUE), processImport),
      { connection, ...eventTuning(IMPORTS_QUEUE) },
    ),
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
    // G-NTF-1 producer: tell the importer their import finished (best-effort — a note failure never affects the
    // import). The notification insert runs on the base owner connection (BYPASSRLS), like the Stripe grant path.
    const importedBy = job?.data?.importedByUserId;
    if (importedBy) {
      void db
        .transaction((tx) =>
          notificationRepository.create(tx, {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            userId: importedBy,
            type: "import_complete",
            title: "Import finished",
            body: `Your ${job.data.sourceName} import is ready — contacts are in your workspace.`,
          }),
        )
        .catch((e) =>
          log.error("imports: import-complete notification failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
    }
  });
  // Typed as Worker[] (not the inferred per-generic union) so the gated bulk worker — a Worker<BulkImportJobData> —
  // can be pushed below without a generic-mismatch error. Same element type the function already returns.
  const workers: Worker[] = [
    importsWorker,
    // Event consumers (Phase 1): each processor is deadline-bounded (a hung upstream fails the attempt into
    // the retry→DLQ path instead of holding the lock forever) and carries explicit concurrency + lock/stall
    // tuning (tuning.ts). The spend path (enrichment) stays serial — F3 hard gate.
    instrument(
      new Worker<EnrichmentJobData>(
        ENRICHMENT_QUEUE,
        withDeadline(ENRICHMENT_QUEUE, deadlineMs(ENRICHMENT_QUEUE), processEnrichment),
        { connection, ...eventTuning(ENRICHMENT_QUEUE) },
      ),
      ENRICHMENT_QUEUE,
      enrichmentDeadLetterQueue,
    ),
    instrument(
      new Worker<ScoringJobData>(
        SCORING_QUEUE,
        withDeadline(SCORING_QUEUE, deadlineMs(SCORING_QUEUE), processScoring),
        { connection, ...eventTuning(SCORING_QUEUE) },
      ),
      SCORING_QUEUE,
      scoringDeadLetterQueue,
    ),
    instrument(
      new Worker<DsarJobData>(
        DSAR_QUEUE,
        withDeadline(DSAR_QUEUE, deadlineMs(DSAR_QUEUE), processDsar),
        { connection, ...eventTuning(DSAR_QUEUE) },
      ),
      DSAR_QUEUE,
      dsarDeadLetterQueue,
    ),
    instrument(
      new Worker<OutreachJobData>(
        OUTREACH_QUEUE,
        // Concurrency 4 parallelizes across mailboxes/tenants; the per-mailbox SEND rate is still governed
        // by the Redis token bucket (mailboxThrottle), so warm-up ramps are unaffected.
        withDeadline(
          OUTREACH_QUEUE,
          deadlineMs(OUTREACH_QUEUE),
          makeProcessOutreach({
            throttle: mailboxThrottle,
            reEnqueue: async (data, delayMs) => {
              await enqueueOutreach(data, delayMs);
            },
          }),
        ),
        { connection, ...eventTuning(OUTREACH_QUEUE) },
      ),
      OUTREACH_QUEUE,
      outreachDeadLetterQueue,
    ),
    instrument(
      new Worker<DedupJobData>(
        DEDUP_QUEUE,
        withDeadline(DEDUP_QUEUE, deadlineMs(DEDUP_QUEUE), processDedup),
        { connection, ...eventTuning(DEDUP_QUEUE) },
      ),
      DEDUP_QUEUE,
      dedupDeadLetterQueue,
    ),
    instrument(
      new Worker<FirmographicsJobData>(
        FIRMOGRAPHICS_QUEUE,
        withDeadline(FIRMOGRAPHICS_QUEUE, deadlineMs(FIRMOGRAPHICS_QUEUE), processFirmographics),
        { connection, ...eventTuning(FIRMOGRAPHICS_QUEUE) },
      ),
      FIRMOGRAPHICS_QUEUE,
      firmographicsDeadLetterQueue,
    ),
    // Master-link backfill consumer: per-workspace, idempotent re-resolution of NULL master_* bridges.
    instrument(
      new Worker<MasterBackfillJobData>(
        MASTER_BACKFILL_QUEUE,
        withDeadline(
          MASTER_BACKFILL_QUEUE,
          deadlineMs(MASTER_BACKFILL_QUEUE),
          processMasterBackfill,
        ),
        { connection, ...eventTuning(MASTER_BACKFILL_QUEUE) },
      ),
      MASTER_BACKFILL_QUEUE,
      masterBackfillDeadLetterQueue,
    ),
    // Master-link backfill SWEEP consumer (PLAN_07 Stage B): the leader-locked daily fan-out that enqueues a
    // per-workspace backfill for every workspace with unresolved contacts. enqueueMasterBackfill is injected.
    // Sweeps (Phase 1): explicitly serial — leader-locked singletons by design; no deadline (their
    // containment is the leader TTL + internal caps + the scheduled re-run).
    instrument(
      new Worker<MasterBackfillSweepJobData>(
        MASTER_BACKFILL_SWEEP_QUEUE,
        makeProcessMasterBackfillSweep(connection, enqueueMasterBackfill),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      MASTER_BACKFILL_SWEEP_QUEUE,
    ),
    // Survivorship-projection SWEEP consumer (prospect-database-platform I1 / Phase 05): leader-locked; drains
    // projection_outbox + writes each dirty cluster's SHADOW quality/freshness seams. No-op while the evidence
    // flag is off (empty outbox); never writes the authoritative scalar columns (that flip is CI-parity-gated).
    instrument(
      new Worker<ProjectionSweepJobData>(
        PROJECTION_SWEEP_QUEUE,
        makeProcessProjectionSweep(connection),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      PROJECTION_SWEEP_QUEUE,
    ),
    // Probabilistic-ER shadow sweep (I5): proposes pending match_links for human review. Leader-locked; INERT
    // while ER_SHADOW_ENABLED is off (the processor early-returns); never auto-merges/re-points (proposals only).
    instrument(
      new Worker<ErSweepJobData>(ER_SWEEP_QUEUE, makeProcessErSweep(connection), {
        connection,
        ...SWEEP_WORKER_TUNING,
      }),
      ER_SWEEP_QUEUE,
    ),
    // M12 P4: the sequence-tick consumer. Leader-locked; claims due enrollments and enqueues each onto the
    // outreach queue (the existing send path). Best-effort registers the single repeatable job at boot.
    instrument(
      new Worker<SequenceTickJobData>(
        EMAIL_SEQUENCE_TICK_QUEUE,
        makeProcessSequenceTick(connection, async (e) => {
          // A per-(enrollment, target-step) jobId dedupes a re-claim across ticks: if a still-pending send for
          // this exact step is already queued, BullMQ keeps one — so a step is never advanced twice (P4 §A.4).
          // Same bounded retry budget as enqueueOutreach (0.1): attempts=2 is the double-send bound.
          await outreachQueue.add(
            "send",
            { tenantId: e.tenantId, workspaceId: e.workspaceId, logId: e.logId },
            { ...OUTREACH_RETRY, jobId: `seqstep:${e.logId}:${e.currentStep + 1}` },
          );
        }),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      EMAIL_SEQUENCE_TICK_QUEUE,
    ),
    // M12 P6: the retention sweep consumer (leader-locked daily).
    instrument(
      new Worker<RetentionSweepJobData>(
        RETENTION_SWEEP_QUEUE,
        makeProcessRetentionSweep(connection),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      RETENTION_SWEEP_QUEUE,
    ),
    // Freshness re-verification per-workspace consumer (ADR-0025): re-grades stale revealed contacts.
    instrument(
      new Worker<ReverificationJobData>(
        REVERIFICATION_QUEUE,
        withDeadline(REVERIFICATION_QUEUE, deadlineMs(REVERIFICATION_QUEUE), processReverification),
        { connection, ...eventTuning(REVERIFICATION_QUEUE) },
      ),
      REVERIFICATION_QUEUE,
      reverificationDeadLetterQueue,
    ),
    // Freshness re-verification SWEEP consumer: leader-locked daily fan-out enqueuing a per-workspace
    // re-verification for every workspace with stale revealed contacts. enqueueReverification is injected.
    instrument(
      new Worker<ReverificationSweepJobData>(
        REVERIFICATION_SWEEP_QUEUE,
        makeProcessReverificationSweep(connection, enqueueReverification),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      REVERIFICATION_SWEEP_QUEUE,
    ),
    // Data Health snapshot SWEEP consumer: leader-locked daily capture of a per-workspace trend point.
    instrument(
      new Worker<DataQualitySnapshotSweepJobData>(
        DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE,
        makeProcessDataQualitySnapshotSweep(connection),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      DATA_QUALITY_SNAPSHOT_SWEEP_QUEUE,
    ),
    // Retention SHADOW sweep consumer (data-management #6, phase 2): leader-locked daily; per ACTIVE tenant it
    // COUNTS candidate rows per data class and records a retention_runs row. Flag-gated; DELETES NOTHING.
    instrument(
      new Worker<DataRetentionSweepJobData>(
        DATA_RETENTION_SWEEP_QUEUE,
        makeProcessDataRetentionSweep(connection),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      DATA_RETENTION_SWEEP_QUEUE,
    ),
    // M12 P1: the proactive OAuth token-refresh consumer (leader-locked, every 2 min).
    instrument(
      new Worker<TokenRefreshJobData>(
        EMAIL_TOKEN_REFRESH_QUEUE,
        makeProcessTokenRefresh(connection),
        { connection, ...SWEEP_WORKER_TUNING },
      ),
      EMAIL_TOKEN_REFRESH_QUEUE,
    ),
  ];
  // Bulk COPY-staging import (backlog #2, phase 6) — GATED DARK behind BULK_IMPORT_ENABLED (default false). Purely
  // ADDITIVE: when off, the bulk queues/worker are never even constructed (the array above is untouched) and the
  // apps/api producer enqueues nothing, so the feature is inert in prod until the COPY spike + a prod object store
  // land. When on: a `drive` job stages the upload + fans out `chunk` jobs onto the SAME bulk queue; each `chunk`
  // merges one staged band, and the LAST chunk's finalize fires the dedup/firmographics/masterBackfill rollups
  // ONCE — the SAME idempotent per-workspace rollups the sync import kicks on completion (best-effort).
  if (env.BULK_IMPORT_ENABLED) {
    const bulkImportsQueue = new Queue<UnifiedImportJobData>(BULK_IMPORTS_QUEUE, { connection });
    const bulkImportDeadLetterQueue = new Queue<BulkImportDeadLetter>(BULK_IMPORTS_DLQ, {
      connection,
    });
    // DEV/TEST local-disk store; the prod FileStore (S3, presigned multipart, AV-before-promote) is injected here
    // later (no AWS SDK pulled in). Same env dir the apps/api producer composes against (apps never import apps).
    const bulkFileStore = diskFileStore(env.BULK_IMPORT_STORAGE_DIR);
    const bulkImportsWorker = instrument(
      new Worker<UnifiedImportJobData>(
        BULK_IMPORTS_QUEUE,
        makeProcessBulkImport({
          fileStore: bulkFileStore,
          // The drive phase fans out one chunk job per staged band onto the SAME bulk queue.
          enqueueChunk: async (jobId, scope, chunkId) => {
            await bulkImportsQueue.add("chunk", { kind: "chunk", jobId, scope, chunkId });
          },
          // The LAST chunk's finalize fires these ONCE — the SAME idempotent per-workspace rollups the sync import
          // kicks on completion. Best-effort: a rollup-enqueue failure never fails the chunk job.
          fireRollups: (scope: BulkImportScope) => {
            const data = { tenantId: scope.tenantId, workspaceId: scope.workspaceId };
            void enqueueDedup(data).catch((e) =>
              log.error("bulk-import: dedup enqueue failed", {
                error: e instanceof Error ? e.message : String(e),
              }),
            );
            void enqueueFirmographics(data).catch((e) =>
              log.error("bulk-import: firmographics enqueue failed", {
                error: e instanceof Error ? e.message : String(e),
              }),
            );
            void enqueueMasterBackfill(data).catch((e) =>
              log.error("bulk-import: master-backfill enqueue failed", {
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          },
        }),
        // Explicitly serial while dark (Phase 1): the chunked pipeline's throughput lever is chunk fan-out,
        // and any concurrency raise is a deliberate later decision, not a default.
        { connection, concurrency: 1 },
      ),
      BULK_IMPORTS_QUEUE,
    );
    // Bulk-import jobs that exhaust their retries are dead-lettered (PII-free) for ops triage instead of lost.
    bulkImportsWorker.on("failed", (job, err) => {
      void deadLetterFailedBulkImport(bulkImportDeadLetterQueue, job, err).catch((e) =>
        log.error("bulk-import: dead-letter routing failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      // v2 FAST lane (S-I3): exhausted attempts flip the DURABLE row to the honest `failed` terminal so the
      // poll/history never show a job stuck `running` after the queue gave up (the accounting identity holds
      // with `unprocessed` absorbing the un-landed remainder). Idempotent — a terminal row is left untouched.
      // The stored reason is a BUCKETED, PII-free constant (a raw err.message may quote row values).
      const data = job?.data as UnifiedImportJobData | undefined;
      if (job && data?.kind === "fast" && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        const summary = err instanceof FastImportFailedError ? err.summary : undefined;
        void markFastImportFailed({
          scope: data.scope,
          jobId: data.jobId,
          failedReason: summary
            ? "Import failed: no rows could be imported."
            : `Import failed after retries (${err.name}).`,
          summary,
          totalRows: data.input.rows.length,
        }).catch((e) =>
          log.error("bulk-import: fast failed-terminal write failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    });
    // v2 FAST lane completion side-effects — BYTE-PARALLEL with the legacy imports handler above (S-Q3
    // retires both onto the transactional outbox later; until then the fast path must not silently lose the
    // rollups or the importer's notification the legacy path delivers). Fires ONLY on a fresh terminal
    // (result.finalized) — a terminal-skip replay re-fires nothing.
    bulkImportsWorker.on("completed", (job, result) => {
      const data = job?.data as UnifiedImportJobData | undefined;
      if (data?.kind !== "fast") return;
      const r = result as { finalized?: boolean; landed?: boolean; status?: string } | undefined;
      if (!r?.finalized) return;
      const scope = { tenantId: data.scope.tenantId, workspaceId: data.scope.workspaceId };
      if (r.landed) {
        void enqueueDedup(scope).catch((e) =>
          log.error("fast-import: dedup enqueue failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        void enqueueFirmographics(scope).catch((e) =>
          log.error("fast-import: firmographics enqueue failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        void enqueueMasterBackfill(scope).catch((e) =>
          log.error("fast-import: master-backfill enqueue failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      const importedBy = data.input.importedByUserId;
      if (importedBy) {
        void db
          .transaction((tx) =>
            notificationRepository.create(tx, {
              tenantId: scope.tenantId,
              workspaceId: scope.workspaceId,
              userId: importedBy,
              type: "import_complete",
              title: "Import finished",
              body: `Your ${data.input.sourceName} import is ready — contacts are in your workspace.`,
            }),
          )
          .catch((e) =>
            log.error("fast-import: import-complete notification failed", {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
      }
    });
    workers.push(bulkImportsWorker);
  }
  // Bulk (existing-contact) re-enrich money path (prospect-database-platform I3 / audit A3/P08) — GATED DARK behind
  // BULK_ENRICHMENT_ENABLED (default false). Purely ADDITIVE: when off, the queue/worker are never constructed and
  // the apps/api producer enqueues nothing, so the path is inert in prod until the flag is flipped in a CI-gated
  // step. When on: a `drive` job chunks a CONFIRMED (`running`) job's contact selection into bands + fans out
  // `chunk` jobs (FREE — runBulkEnrich makes zero provider calls). SLICE 3a wires the real drive; the `chunk` body
  // is still a NO-OP STUB (ZERO spend) until slice 3b adds the per-run cap + daily breaker. The confirm gate
  // (slice 1b) promotes a job to `running`, so nothing here runs until a human has accepted the ceiling.
  if (env.BULK_ENRICHMENT_ENABLED) {
    const bulkEnrichmentQueue = new Queue<BulkEnrichmentJobData>(BULK_ENRICHMENT_QUEUE, {
      connection,
    });
    const bulkEnrichmentDeadLetterQueue = new Queue<BulkEnrichmentDeadLetter>(BULK_ENRICHMENT_DLQ, {
      connection,
    });
    const bulkEnrichmentWorker = instrument(
      new Worker<BulkEnrichmentJobData>(
        BULK_ENRICHMENT_QUEUE,
        makeProcessBulkEnrichment({
          // The drive phase fans out one chunk job per band onto the SAME bulk-enrichment queue. STABLE jobId
          // (Phase 3): a duplicate drive delivery (at-least-once outbox re-publish) re-fans the same chunk ids
          // and BullMQ keeps exactly one of each — idempotent fan-out, no duplicate chunk work.
          enqueueChunk: async (jobId, scope, chunkId) => {
            await bulkEnrichmentQueue.add(
              "chunk",
              { kind: "chunk", jobId, scope, chunkId },
              { jobId: `bulkenrich:chunk:${jobId}:${chunkId}` },
            );
          },
          // The chunk phase feeds these vendor adapters to enrichContact — the SAME set processEnrichment uses.
          providers: defaultProviders(),
        }),
        // SPEND PATH — explicitly serial (re-audit F3 hard gate): do not raise until the atomic daily
        // budget breaker + per-batch credit lease land (plan 15 §7 Phase-5 entry gate; tuning.ts header).
        { connection, concurrency: 1 },
      ),
      BULK_ENRICHMENT_QUEUE,
    );
    // Bulk-enrich jobs that exhaust their retries are dead-lettered (PII-free) for ops triage instead of lost.
    bulkEnrichmentWorker.on("failed", (job, err) => {
      void deadLetterFailedBulkEnrichment(bulkEnrichmentDeadLetterQueue, job, err).catch((e) =>
        log.error("bulk-enrichment: dead-letter routing failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    });
    workers.push(bulkEnrichmentWorker);

    // Phase 3 (ADR-0027): the LEADERLESS outbox relay. The confirm endpoint no longer enqueues to Redis —
    // the awaiting_confirmation → running transition commits its drive-publish intent into worker_outbox in
    // the SAME tx (enrichmentJobRepository.confirmAwaitingJob), and every worker replica drains it here with
    // FOR UPDATE SKIP LOCKED on a continuous 1s poll (re-audit F1: no leader lock, no daily cadence — only
    // the SKIP LOCKED drain idea is shared with projection_sweep, F2). At-least-once by design: the STABLE
    // drive jobId dedupes a re-publish at the queue, and runBulkEnrich additionally guards on `running`.
    // Payload is validated against the shared schema before publish; a malformed row burns its attempts cap
    // (bounded) and fails out via the repository, loudly logged each claim. Gated with the consumer: when
    // the kill-switch is off no relay runs and committed intents simply wait, exactly like the dark queue.
    outboxRelay = startOutboxRelay({
      publishers: {
        [BULK_ENRICHMENT_DRIVE_TOPIC]: async (payload) => {
          const data = bulkEnrichmentJobDataSchema.parse(payload);
          await bulkEnrichmentQueue.add("drive", data, {
            jobId: `bulkenrich:drive:${data.jobId}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 2000, jitter: 0.5 },
          });
        },
      },
    });
  }
  // Async BULK REVEAL consumer — DARK by default (BULK_REVEAL_ENABLED=false; the apps/api producer enqueues
  // nothing while off, so this never runs in prod until the flag is flipped in a CI-gated step). A `drive` job
  // chunks a CONFIRMED (`running`) job's contacts into bands + fans out `chunk` jobs; a `chunk` reveals its band
  // through the gated revealContact in `lease` settle-mode (the job's ONE lease already reserved the credits —
  // no per-row hot-lock) and, on the last band, writes the revealed CSV + finalizes with a release.
  if (env.BULK_REVEAL_ENABLED) {
    const revealFileStore = diskFileStore(env.BULK_IMPORT_STORAGE_DIR);
    const bulkRevealQueue = new Queue<BulkRevealJobData>(BULK_REVEAL_QUEUE, { connection });
    const bulkRevealDeadLetterQueue = new Queue<BulkRevealDeadLetter>(BULK_REVEAL_DLQ, {
      connection,
    });
    const bulkRevealWorker = instrument(
      new Worker<BulkRevealJobData>(
        BULK_REVEAL_QUEUE,
        makeProcessBulkReveal({
          // The drive fans out one chunk job per band onto the SAME bulk-reveal queue.
          enqueueChunk: async (jobId, scope, band) => {
            await bulkRevealQueue.add("chunk", {
              kind: "chunk",
              jobId,
              scope,
              rowStart: band.rowStart,
              rowEnd: band.rowEnd,
            });
          },
          fileStore: revealFileStore,
          verifier: defaultEmailVerifier(),
          phoneVerifier: defaultPhoneVerifier(),
        }),
        // SPEND PATH — explicitly serial (the reveal counter lock + the single lease already serialize a job's
        // own chunks; keep concurrency 1 until per-tenant fairness/parallelism is proven, mirroring bulk-enrich).
        { connection, concurrency: 1 },
      ),
      BULK_REVEAL_QUEUE,
    );
    bulkRevealWorker.on("failed", (job, err) => {
      void deadLetterFailedBulkReveal(bulkRevealDeadLetterQueue, job, err).catch((e) =>
        log.error("bulk-reveal: dead-letter routing failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    });
    workers.push(bulkRevealWorker);
  }
  // Realtime relay (reveal-experience Phase 4, ADR-0027) — DARK by default (REALTIME_SSE_ENABLED=false). Drains
  // the event_outbox → Redis pub/sub for the SSE gateway. Leaderless (FOR UPDATE SKIP LOCKED); a self-scheduling
  // `.unref()`-ed loop that never blocks shutdown. Not a BullMQ Worker, so it isn't pushed to `workers`.
  if (env.REALTIME_SSE_ENABLED) {
    startRealtimeRelay(new IORedis(env.REDIS_URL));
  }
  // Low-balance notifier sweep (plans-pricing-credits) — DARK by default (LOW_BALANCE_NOTIFIER_ENABLED=false).
  // Purely additive: when off, the queue/worker/schedule are never constructed and nothing is scanned. READ-ONLY
  // — charges and deletes nothing; the customer-facing delivery channel (email / in-app, ADR-0027) is the next
  // wiring step. Leader-locked daily (a stable jobId → exactly one repeatable).
  if (env.LOW_BALANCE_NOTIFIER_ENABLED) {
    const lowBalanceNotifierQueue = new Queue<LowBalanceNotifierSweepJobData>(
      LOW_BALANCE_NOTIFIER_SWEEP_QUEUE,
      { connection },
    );
    workers.push(
      instrument(
        new Worker<LowBalanceNotifierSweepJobData>(
          LOW_BALANCE_NOTIFIER_SWEEP_QUEUE,
          makeProcessLowBalanceNotifierSweep(connection),
          { connection },
        ),
        LOW_BALANCE_NOTIFIER_SWEEP_QUEUE,
      ),
    );
    void lowBalanceNotifierQueue
      .add(
        "sweep",
        {},
        { repeat: { every: 24 * 60 * 60_000 }, jobId: "low-balance-notifier-sweep" },
      )
      .catch((e) =>
        log.error("failed to schedule the low-balance notifier sweep", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }
  // Credit-ledger reconciliation sweep (M11, ADR-0029) — DARK by default (BILLING_RECON_ENABLED=false). Purely
  // additive: when off, the queue/worker/schedule are never constructed and nothing is scanned. READ-ONLY —
  // asserts SUM(credit_ledger.delta) == counter per tenant and logs drift; corrects nothing. Enable only after
  // the historical backfill. Leader-locked daily (a stable jobId → exactly one repeatable).
  if (env.BILLING_RECON_ENABLED) {
    const billingReconQueue = new Queue<BillingReconSweepJobData>(BILLING_RECON_SWEEP_QUEUE, {
      connection,
    });
    workers.push(
      instrument(
        new Worker<BillingReconSweepJobData>(
          BILLING_RECON_SWEEP_QUEUE,
          makeProcessBillingReconSweep(connection),
          { connection },
        ),
        BILLING_RECON_SWEEP_QUEUE,
      ),
    );
    void billingReconQueue
      .add("sweep", {}, { repeat: { every: 24 * 60 * 60_000 }, jobId: "billing-recon-sweep" })
      .catch((e) =>
        log.error("failed to schedule the billing-recon sweep", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }
  // Subscription monthly-grant/reset sweep (M11 subs, ADR-0041) — DARK by default
  // (BILLING_SUBSCRIPTIONS_ENABLED=false). Purely additive: when off, nothing is built. Grants due
  // billing_cycles (expire the perishable allotment + grant the monthly one, ledger-consistent → recon stays
  // green). Leader-locked; every 15 min so a new subscription's first grant + each renewal land promptly.
  if (env.BILLING_SUBSCRIPTIONS_ENABLED) {
    const subscriptionGrantQueue = new Queue<SubscriptionGrantSweepJobData>(
      SUBSCRIPTION_GRANT_SWEEP_QUEUE,
      { connection },
    );
    workers.push(
      instrument(
        new Worker<SubscriptionGrantSweepJobData>(
          SUBSCRIPTION_GRANT_SWEEP_QUEUE,
          makeProcessSubscriptionGrantSweep(connection),
          { connection },
        ),
        SUBSCRIPTION_GRANT_SWEEP_QUEUE,
      ),
    );
    void subscriptionGrantQueue
      .add("sweep", {}, { repeat: { every: 15 * 60_000 }, jobId: "subscription-grant-sweep" })
      .catch((e) =>
        log.error("failed to schedule the subscription-grant sweep", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );

    // Subscription dunning SIGNAL (M11 subs, ADR-0041) — READ-ONLY: surfaces subscriptions past_due beyond the
    // grace window as an ops signal. Stripe drives the real dunning (retry → deleted → revert-to-free via the
    // webhook); the suspend policy is a flagged owner decision, so this suspends nothing. Leader-locked daily.
    const subscriptionDunningQueue = new Queue<SubscriptionDunningSweepJobData>(
      SUBSCRIPTION_DUNNING_SWEEP_QUEUE,
      { connection },
    );
    workers.push(
      instrument(
        new Worker<SubscriptionDunningSweepJobData>(
          SUBSCRIPTION_DUNNING_SWEEP_QUEUE,
          makeProcessSubscriptionDunningSweep(connection),
          { connection },
        ),
        SUBSCRIPTION_DUNNING_SWEEP_QUEUE,
      ),
    );
    void subscriptionDunningQueue
      .add(
        "sweep",
        {},
        { repeat: { every: 24 * 60 * 60_000 }, jobId: "subscription-dunning-sweep" },
      )
      .catch((e) =>
        log.error("failed to schedule the subscription-dunning sweep", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }
  // M12 P3 inbound-reply poller (Gmail history sweep) — DARK by default (EMAIL_INBOX_ENABLED=false). Purely
  // additive: when off, nothing is built. Per connected Google mailbox it polls new replies, records them, and
  // auto-pauses the sequence on a confirmed human reply. Leader-locked; every 5 min.
  if (env.EMAIL_INBOX_ENABLED) {
    const gmailInboxQueue = new Queue<GmailInboxPollJobData>(GMAIL_INBOX_POLL_QUEUE, {
      connection,
    });
    workers.push(
      instrument(
        new Worker<GmailInboxPollJobData>(
          GMAIL_INBOX_POLL_QUEUE,
          makeProcessGmailInboxPoll(connection),
          { connection },
        ),
        GMAIL_INBOX_POLL_QUEUE,
      ),
    );
    void gmailInboxQueue
      .add("sweep", {}, { repeat: { every: 5 * 60_000 }, jobId: "gmail-inbox-poll" })
      .catch((e) =>
        log.error("failed to schedule the gmail-inbox poll", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }
  // One-time credit-ledger backfill sweep (M11, ADR-0029) — DARK by default (BILLING_LEDGER_BACKFILL_ENABLED=
  // false). Purely additive: when off, nothing is built. Self-terminating (no-ops once every active tenant
  // carries an opening_balance marker), so it is safe to leave scheduled; the operator enables it, watches it
  // drain, then turns it off. Leader-locked; fires every 5 min while enabled to drain the fleet promptly.
  if (env.BILLING_LEDGER_BACKFILL_ENABLED) {
    const ledgerBackfillQueue = new Queue<LedgerBackfillSweepJobData>(LEDGER_BACKFILL_SWEEP_QUEUE, {
      connection,
    });
    workers.push(
      instrument(
        new Worker<LedgerBackfillSweepJobData>(
          LEDGER_BACKFILL_SWEEP_QUEUE,
          makeProcessLedgerBackfillSweep(connection),
          { connection },
        ),
        LEDGER_BACKFILL_SWEEP_QUEUE,
      ),
    );
    void ledgerBackfillQueue
      .add("sweep", {}, { repeat: { every: 5 * 60_000 }, jobId: "ledger-backfill-sweep" })
      .catch((e) =>
        log.error("failed to schedule the ledger-backfill sweep", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }
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
  void scheduleProjectionSweep().catch((e) =>
    log.error("failed to schedule the projection sweep", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  void scheduleErSweep().catch((e) =>
    log.error("failed to schedule the er sweep", {
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
  void scheduleDataRetentionSweep().catch((e) =>
    log.error("failed to schedule the data-retention sweep", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  void scheduleTokenRefresh().catch((e) =>
    log.error("failed to schedule the token refresh", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  return workers;
}
