// outreach.ts — the `outreach` queue processor (05 §13, ADR-0009): delivers ONE enrollment step through
// core's suppression-gated, CAN-SPAM-enforcing send transaction.
// M12 P1 CUTOVER (email-planning/13 P1, D11): a tenant on the real send path (the email.send flag) goes
// through dispatchOutreachSend — the identity gate (own connected mailbox + DNS-verified domain, D2/D3) +
// the per-tenant send-quota (15 §A.6) + the per-mailbox rate throttle (WARM-001) around the UNCHANGED M9
// sendStep. Every other tenant keeps the M9 dev path (consoleSender) byte-for-byte. The flag is fail-closed
// (undefined → off). A throttled send is DEFERRED (re-enqueued with the retry delay), never dropped or
// double-sent — the quota it pre-consumed was refunded in dispatchOutreachSend.

import {
  type MailboxThrottlePort,
  MailboxThrottledError,
  type SendStepResult,
  consoleSender,
  dispatchOutreachSend,
  isFlagEnabledForTenant,
  sendStep,
} from "@leadwolf/core";
import { withTenantTx } from "@leadwolf/db";
import { OUTREACH_DLQ, OUTREACH_QUEUE } from "@leadwolf/types";
import type { Job } from "bullmq";
import { log } from "../logger.ts";

// Queue + DLQ names live in @leadwolf/types (workerQueues.ts — the admin probe reads them too); re-exported.
// A throttle deferral is a re-enqueue, never a failure, so it can never land in the DLQ.
export { OUTREACH_DLQ, OUTREACH_QUEUE };

export interface OutreachJobData {
  tenantId: string;
  workspaceId: string;
  logId: string;
}

/** Marker result for a send deferred by the per-mailbox throttle (re-enqueued, not a failure). */
export type OutreachResult = SendStepResult | { deferred: true };

export interface OutreachProcessorDeps {
  throttle: MailboxThrottlePort;
  /** Re-enqueue a throttled send after `delayMs` (register.ts passes enqueueOutreach). */
  reEnqueue: (data: OutreachJobData, delayMs: number) => Promise<void>;
}

// Clamp the re-enqueue delay so a pathological retryAfter can't park a job for hours (or fire instantly).
const MIN_DEFER_MS = 1_000;
const MAX_DEFER_MS = 5 * 60_000;

export function makeProcessOutreach(deps: OutreachProcessorDeps) {
  return async function processOutreach(job: Job<OutreachJobData>): Promise<OutreachResult> {
    const { tenantId, workspaceId, logId } = job.data;
    const scope = { tenantId, workspaceId };
    const realSend = await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, tenantId, "email.send"),
    );
    if (!realSend) return sendStep({ scope, logId, sender: consoleSender });

    try {
      return await dispatchOutreachSend({ scope, logId, throttle: deps.throttle });
    } catch (err) {
      if (err instanceof MailboxThrottledError) {
        const delayMs = Math.min(Math.max(err.retryAfterMs, MIN_DEFER_MS), MAX_DEFER_MS);
        await deps.reEnqueue({ tenantId, workspaceId, logId }, delayMs);
        log.info("outreach deferred (mailbox throttled)", { logId, delayMs });
        return { deferred: true };
      }
      throw err;
    }
  };
}
