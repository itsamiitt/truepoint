// dsar.ts — the `dsar` queue processor (08 §4): runs the privileged access-report / delete-fan-out for a
// VERIFIED request. Enqueued by the staff workflow (apps/admin later); never by an unverified intake.

import { assembleAccessReport, deleteFanout } from "@leadwolf/core";
import type { Job } from "bullmq";

export const DSAR_QUEUE = "dsar";

export interface DsarJobData {
  requestId: string;
  requestType: "access" | "delete";
  subjectEmail: string; // supplied by the verification workflow, never persisted in the job log
}

export async function processDsar(job: Job<DsarJobData>): Promise<unknown> {
  const { requestId, requestType, subjectEmail } = job.data;
  return requestType === "delete"
    ? deleteFanout(requestId, subjectEmail)
    : assembleAccessReport(requestId, subjectEmail);
}
