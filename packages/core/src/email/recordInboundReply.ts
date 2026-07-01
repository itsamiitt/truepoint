// recordInboundReply.ts — the deterministic CORE of M12 P3 inbound ingestion. Given a PARSED inbound message,
// thread it back to the outbound send it replies to (In-Reply-To / References → our rfc822_message_id), record
// the inbound email_message + a 'reply'/'auto_reply' email_event + bump the thread cursor, and — ONLY on a
// confirmed HUMAN reply — auto-pause the sequence enrollment (outreach_log → replied). Repos are injected so
// this is unit-testable with fakes; the ingestion worker supplies the real repos + the withTenantTx tx. The
// inbound insert is deduped by the DB unique index (mailbox, provider_message_id) + the worker's history cursor.

import {
  type Tx,
  emailEventRepository as defaultEmailEventRepository,
  emailMessageRepository as defaultEmailMessageRepository,
  emailThreadRepository as defaultEmailThreadRepository,
  outreachLogRepository as defaultOutreachLogRepository,
} from "@leadwolf/db";
import {
  type InboundHeaders,
  type ReplyClassification,
  detectAutoReply,
} from "./detectAutoReply.ts";

/** A parsed inbound message the recorder acts on (the MIME/Gmail parser produces this). */
export interface ParsedInboundReply {
  providerMessageId: string;
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  referenceIds: string[];
  subject: string | null;
  snippet: string | null;
  fromAddr: string;
  toAddrs: string[];
  /** KMS-envelope ciphertext of the body (D7) — encrypted upstream, never plaintext here. */
  bodyEnc: Uint8Array | null;
  occurredAt: Date;
  headers: InboundHeaders;
  /** Optional AI-refined classification (Part C, opt-in) — overrides the header heuristic when present. */
  classificationOverride?: ReplyClassification | null;
}

export interface RecordInboundDeps {
  emailMessageRepository: Pick<
    typeof defaultEmailMessageRepository,
    "insert" | "findOutboundByRfc822MessageId"
  >;
  emailThreadRepository: Pick<typeof defaultEmailThreadRepository, "recordMessage">;
  emailEventRepository: Pick<typeof defaultEmailEventRepository, "ingest">;
  outreachLogRepository: Pick<typeof defaultOutreachLogRepository, "setReplied">;
}

export const defaultRecordInboundDeps: RecordInboundDeps = {
  emailMessageRepository: defaultEmailMessageRepository,
  emailThreadRepository: defaultEmailThreadRepository,
  emailEventRepository: defaultEmailEventRepository,
  outreachLogRepository: defaultOutreachLogRepository,
};

export interface RecordInboundResult {
  matched: boolean;
  classification: ReplyClassification;
  autoPaused: boolean;
}

export async function recordInboundReply(
  tx: Tx,
  scope: { tenantId: string; workspaceId: string; mailboxIntegrationId: string },
  parsed: ParsedInboundReply,
  deps: RecordInboundDeps = defaultRecordInboundDeps,
): Promise<RecordInboundResult> {
  // 1. Thread-match: the reply's In-Reply-To + References ids resolve our outbound message → thread + enrollment.
  const candidateIds = [parsed.inReplyTo, ...parsed.referenceIds].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  const match = await deps.emailMessageRepository.findOutboundByRfc822MessageId(
    tx,
    scope.workspaceId,
    candidateIds,
  );
  if (!match) return { matched: false, classification: "unknown", autoPaused: false };

  // 2. Classify: the header heuristic, refined by the opt-in AI classifier (Part C) when the caller supplies an
  // override. isAuto follows the FINAL classification (an override can flip human↔auto).
  const classification =
    parsed.classificationOverride ?? detectAutoReply(parsed.headers).classification;
  const isAuto = classification !== "human";

  // 3. Record the inbound message (deduped by the DB unique index on (mailbox, provider_message_id)).
  const messageId = await deps.emailMessageRepository.insert(tx, {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    threadId: match.threadId,
    mailboxIntegrationId: scope.mailboxIntegrationId,
    contactId: match.contactId,
    outreachLogId: match.outreachLogId,
    direction: "inbound",
    providerMessageId: parsed.providerMessageId,
    rfc822MessageId: parsed.rfc822MessageId,
    inReplyTo: parsed.inReplyTo,
    referenceIds: parsed.referenceIds,
    subject: parsed.subject,
    snippet: parsed.snippet,
    fromAddr: parsed.fromAddr,
    toAddrs: parsed.toAddrs,
    bodyEnc: parsed.bodyEnc,
    isAutoReply: isAuto,
    classification,
    occurredAt: parsed.occurredAt,
  });

  // 4. Firehose event (idempotent on the provider message id) + thread activity cursor.
  await deps.emailEventRepository.ingest(tx, {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    outreachLogId: match.outreachLogId,
    contactId: match.contactId,
    messageId,
    eventType: classification === "human" ? "reply" : "auto_reply",
    providerEventId: `inbound:${parsed.providerMessageId}`,
    occurredAt: parsed.occurredAt,
  });
  await deps.emailThreadRepository.recordMessage(tx, match.threadId, parsed.occurredAt);

  // 5. Auto-pause ONLY on a confirmed human reply (an auto_reply/OOO never pauses the sequence).
  let autoPaused = false;
  if (classification === "human" && match.outreachLogId) {
    await deps.outreachLogRepository.setReplied(tx, match.outreachLogId, parsed.occurredAt);
    autoPaused = true;
  }
  return { matched: true, classification, autoPaused };
}
