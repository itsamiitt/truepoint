// mimeMessage.ts — build an RFC 5322 message for a provider send (M12 P1, D1). Generates a STABLE Message-ID
// (the threading key reply detection matches on — RFC 5322 §3.6.4), sets In-Reply-To/References when replying,
// and base64url-encodes the raw message for the Gmail API. HTML-only body (the M9 OutboundEmail), UTF-8. Header
// values are CR/LF-stripped — an attacker-influenced From/To/Subject (revealed PII, template output) must never
// be able to inject extra headers (the header-injection boundary; everything outside the server is hostile).

import { randomUUID } from "node:crypto";

export interface Rfc822Input {
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
  /** The full `<id@domain>` Message-ID we generated for this send. */
  messageId: string;
  /** The parent Message-ID when this send is a reply (P3 inbox composer). */
  inReplyTo?: string | null;
  /** The thread's Message-ID chain (oldest→newest) when replying. */
  references?: string[];
  /** Injectable for deterministic tests; defaults to now. */
  date?: Date;
}

/** A stable RFC 5322 Message-ID for a send — `<uuid@sendingDomain>`, the key reply threading matches on. */
export function generateMessageId(sendingDomain: string): string {
  const domain = (sendingDomain || "mail.local").replace(/[^A-Za-z0-9.-]/g, "");
  return `<${randomUUID()}@${domain || "mail.local"}>`;
}

/** Render a header value safely: strip CR/LF (anti header-injection), RFC 2047 B-encode any non-ASCII. */
function headerValue(raw: string): string {
  const clean = raw.replace(/[\r\n]+/g, " ").trim();
  const isAscii = [...clean].every((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e;
  });
  if (isAscii) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** Fold a base64 string into ≤76-char lines (RFC 2045) so no MIME line exceeds the 998-char limit. */
function foldBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

/** Build the full RFC 5322 message text (CRLF line endings, base64 HTML body). */
export function buildRfc822(input: Rfc822Input): string {
  const headers: string[] = [
    `From: ${headerValue(input.from)}`,
    `To: ${headerValue(input.to)}`,
    `Subject: ${headerValue(input.subject)}`,
    `Message-ID: ${input.messageId.replace(/[\r\n]+/g, "")}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]+/g, "")}`);
  if (input.references && input.references.length > 0) {
    headers.push(`References: ${input.references.map((r) => r.replace(/[\r\n]+/g, "")).join(" ")}`);
  }
  headers.push(
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  );
  const body = foldBase64(Buffer.from(input.htmlBody, "utf8").toString("base64"));
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** base64url (no padding) of the raw message — the Gmail `messages.send` `raw` field. */
export function toGmailRaw(rfc822: string): string {
  return Buffer.from(rfc822, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
