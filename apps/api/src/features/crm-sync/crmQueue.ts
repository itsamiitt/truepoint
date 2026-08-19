// crmQueue.ts — the CRM feature's BullMQ *producers* (crm-sync 00 §3.2). Producer and consumer are
// decoupled by BullMQ: they share only the queue NAME (@leadwolf/types) and the Redis URL, never each
// other's code, so the apps-never-import-apps boundary holds.
//
// Lazily opened on first use, so merely importing this module (mounting the router) never dials Redis. The
// feature is dark until CRM_SYNC_ENABLED, and the routes gate before reaching a producer — but the lazy
// connection means even a mis-wired caller cannot cost a Redis handle at boot.

import { env } from "@leadwolf/config";
import {
  CRM_SYNC_BACKFILL_QUEUE,
  CRM_SYNC_INBOUND_QUEUE,
  CRM_SYNC_JOB_OPTIONS,
  CRM_SYNC_PUSH_QUEUE,
  type CrmBackfillJob,
  type CrmInboundJob,
  type CrmPushJob,
} from "@leadwolf/types";
import type { Queue } from "bullmq";
import IORedis from "ioredis";
import { tracedQueue } from "../../lib/tracedQueue.ts";

let connection: IORedis | undefined;
function redis(): IORedis {
  // BullMQ requires maxRetriesPerRequest: null on its connection.
  if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

/**
 * Retry policy comes from the SHARED constant (@leadwolf/types CRM_SYNC_JOB_OPTIONS — perf-audit P4.3c), so
 * an api-enqueued job and a sweep-enqueued job on the same queue can never carry different attempt budgets
 * again. `removeOnComplete/Fail` stays THIS root's concern: it keeps Redis bounded — the durable record of
 * what happened is crm_sync_runs, not the job history.
 */
const DEFAULT_JOB_OPTIONS = {
  ...CRM_SYNC_JOB_OPTIONS,
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

let inboundQueue: Queue<CrmInboundJob> | undefined;
let pushQueue: Queue<CrmPushJob> | undefined;
let backfillQueue: Queue<CrmBackfillJob> | undefined;

/**
 * Enqueue one inbound apply.
 *
 * The jobId is derived from (connection, record, event) so a webhook redelivery that slips past the DB
 * dedupe wall — for example one arriving while the first is still in flight — collapses onto the same job
 * rather than applying twice. Belt-and-braces on top of the unique index, which is the real guard.
 */
export async function enqueueCrmInbound(job: CrmInboundJob): Promise<void> {
  if (!inboundQueue) {
    inboundQueue = tracedQueue<CrmInboundJob>(CRM_SYNC_INBOUND_QUEUE, {
      connection: redis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  await inboundQueue.add("inbound", job, {
    jobId: `crm-inbound:${job.connectionId}:${job.providerEventId}`,
  });
}

/**
 * Enqueue one outbound push.
 *
 * The jobId carries the caller's idempotency key, so a double-submitted UI action or a retried API call
 * produces one push rather than two writes into the customer's CRM.
 */
export async function enqueueCrmPush(job: CrmPushJob): Promise<void> {
  if (!pushQueue) {
    pushQueue = tracedQueue<CrmPushJob>(CRM_SYNC_PUSH_QUEUE, {
      connection: redis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  await pushQueue.add("push", job, {
    jobId: `crm-push:${job.connectionId}:${job.tpEntityId}:${job.idempotencyKey}`,
  });
}

/**
 * Enqueue the initial backfill drive for a connection.
 *
 * Low priority on purpose (00 §8): a backfill is a bulk one-shot that must never starve the real-time
 * inbound and push lanes. The stable jobId means re-triggering a backfill for a connection that already has
 * one queued is a no-op rather than a second full load.
 */
export async function enqueueCrmBackfill(job: CrmBackfillJob): Promise<void> {
  if (!backfillQueue) {
    backfillQueue = tracedQueue<CrmBackfillJob>(CRM_SYNC_BACKFILL_QUEUE, {
      connection: redis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  await backfillQueue.add("drive", job, {
    priority: 10,
    jobId: `crm-backfill:${job.connectionId}:${job.objectType}`,
  });
}
