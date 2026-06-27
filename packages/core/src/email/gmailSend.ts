// gmailSend.ts — the Gmail API send adapter realizing the M9 EmailSenderPort (M12 P1, D1/D11). Builds an RFC
// 5322 message (stable Message-ID = the threading key), base64url-encodes it, and POSTs to
// gmail.users.messages.send with the mailbox's OAuth access token — fetched FRESH per send via getAccessToken,
// so the token never lives in the adapter. A 401 (or 403 insufficient-scope/invalid-grant) is surfaced as
// GmailSendError(reauth=true) so the caller flags the mailbox reauth_required instead of silently dropping mail.
// Network goes through the injectable GmailHttpPort, so the transport is unit-testable without Google or
// credentials. sendStep and the M9 send transaction are UNCHANGED (D11) — this only registers as a sender.

import type { EmailSenderPort, OutboundEmail } from "../outreach/senderPort.ts";
import { buildRfc822, generateMessageId, toGmailRaw } from "./mimeMessage.ts";

const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** The injectable HTTP seam — a Bearer JSON POST returning the parsed body + status. */
export interface GmailHttpPort {
  postJson(url: string, bearer: string, body: unknown): Promise<{ status: number; body: unknown }>;
}

/** Default port: a Bearer JSON POST via fetch, tolerant of a non-JSON error body. */
export const fetchGmailHttpPort: GmailHttpPort = {
  async postJson(url, bearer, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  },
};

/** A Gmail send failure. `reauth` true ⇒ the credential is the problem (401/403) → mark reauth_required; the
 *  message never carries the token or the body. */
export class GmailSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reauth: boolean,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

export interface GmailSenderConfig {
  /** Fetch a FRESH access token for the mailbox (decrypt + refresh-if-needed) — never cached in the adapter. */
  getAccessToken: () => Promise<string>;
  /** The tenant's DNS-verified sending domain — the Message-ID host (D2/D3). */
  sendingDomain: string;
  http?: GmailHttpPort;
  /** Optional threading context for a reply send (P3 inbox composer). */
  thread?: { inReplyTo: string; references: string[] };
}

/** Build a Gmail EmailSenderPort. `send` returns the rfc822 Message-ID we generated (Gmail preserves the header
 *  we set), which IS the threading key — the provider message id (body.id) is captured by the send-path's
 *  email_message persistence (slice 4b). */
export function createGmailSender(config: GmailSenderConfig): EmailSenderPort {
  const http = config.http ?? fetchGmailHttpPort;
  return {
    name: "gmail",
    async send(msg: OutboundEmail): Promise<{ messageId: string }> {
      const messageId = generateMessageId(config.sendingDomain);
      const rfc822 = buildRfc822({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        htmlBody: msg.htmlBody,
        messageId,
        inReplyTo: config.thread?.inReplyTo ?? null,
        references: config.thread?.references,
      });
      const accessToken = await config.getAccessToken();
      const { status, body } = await http.postJson(SEND_ENDPOINT, accessToken, {
        raw: toGmailRaw(rfc822),
      });
      if (status === 401 || status === 403) {
        throw new GmailSendError("unauthorized", `Gmail rejected the send (${status})`, true);
      }
      if (status !== 200) {
        const detail =
          (body as { error?: { message?: string } } | null)?.error?.message ?? `status ${status}`;
        throw new GmailSendError("send_failed", detail, false);
      }
      return { messageId };
    },
  };
}
