// recordOutboundMessage.ts — persist an outbound send into the conversation store (M12 P1, D11). After the
// UNCHANGED M9 sendStep commits, the P1 send-gate (dispatchOutreachSend) calls this BEST-EFFORT to record the
// sent message: find-or-create the (mailbox, contact, sequence) thread, insert the outbound email_message
// carrying the rfc822 Message-ID (the key a later inbound reply matches on), and bump the thread cursor. A
// recording failure must NEVER fail a sent email or re-consume quota — the caller swallows it. Outbound rows
// store the tenant's OWN from-address (not prospect PII) and link the recipient via contact_id (no PII in clear).
// The data layer is an injectable `deps` seam so the orchestration is unit-testable without a database.

import {
  type TenantScope,
  emailMessageRepository as defaultEmailMessageRepository,
  emailThreadRepository as defaultEmailThreadRepository,
  withTenantTx as defaultWithTenantTx,
} from "@leadwolf/db";

export interface RecordOutboundDeps {
  withTenantTx: typeof defaultWithTenantTx;
  emailThreadRepository: Pick<
    typeof defaultEmailThreadRepository,
    "findConversation" | "insert" | "recordMessage"
  >;
  emailMessageRepository: Pick<typeof defaultEmailMessageRepository, "insert">;
}

const realDeps: RecordOutboundDeps = {
  withTenantTx: defaultWithTenantTx,
  emailThreadRepository: defaultEmailThreadRepository,
  emailMessageRepository: defaultEmailMessageRepository,
};

export interface RecordOutboundInput {
  scope: TenantScope & { workspaceId: string };
  mailboxIntegrationId: string;
  contactId: string;
  sequenceId: string | null;
  outreachLogId: string;
  ownerUserId: string | null;
  /** The tenant's OWN sending address — not prospect PII. */
  fromAddress: string;
  subject: string;
  /** The rfc822 Message-ID set on the send — the reply-threading key. */
  rfc822MessageId: string;
  occurredAt: Date;
}

/** Normalize a subject for thread grouping: strip Re:/Fwd: prefixes, collapse whitespace, lowercase, cap 255. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*(re|fwd?|aw|sv)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 255);
}

export interface RecordOutboundResult {
  threadId: string;
  messageId: string;
}

export async function recordOutboundMessage(
  input: RecordOutboundInput,
  deps: RecordOutboundDeps = realDeps,
): Promise<RecordOutboundResult> {
  return deps.withTenantTx(input.scope, async (tx) => {
    let threadId = await deps.emailThreadRepository.findConversation(tx, {
      workspaceId: input.scope.workspaceId,
      mailboxIntegrationId: input.mailboxIntegrationId,
      contactId: input.contactId,
      sequenceId: input.sequenceId,
    });
    if (!threadId) {
      threadId = await deps.emailThreadRepository.insert(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        contactId: input.contactId,
        ownerUserId: input.ownerUserId,
        mailboxIntegrationId: input.mailboxIntegrationId,
        sequenceId: input.sequenceId,
        subjectNormalized: normalizeSubject(input.subject),
      });
    }

    const messageId = await deps.emailMessageRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      threadId,
      mailboxIntegrationId: input.mailboxIntegrationId,
      contactId: input.contactId,
      outreachLogId: input.outreachLogId,
      direction: "outbound",
      rfc822MessageId: input.rfc822MessageId,
      subject: input.subject,
      fromAddr: input.fromAddress, // our own address — recipient is via contact_id (no prospect PII in clear)
      occurredAt: input.occurredAt,
    });

    await deps.emailThreadRepository.recordMessage(tx, threadId, input.occurredAt);
    return { threadId, messageId };
  });
}
