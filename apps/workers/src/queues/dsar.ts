// dsar.ts — the `dsar` queue processor (08 §4): runs the privileged access-report / delete-fan-out for a
// VERIFIED request. Enqueued by the staff workflow when a request is moved to `processing` — never by the
// unverified public intake, because a self-service form that dispatched its own erasure would let anyone
// erase anyone by typing their address.

import { assembleAccessReport, deleteFanout } from "@leadwolf/core";
import type { CrmEraseTarget } from "@leadwolf/core";
import { DSAR_DLQ, DSAR_QUEUE } from "@leadwolf/types";
import type { Job } from "bullmq";

// Queue + DLQ names live in @leadwolf/types (workerQueues.ts — the admin probe reads them too); re-exported.
export { DSAR_DLQ, DSAR_QUEUE };

/**
 * The job payload: an id and a discriminator. Nothing else.
 *
 * It used to carry the subject's plaintext email, which put the address of the person being erased into the
 * Redis job payload, the completed-job log and any dead-letter record — erasing them from Postgres while
 * copying them into Redis. The blind index intake already stored on the row serves the fan-out just as well,
 * so the email has no reason to travel. It also removes a whole failure mode: a payload email that did not
 * match the request would have erased the wrong person under a real request's id.
 */
export interface DsarJobData {
  requestId: string;
  requestType: "access" | "delete";
}

/**
 * The outbound-CRM-erase enqueuer, injected by the composition root (crm-sync §7.6).
 *
 * Optional so this processor stays constructible without a queue in tests. Its ABSENCE is safe in one
 * direction only: the crm_record_links rows survive, the residual scan keeps counting them, and the DSAR
 * stays `processing` rather than falsely reporting a completed erasure.
 */
export type EnqueueCrmEraseJobs = (targets: CrmEraseTarget[], requestId: string) => Promise<void>;

export function makeProcessDsar(enqueueCrmErase?: EnqueueCrmEraseJobs) {
  return async function processDsar(job: Job<DsarJobData>): Promise<unknown> {
    const { requestId, requestType } = job.data;
    if (requestType !== "delete") return assembleAccessReport(requestId);
    return deleteFanout(
      requestId,
      enqueueCrmErase ? (targets) => enqueueCrmErase(targets, requestId) : undefined,
    );
  };
}

/** Back-compat entrypoint for callers with no CRM queue wired (tests, the admin probe). */
export const processDsar = makeProcessDsar();
