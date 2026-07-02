// scoring.ts — the `scoring` queue processor (ADR-0008): re-scores a contact by appending a versioned
// scores row via core's computeScore; the DB trigger syncs contacts.priority_score.

import { type ComputeScoreResult, computeScore } from "@leadwolf/core";
import { SCORING_DLQ, SCORING_QUEUE } from "@leadwolf/types";
import type { Job } from "bullmq";

// Queue + DLQ names live in @leadwolf/types (workerQueues.ts — the admin probe reads them too); re-exported.
export { SCORING_DLQ, SCORING_QUEUE };

export interface ScoringJobData {
  tenantId: string;
  workspaceId: string;
  contactId: string;
}

export async function processScoring(job: Job<ScoringJobData>): Promise<ComputeScoreResult> {
  const { tenantId, workspaceId, contactId } = job.data;
  return computeScore({ scope: { tenantId, workspaceId }, contactId });
}
