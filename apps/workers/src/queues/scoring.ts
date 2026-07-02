// scoring.ts — the `scoring` queue processor (ADR-0008): re-scores a contact by appending a versioned
// scores row via core's computeScore; the DB trigger syncs contacts.priority_score.

import { type ComputeScoreResult, computeScore } from "@leadwolf/core";
import type { Job } from "bullmq";

export const SCORING_QUEUE = "scoring";
/** Dead-letter holding queue for scoring jobs that exhaust their retries (PII-free records). */
export const SCORING_DLQ = "scoring-dlq";

export interface ScoringJobData {
  tenantId: string;
  workspaceId: string;
  contactId: string;
}

export async function processScoring(job: Job<ScoringJobData>): Promise<ComputeScoreResult> {
  const { tenantId, workspaceId, contactId } = job.data;
  return computeScore({ scope: { tenantId, workspaceId }, contactId });
}
