// emailMessageRepository.ts — data access for email_message (M12 P1 outbound / P3 inbound). WORKSPACE-scoped
// (RLS). The body (body_enc) is KMS-envelope ciphertext written here and decrypted ONLY server-side, never
// projected into an API response (D7). The rfc822_message_id we set on an outbound send is the threading key a
// later inbound reply matches via In-Reply-To/References. Run inside the caller's withTenantTx.

import type { Tx } from "../client.ts";
import { emailMessage } from "../schema/email.ts";

export interface MessageInsert {
  tenantId: string;
  workspaceId: string;
  threadId: string;
  mailboxIntegrationId?: string | null;
  contactId?: string | null;
  outreachLogId?: string | null;
  direction: "inbound" | "outbound";
  providerMessageId?: string | null;
  rfc822MessageId?: string | null;
  inReplyTo?: string | null;
  referenceIds?: string[] | null;
  subject?: string | null;
  snippet?: string | null;
  fromAddr: string;
  toAddrs?: string[] | null;
  /** KMS-envelope ciphertext of the body — server-side only, masked/retention-governed (D7). */
  bodyEnc?: Uint8Array | null;
  isAutoReply?: boolean;
  classification?: "human" | "auto_reply" | "ooo" | "bounce" | "unknown";
  occurredAt: Date;
}

export const emailMessageRepository = {
  async insert(tx: Tx, row: MessageInsert): Promise<string> {
    const inserted = await tx
      .insert(emailMessage)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        threadId: row.threadId,
        mailboxIntegrationId: row.mailboxIntegrationId ?? null,
        contactId: row.contactId ?? null,
        outreachLogId: row.outreachLogId ?? null,
        direction: row.direction,
        providerMessageId: row.providerMessageId ?? null,
        rfc822MessageId: row.rfc822MessageId ?? null,
        inReplyTo: row.inReplyTo ?? null,
        referenceIds: row.referenceIds ?? null,
        subject: row.subject ?? null,
        snippet: row.snippet ?? null,
        fromAddr: row.fromAddr,
        toAddrs: row.toAddrs ?? null,
        bodyEnc: row.bodyEnc ?? null,
        isAutoReply: row.isAutoReply ?? false,
        classification: row.classification ?? "unknown",
        occurredAt: row.occurredAt,
      })
      .returning({ id: emailMessage.id });
    return inserted[0]!.id;
  },
};
