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
import { resolveSender } from "./providerAdapter.ts";
import { resolveSendingIdentity } from "./resolveSendingIdentity.ts";

export interface DispatchOutreachSendInput {
  scope: TenantScope & { workspaceId: string };
  logId: string;
  /** Audit actor; omit for worker/automation sends. */
  userId?: string | null;
}

export async function dispatchOutreachSend(
  input: DispatchOutreachSendInput,
): Promise<SendStepResult> {
  // ── Gate tx: resolve the sending identity (D2/D3) + consume the quota (15 §A.6), atomically ──────────────
  const identity = await withTenantTx(input.scope, async (tx) => {
    const log = await outreachLogRepository.getWithSequence(tx, input.logId);
    if (!log) throw new ValidationError("Enrollment not found in this workspace.");
    if (!log.fromAddress) {
      throw new ValidationError(
        "CAN-SPAM: from address and physical postal address are required before sending.",
      );
    }
    const resolved = await resolveSendingIdentity(tx, input.scope.workspaceId, log.fromAddress);

    // Pre-consume the quota under the FOR UPDATE lock (serialises concurrent sends; refuses over-cap).
    const snapshot = await sendQuotaRepository.lock(tx, input.scope.tenantId);
    sendQuotaRepository.assertWithinQuota(snapshot);
    await sendQuotaRepository.consume(tx, input.scope.tenantId);

    return resolved;
  });

  // ── Send tx: the UNCHANGED M9 transaction with the resolved adapter (D11). Suppression/idempotency/footer
  // /advance are reused as-is. A failed send refunds the quota unit so a failure never burns the tenant's cap.
  try {
    return await sendStep({
      scope: input.scope,
      logId: input.logId,
      sender: resolveSender(identity),
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
}
