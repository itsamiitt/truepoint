// outreach.ts — the `outreach` queue processor (05 §13, ADR-0009): delivers ONE enrollment step through
// core's suppression-gated, CAN-SPAM-enforcing send transaction. M9 wires the dev consoleSender; the M12
// SES adapter swaps the port without touching this processor.
// NOTE: `sendStep`, `consoleSender`, and `SendStepResult` resolve once the integrator exports them from
// @leadwolf/core (packages/core/src/index.ts) — expected-unresolved until that wiring lands.

import { type SendStepResult, consoleSender, sendStep } from "@leadwolf/core";
import type { Job } from "bullmq";

export const OUTREACH_QUEUE = "outreach";

export interface OutreachJobData {
  tenantId: string;
  workspaceId: string;
  logId: string;
}

export async function processOutreach(job: Job<OutreachJobData>): Promise<SendStepResult> {
  const { tenantId, workspaceId, logId } = job.data;
  return sendStep({ scope: { tenantId, workspaceId }, logId, sender: consoleSender });
}
