// dsar.ts — the `dsar` queue processor (08 §4): runs the privileged access-report / delete-fan-out for a
// VERIFIED request. Enqueued by the staff workflow (apps/admin later); never by an unverified intake.

import { assembleAccessReport, deleteFanout } from "@leadwolf/core";
import type { CrmEraseTarget } from "@leadwolf/core";
import { DSAR_DLQ, DSAR_QUEUE } from "@leadwolf/types";
import type { Job } from "bullmq";

// Queue + DLQ names live in @leadwolf/types (workerQueues.ts — the admin probe reads them too); re-exported.
// DLQ records stay PII-free: NEVER subjectEmail (see DsarJobData) — deadLetter.ts records scope/reason only.
export { DSAR_DLQ, DSAR_QUEUE };

export interface DsarJobData {
  requestId: string;
  requestType: "access" | "delete";
  subjectEmail: string; // supplied by the verification workflow, never persisted in the job log
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
    const { requestId, requestType, subjectEmail } = job.data;
    if (requestType !== "delete") return assembleAccessReport(requestId, subjectEmail);
    return deleteFanout(
      requestId,
      subjectEmail,
      enqueueCrmErase ? (targets) => enqueueCrmErase(targets, requestId) : undefined,
    );
  };
}

/** Back-compat entrypoint for callers with no CRM queue wired (tests, the admin probe). */
export const processDsar = makeProcessDsar();
