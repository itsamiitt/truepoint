// crmDeadLetter.ts — routes an EXHAUSTED CRM job into the durable crm_sync_dead_letter table
// (crm-sync 00 §4.8). The composition root attaches this to each CRM worker's `failed` event.
//
// ONLY ON EXHAUSTION. BullMQ fires `failed` on every attempt, so writing on each one would fill the queue
// with transient blips an operator learns to ignore. A row here means "this job will never succeed on its
// own", which is the only signal worth a durable table and a console.
//
// The write is best-effort and NEVER throws: this runs inside an event handler, and an exception escaping it
// would take out the worker's error path — losing the job AND the record of it. A failed dead-letter write
// is logged instead, PII-free.

import { classifyCrmError, crmDeadLetterRepository, withTenantTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import { log } from "../logger.ts";

/** The scope + connection every CRM job payload carries (@leadwolf/types crmJobBase). */
interface CrmJobLike {
  scope?: { tenantId?: string; workspaceId?: string };
  connectionId?: string;
  provider?: string;
  objectType?: string;
  crmRecordId?: string;
  tpEntityId?: string;
  // The erase job is flat rather than scope-wrapped.
  tenantId?: string;
  workspaceId?: string;
}

const DIRECTION_BY_QUEUE: Record<string, "inbound" | "outbound"> = {
  crm_sync_pull: "inbound",
  crm_sync_inbound: "inbound",
  crm_sync_backfill: "inbound",
  crm_sync_push: "outbound",
  crm_sync_erase: "outbound",
};

/**
 * Typed on  at the boundary and narrowed inside, because  is generic over every
 * queue's payload — a handler parameterised on the CRM shape would not be assignable there. The narrowing
 * is real: a job whose payload lacks a scope is logged and skipped rather than assumed.
 */
export function makeCrmDeadLetterHandler(queueName: string) {
  return (job: Job<unknown> | undefined, err: Error): void => {
    if (!job) return;
    // attemptsMade < the configured max means BullMQ will try again — not exhausted, not a dead letter.
    const max = job.opts?.attempts ?? 1;
    if (job.attemptsMade < max) return;

    const d = (job.data ?? {}) as CrmJobLike;
    const tenantId = d.scope?.tenantId ?? d.tenantId;
    const workspaceId = d.scope?.workspaceId ?? d.workspaceId;
    const connectionId = d.connectionId;
    // Without a scope we cannot write an RLS-scoped row at all. Logged rather than dropped silently.
    if (!tenantId || !workspaceId || !connectionId) {
      log.error("crm dead-letter: job carries no scope", { queue: queueName, jobId: job.id });
      return;
    }

    void withTenantTx({ tenantId, workspaceId }, (tx) =>
      crmDeadLetterRepository.record(tx, {
        tenantId,
        workspaceId,
        connectionId,
        queue: queueName,
        direction: DIRECTION_BY_QUEUE[queueName] ?? null,
        objectType: d.objectType ?? null,
        crmRecordId: d.crmRecordId ?? null,
        tpEntityId: d.tpEntityId ?? null,
        // The message is classified into the closed enum and scrubbed by the repository; an unfamiliar
        // reason becomes `unknown` rather than failing the write.
        errorClass: classifyCrmError(err.message),
        errorDetail: err.message,
        attempts: job.attemptsMade,
      }),
    ).catch((e) =>
      // Never rethrow: an exception here would escape the worker's error path and lose both the job and
      // the record of it.
      log.error("crm dead-letter: durable write failed", {
        queue: queueName,
        jobId: job.id,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  };
}
