// outreachLogRepository.ts — data access for per-contact enrollment state (outreach domain, 03 §7,
// ADR-0009) plus the two cross-table strokes the enroll/bounce transactions need and contactRepository
// deliberately does not own: the contacts.outreach_status rollup and the ADR-0013 bounce credit-back
// against the tenant counter. Statuses come back as plain strings; core narrows to the closed enum.

import { and, desc, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { outreachLog, outreachSequences } from "../schema/outreach.ts";

export interface EnrollmentInsert {
  tenantId: string;
  workspaceId: string;
  sequenceId: string;
  contactId: string;
}

export interface EnrollmentRecord {
  id: string;
  status: string;
  currentStep: number;
}

/** The enrollment joined with its sequence — everything the send/bounce transactions read up front. */
export interface LogWithSequence {
  id: string;
  sequenceId: string;
  contactId: string;
  status: string;
  currentStep: number;
  sequenceName: string;
  sequenceStatus: string;
  fromAddress: string | null;
  physicalAddress: string | null;
}

export interface OutreachLogRow {
  id: string;
  contactId: string;
  status: string;
  currentStep: number;
  lastEventAt: Date;
}

export const outreachLogRepository = {
  /**
   * The idempotent enrollment: INSERT … ON CONFLICT (sequence_id, contact_id) DO NOTHING. Returns the new
   * log id, or null when the (sequence, contact) membership already exists (→ alreadyEnrolled).
   */
  async enroll(tx: Tx, row: EnrollmentInsert): Promise<string | null> {
    const inserted = await tx
      .insert(outreachLog)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: outreachLog.id });
    return inserted[0]?.id ?? null;
  },

  async findBySequenceAndContact(
    tx: Tx,
    sequenceId: string,
    contactId: string,
  ): Promise<EnrollmentRecord | null> {
    const rows = await tx
      .select({
        id: outreachLog.id,
        status: outreachLog.status,
        currentStep: outreachLog.currentStep,
      })
      .from(outreachLog)
      .where(and(eq(outreachLog.sequenceId, sequenceId), eq(outreachLog.contactId, contactId)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Load the enrollment + its sequence inside the send/bounce tx. Null when not in this workspace (RLS). */
  async getWithSequence(tx: Tx, logId: string): Promise<LogWithSequence | null> {
    const rows = await tx
      .select({
        id: outreachLog.id,
        sequenceId: outreachLog.sequenceId,
        contactId: outreachLog.contactId,
        status: outreachLog.status,
        currentStep: outreachLog.currentStep,
        sequenceName: outreachSequences.name,
        sequenceStatus: outreachSequences.status,
        fromAddress: outreachSequences.fromAddress,
        physicalAddress: outreachSequences.physicalAddress,
      })
      .from(outreachLog)
      .innerJoin(outreachSequences, eq(outreachSequences.id, outreachLog.sequenceId))
      .where(eq(outreachLog.id, logId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Advance after a successful send: bump current_step, set the lifecycle status, stamp the event. */
  async advance(
    tx: Tx,
    logId: string,
    next: { currentStep: number; status: string },
  ): Promise<void> {
    await tx
      .update(outreachLog)
      .set({ currentStep: next.currentStep, status: next.status, lastEventAt: sql`now()` })
      .where(eq(outreachLog.id, logId));
  },

  /** Lifecycle-only transition (bounced/unsubscribed/replied) — stamps the event, keeps current_step. */
  async setStatus(tx: Tx, logId: string, status: string): Promise<void> {
    await tx
      .update(outreachLog)
      .set({ status, lastEventAt: sql`now()` })
      .where(eq(outreachLog.id, logId));
  },

  /** Newest-first enrollment log for a sequence (GET /outreach/sequences/:id/log). RLS-scoped. */
  async listBySequence(
    scope: TenantScope,
    sequenceId: string,
    limit = 200,
  ): Promise<OutreachLogRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: outreachLog.id,
          contactId: outreachLog.contactId,
          status: outreachLog.status,
          currentStep: outreachLog.currentStep,
          lastEventAt: outreachLog.lastEventAt,
        })
        .from(outreachLog)
        .where(eq(outreachLog.sequenceId, sequenceId))
        .orderBy(desc(outreachLog.lastEventAt))
        .limit(limit),
    );
  },

  /** Roll the contact-level outreach_status up to in_sequence (05 §13). RLS scopes the row; raw SQL so the
   * outreach domain does not widen contactRepository's write surface. */
  async markContactInSequence(tx: Tx, contactId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE contacts SET outreach_status = 'in_sequence' WHERE id = ${contactId}`,
    );
  },

  /**
   * ADR-0013/H13 credit-back: if this workspace copy holds a CHARGED email reveal for the contact, refund
   * that amount onto the tenant counter (the documented counter-adjustment path) and return it; 0 when the
   * reveal was free/absent. Caller audits `credit.adjust` in the same tx.
   */
  async creditBackForBounce(
    tx: Tx,
    args: { tenantId: string; workspaceId: string; contactId: string },
  ): Promise<number> {
    const rows = (await tx.execute(
      sql`SELECT credits_consumed AS credits FROM contact_reveals
          WHERE workspace_id = ${args.workspaceId} AND contact_id = ${args.contactId}
            AND reveal_type = 'email' AND credits_consumed > 0
          LIMIT 1`,
    )) as unknown as Array<{ credits: number }>;
    const amount = rows.length > 0 ? Number(rows[0]!.credits) : 0;
    if (amount > 0) {
      await tx.execute(
        sql`UPDATE tenants SET reveal_credit_balance = reveal_credit_balance + ${amount}
            WHERE id = ${args.tenantId}`,
      );
    }
    return amount;
  },
};
