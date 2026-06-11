// senderPort.ts — the email-sender port for the M9 send engine (05 §13, ADR-0009): one interface, two M9
// implementations — consoleSender (dev: logs the envelope, fabricates a message id) and staticSender
// (tests: captures into a caller-owned outbox). The SES adapter (post-commit outbox dispatch + SNS→SQS
// bounce/complaint feedback, 08 §6) replaces these at M12 without touching the send transaction.

import { randomUUID } from "node:crypto";

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  htmlBody: string;
}

export interface EmailSenderPort {
  name: string;
  send(msg: OutboundEmail): Promise<{ messageId: string }>;
}

/** Dev sender: no network — logs the envelope (never the body: it may quote revealed PII) and succeeds. */
export const consoleSender: EmailSenderPort = {
  name: "console",
  send(msg: OutboundEmail): Promise<{ messageId: string }> {
    console.info(`[outreach] send from=${msg.from} subject=${JSON.stringify(msg.subject)}`);
    return Promise.resolve({ messageId: randomUUID() });
  },
};

/** Test sender: pushes every message into the given outbox so assertions can inspect exactly what left. */
export function staticSender(captured: OutboundEmail[]): EmailSenderPort {
  return {
    name: "static",
    send(msg: OutboundEmail): Promise<{ messageId: string }> {
      captured.push(msg);
      return Promise.resolve({ messageId: randomUUID() });
    },
  };
}
