// emailThreadRepository.ts — data access for email_thread (M12 P1 outbound / P3 inbox). WORKSPACE-scoped (RLS)
// + OWNER-scoped reads (D8, an app filter on top). A thread is one conversation: outbound sends and inbound
// replies for a (mailbox, contact, sequence) collapse into it so a reply can resolve back to the enrollment.
// Bodies/PII live on email_message, never here. Run inside the caller's withTenantTx.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { emailThread } from "../schema/email.ts";

export interface ThreadInsert {
  tenantId: string;
  workspaceId: string;
  contactId?: string | null;
  ownerUserId?: string | null;
  mailboxIntegrationId: string;
  sequenceId?: string | null;
  providerThreadId?: string | null;
  subjectNormalized?: string | null;
}

export const emailThreadRepository = {
  /**
   * Find the existing conversation for an outbound send keyed by (workspace, mailbox, contact, sequence) — the
   * upsert key so repeated sends in one enrollment collapse into ONE thread (there is no provider thread id for
   * an outbound send, so we key on our own identifiers). Null sequence is matched as null.
   */
  async findConversation(
    tx: Tx,
    q: {
      workspaceId: string;
      mailboxIntegrationId: string;
      contactId: string;
      sequenceId: string | null;
    },
  ): Promise<string | null> {
    const rows = await tx
      .select({ id: emailThread.id })
      .from(emailThread)
      .where(
        and(
          eq(emailThread.workspaceId, q.workspaceId),
          eq(emailThread.mailboxIntegrationId, q.mailboxIntegrationId),
          eq(emailThread.contactId, q.contactId),
          q.sequenceId ? eq(emailThread.sequenceId, q.sequenceId) : isNull(emailThread.sequenceId),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  },

  async insert(tx: Tx, row: ThreadInsert): Promise<string> {
    const inserted = await tx
      .insert(emailThread)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        contactId: row.contactId ?? null,
        ownerUserId: row.ownerUserId ?? null,
        mailboxIntegrationId: row.mailboxIntegrationId,
        sequenceId: row.sequenceId ?? null,
        providerThreadId: row.providerThreadId ?? null,
        subjectNormalized: row.subjectNormalized ?? null,
      })
      .returning({ id: emailThread.id });
    return inserted[0]!.id;
  },

  /** Bump the activity cursor after a message lands (last_message_at + message_count). */
  async recordMessage(tx: Tx, threadId: string, occurredAt: Date): Promise<void> {
    await tx
      .update(emailThread)
      .set({
        lastMessageAt: occurredAt,
        messageCount: sql`${emailThread.messageCount} + 1`,
      })
      .where(eq(emailThread.id, threadId));
  },
};
