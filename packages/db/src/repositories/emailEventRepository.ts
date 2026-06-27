// emailEventRepository.ts — data access for email_event (M12 email, email-planning/13 P0→P3, 04, 15 §A.2).
// WORKSPACE-scoped, append-only raw tracking firehose. It FEEDS `activities` (the product timeline) and
// drives `outreach_log` status — it does NOT replace them (D11). Ingestion is idempotent on
// provider_event_id: a duplicate provider webhook delivery is a no-op (ON CONFLICT DO NOTHING). Reads here
// are intentionally narrow (P0 ships the store + isolation proof; the P3 ingestion projection adds the
// tracking-queue writer). Mirrors outreachLogRepository.

import { desc, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { emailEvent } from "../schema/email.ts";

// Mirrors the email_event_type CHECK (schema/email.ts). `reply`/`auto_reply` (M12 P3) make an inbound reply
// representable so it can auto-pause the sequence (an auto_reply/OOO never counts as a human reply).
export type EmailEventType =
  | "delivery"
  | "open"
  | "click"
  | "bounce"
  | "complaint"
  | "unsubscribe"
  | "reply"
  | "auto_reply";

export interface EmailEventInsert {
  tenantId: string;
  workspaceId: string;
  outreachLogId?: string | null;
  contactId?: string | null;
  messageId?: string | null;
  eventType: EmailEventType;
  providerEventId?: string | null;
  isMppSuspected?: boolean;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface EmailEventRow {
  id: string;
  outreachLogId: string | null;
  contactId: string | null;
  eventType: string;
  isMppSuspected: boolean;
  occurredAt: Date;
}

const columns = {
  id: emailEvent.id,
  outreachLogId: emailEvent.outreachLogId,
  contactId: emailEvent.contactId,
  eventType: emailEvent.eventType,
  isMppSuspected: emailEvent.isMppSuspected,
  occurredAt: emailEvent.occurredAt,
};

export const emailEventRepository = {
  /**
   * Idempotent ingest: INSERT … ON CONFLICT (provider_event_id) DO NOTHING (15 §A.2). Returns the new row id,
   * or null when this provider event was already ingested (a duplicate webhook delivery). Rows with no
   * provider_event_id (our own synthetic 'delivery' projections) always insert.
   */
  async ingest(tx: Tx, row: EmailEventInsert): Promise<string | null> {
    const inserted = await tx
      .insert(emailEvent)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        outreachLogId: row.outreachLogId ?? null,
        contactId: row.contactId ?? null,
        messageId: row.messageId ?? null,
        eventType: row.eventType,
        providerEventId: row.providerEventId ?? null,
        isMppSuspected: row.isMppSuspected ?? false,
        occurredAt: row.occurredAt,
        metadata: row.metadata ?? {},
      })
      .onConflictDoNothing({ target: emailEvent.providerEventId })
      .returning({ id: emailEvent.id });
    return inserted[0]?.id ?? null;
  },

  /** Newest-first events for one contact — the per-contact timeline source (P3). RLS-scoped. */
  async listByContact(
    scope: TenantScope,
    contactId: string,
    limit = 200,
  ): Promise<EmailEventRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select(columns)
        .from(emailEvent)
        .where(eq(emailEvent.contactId, contactId))
        .orderBy(desc(emailEvent.occurredAt))
        .limit(limit),
    );
  },

  /** Count this workspace's events of a type — the cheap read the P0 isolation itest asserts on. RLS-scoped. */
  async countByType(scope: TenantScope, eventType: EmailEventType): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM email_event WHERE event_type = ${eventType}`,
      )) as unknown as Array<{ n: number }>;
      return rows.length > 0 ? Number(rows[0]!.n) : 0;
    });
  },
};
