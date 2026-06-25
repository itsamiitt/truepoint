// outreach.ts — the `outreach` queue processor (05 §13, ADR-0009): delivers ONE enrollment step through
// core's suppression-gated, CAN-SPAM-enforcing send transaction.
// M12 P1 CUTOVER (email-planning/13 P1, D11): a tenant on the real send path (the email.send flag) goes
// through dispatchOutreachSend — the identity gate (own connected mailbox + DNS-verified domain, D2/D3) +
// the per-tenant send-quota (15 §A.6) around the UNCHANGED M9 sendStep. Every other tenant keeps the M9 dev
// path (consoleSender) byte-for-byte. The flag is fail-closed (undefined → off), so no tenant reaches the
// real path until an admin defines + enables email.send (after DNS auth + reputation isolation are proven).

import {
  type SendStepResult,
  consoleSender,
  dispatchOutreachSend,
  isFlagEnabledForTenant,
  sendStep,
} from "@leadwolf/core";
import { withTenantTx } from "@leadwolf/db";
import type { Job } from "bullmq";

export const OUTREACH_QUEUE = "outreach";

export interface OutreachJobData {
  tenantId: string;
  workspaceId: string;
  logId: string;
}

export async function processOutreach(job: Job<OutreachJobData>): Promise<SendStepResult> {
  const { tenantId, workspaceId, logId } = job.data;
  const scope = { tenantId, workspaceId };
  const realSend = await withTenantTx(scope, (tx) =>
    isFlagEnabledForTenant(tx, tenantId, "email.send"),
  );
  if (realSend) return dispatchOutreachSend({ scope, logId });
  return sendStep({ scope, logId, sender: consoleSender });
}
