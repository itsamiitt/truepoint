// dispatchOutreachSend.ts — the P1 send-gate that wraps the UNCHANGED M9 sendStep (email-planning/13 P1, D11,
// 13 §4). For a tenant on the real send path (email.send), a send is authorized only when: (1) it resolves to
// the tenant's OWN connected mailbox + DNS-verified sending domain (resolveSendingIdentity — D2/D3), and
// (2) the per-tenant send-quota allows it (sendQuotaRepository — 15 §A.6). Those two gates run together in
// one tenant tx (the FOR UPDATE quota lock serialises concurrent sends), then sendStep runs with the resolved
// adapter — REUSING the M9 suppression gate (D4), idempotency (D5), CAN-SPAM footer, and outreach_log advance
// unchanged. A failed send RELEASES the quota unit it consumed. The adapter is the only new code in the send
// path (15 §B.2); until P1b registers a real one, resolveSender falls back to consoleSender (no network).

import {
  type TenantScope,
  outreachLogRepository,
  sendQuotaRepository,
  withTenantTx,
} from "@leadwolf/db";
import { ValidationError } from "@leadwolf/types";
import { type SendStepResult, sendStep } from "../outreach/sendStep.ts";
import {
  type MailboxThrottlePort,
  MailboxThrottledError,
  allowAllThrottle,
} from "./mailboxThrottle.ts";
import { resolveSender } from "./providerAdapter.ts";
import { recordOutboundMessage } from "./recordOutboundMessage.ts";
import { resolveSendingIdentity } from "./resolveSendingIdentity.ts";

export interface DispatchOutreachSendInput {
  scope: TenantScope & { workspaceId: string };
  logId: string;
  /** Audit actor; omit for worker/automation sends. */
  userId?: string | null;
  /** Per-mailbox rate throttle (WARM-001); defaults to allow-all. The worker injects the Redis token bucket. */
  throttle?: MailboxThrottlePort;
}

export async function dispatchOutreachSend(
  input: DispatchOutreachSendInput,
): Promise<SendStepResult> {
  // ── Gate tx: resolve the sending identity (D2/D3) + consume the quota (15 §A.6), atomically ──────────────
  const gate = await withTenantTx(input.scope, async (tx) => {
    const log = await outreachLogRepository.getWithSequence(tx, input.logId);
    if (!log) throw new ValidationError("Enrollment not found in this workspace.");
    if (!log.fromAddress) {
      throw new ValidationError(
        "CAN-SPAM: from address and physical postal address are required before sending.",
      );
    }
    const resolved = await resolveSendingIdentity(tx, input.scope, log.fromAddress);

    // Pre-consume the quota under the FOR UPDATE lock (serialises concurrent sends; refuses over-cap).
    const snapshot = await sendQuotaRepository.lock(tx, input.scope.tenantId);
    sendQuotaRepository.assertWithinQuota(snapshot);
    await sendQuotaRepository.consume(tx, input.scope.tenantId);

    return {
      identity: resolved,
      contactId: log.contactId,
      sequenceId: log.sequenceId,
      sequenceName: log.sequenceName,
    };
  });

  // ── Per-mailbox rate throttle (WARM-001): a send beyond the mailbox's ramped rate is DEFERRED, not dropped.
  // The quota was pre-consumed under the lock; a throttled send didn't go out, so refund it (same safe path as
  // a send failure) and signal the worker to re-enqueue with the retry delay. Default allow-all is a no-op.
  const throttle = input.throttle ?? allowAllThrottle;
  const verdict = await throttle.tryConsume(gate.identity.mailboxId);
  if (!verdict.allowed) {
    await withTenantTx(input.scope, (tx) =>
      sendQuotaRepository.release(tx, input.scope.tenantId),
    ).catch(() => {});
    throw new MailboxThrottledError(gate.identity.mailboxId, verdict.retryAfterMs);
  }

  // ── Send tx: the UNCHANGED M9 transaction with the resolved adapter (D11). Suppression/idempotency/footer
  // /advance are reused as-is. A failed send refunds the quota unit so a failure never burns the tenant's cap.
  let result: SendStepResult;
  try {
    result = await sendStep({
      scope: input.scope,
      logId: input.logId,
      sender: resolveSender(gate.identity),
      userId: input.userId ?? null,
    });
  } catch (err) {
    await withTenantTx(input.scope, (tx) =>
      sendQuotaRepository.release(tx, input.scope.tenantId),
    ).catch(() => {
      /* best-effort refund — a failed refund only under-counts usage (safe direction), never over-sends */
    });
    throw err;
  }

  // ── Record the sent message for reply threading + the inbox (BEST-EFFORT). The mail is already sent and the
  // outreach_log advanced; a recording failure must NEVER throw here (it would trigger the quota refund + a job
  // retry → a DOUBLE SEND). Outbound rows store the tenant's OWN from-address; the recipient is via contact_id.
  await recordOutboundMessage({
    scope: input.scope,
    mailboxIntegrationId: gate.identity.mailboxId,
    contactId: gate.contactId,
    sequenceId: gate.sequenceId,
    outreachLogId: input.logId,
    ownerUserId: input.userId ?? null,
    fromAddress: gate.identity.fromAddress,
    subject: gate.sequenceName,
    rfc822MessageId: result.messageId,
    occurredAt: new Date(),
  }).catch(() => {});

  return result;
}
