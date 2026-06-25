// schedulerRepository.ts — the leader-locked sequence scheduler's claim (M12 P4, email-planning/13 P4,
// 15 §A.4, known-gap #5). The scheduler runs PLATFORM-WIDE (cross-tenant), so this uses the base db
// connection (owner) — NOT withTenantTx — exactly like creditRepository.grantFromEvent (the system path).
// claimDueEnrollments atomically CLAIMS a bounded batch of due enrollments with FOR UPDATE SKIP LOCKED and
// reserves them (bumps last_event_at) in ONE statement, so two concurrent ticks NEVER claim the same
// enrollment — the no-double-advance guarantee. "Due" = an active enrollment whose sequence is active, that
// has a next step, and whose delay has elapsed; a replied/bounced/completed/unsubscribed enrollment is
// excluded (auto-pause-on-reply: a replied row is simply never claimed).

import { sql } from "drizzle-orm";
import { db } from "../client.ts";

export interface ClaimedEnrollment {
  logId: string;
  tenantId: string;
  workspaceId: string;
  /** The step already sent; the step the tick will advance to is currentStep + 1 (the BullMQ dedup key). */
  currentStep: number;
}

export const schedulerRepository = {
  /**
   * Claim + reserve up to `limit` due enrollments across all tenants. The inner SELECT … FOR UPDATE OF ol
   * SKIP LOCKED takes a row lock only on the outreach_log rows it can immediately lock (others are skipped),
   * and the wrapping UPDATE LEASES them by pushing last_event_at 5 minutes into the future so the next tick
   * does not re-pick a still-in-flight step (a delay-0 step would otherwise stay due). The send transaction
   * (sendStep) overwrites last_event_at with the real send time on success, so per-step delays are preserved;
   * if the send never happens the lease expires and the step retries. Returns the tuples + current_step (the
   * BullMQ dedup cursor) for the worker to enqueue per-tenant.
   */
  async claimDueEnrollments(limit: number): Promise<ClaimedEnrollment[]> {
    const rows = (await db.execute(sql`
      UPDATE outreach_log ol
         SET last_event_at = now() + interval '5 minutes'
       WHERE ol.id IN (
         SELECT inner_ol.id
           FROM outreach_log inner_ol
           JOIN outreach_sequences seq
             ON seq.id = inner_ol.sequence_id AND seq.status = 'active'
           JOIN outreach_steps os
             ON os.sequence_id = inner_ol.sequence_id
            AND os.step_order = inner_ol.current_step + 1
          WHERE inner_ol.status IN ('enrolled', 'active')
            AND inner_ol.last_event_at + (os.delay_hours * interval '1 hour') <= now()
          ORDER BY inner_ol.last_event_at
          LIMIT ${limit}
          FOR UPDATE OF inner_ol SKIP LOCKED
       )
      RETURNING ol.id AS log_id, ol.tenant_id AS tenant_id, ol.workspace_id AS workspace_id,
                ol.current_step AS current_step
    `)) as unknown as Array<{
      log_id: string;
      tenant_id: string;
      workspace_id: string;
      current_step: number;
    }>;
    return rows.map((r) => ({
      logId: r.log_id,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      currentStep: Number(r.current_step),
    }));
  },
};
