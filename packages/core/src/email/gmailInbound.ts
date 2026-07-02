// gmailInbound.ts — the Gmail READ transport for M12 P3 inbound ingestion (mirrors gmailSend's injectable port).
// Two pieces: (1) parseGmailMessage — pure, turns a Gmail users.messages.get payload into a ParsedInboundReply
// (minus the encrypted body: it returns PLAINTEXT bodyText; the worker encrypts + calls recordInboundReply);
// (2) fetchInboundSince — lists users.history since a cursor + fetches the new messages via the injectable
// GmailReadPort, so the transport is unit-testable without Google. DARK: only the polling worker calls this.

import type { InboundHeaders } from "./detectAutoReply.ts";
import type { ParsedInboundReply } from "./recordInboundReply.ts";

/** The injectable READ seam — a Bearer JSON GET returning the parsed body + status. */
export interface GmailReadPort {
  getJson(url: string, bearer: string): Promise<{ status: number; body: unknown }>;
}

/** Default port: a Bearer JSON GET via fetch, tolerant of a non-JSON error body. */
export const fetchGmailReadPort: GmailReadPort = {
  async getJson(url, bearer) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  },
};

/** A parsed inbound Gmail message — everything recordInboundReply needs except the ENCRYPTED body (the worker
 *  encrypts `bodyText` into bodyEnc before calling it, so plaintext never reaches the recorder). */
export type ParsedGmailInbound = Omit<ParsedInboundReply, "bodyEnc"> & { bodyText: string | null };

interface GmailHeader {
  name?: string;
  value?: string;
}
interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id?: string;
  internalDate?: string;
  snippet?: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailPart[];
  };
}

function base64UrlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Extract the first text/plain (else text/html) body, base64url-decoded. Recurses multipart. */
function extractBody(part: GmailPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) return base64UrlDecode(part.body.data);
  if (part.parts) {
    for (const p of part.parts) {
      const found = extractBody(p);
      if (found) return found;
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) return base64UrlDecode(part.body.data);
  if (part.body?.data) return base64UrlDecode(part.body.data);
  return null;
}

/** Parse the first email address out of a From/To header value ("Jane <jane@acme.com>" → jane@acme.com). */
function parseAddr(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m?.[1] ?? value).trim().toLowerCase();
}

/** Turn a Gmail users.messages.get(full) payload into a ParsedGmailInbound. Returns null when it lacks an id. */
export function parseGmailMessage(raw: unknown): ParsedGmailInbound | null {
  const msg = raw as GmailMessage;
  if (!msg?.id || !msg.payload) return null;
  const headers: InboundHeaders = {};
  let messageId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  let subject: string | null = null;
  let from = "";
  const to: string[] = [];
  for (const h of msg.payload.headers ?? []) {
    if (!h.name) continue;
    const key = h.name.toLowerCase();
    const value = h.value ?? "";
    headers[key] = value;
    if (key === "message-id") messageId = value.trim();
    else if (key === "in-reply-to") inReplyTo = value.trim();
    else if (key === "references") references = value.split(/\s+/).filter(Boolean);
    else if (key === "subject") subject = value;
    else if (key === "from") from = parseAddr(value);
    else if (key === "to") to.push(...value.split(",").map(parseAddr));
  }
  const occurredAt = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(0);
  return {
    providerMessageId: msg.id,
    rfc822MessageId: messageId,
    inReplyTo,
    referenceIds: references,
    subject,
    snippet: msg.snippet ?? null,
    fromAddr: from,
    toAddrs: to,
    bodyText: extractBody(msg.payload),
    occurredAt,
    headers,
  };
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Fetch the inbound messages that arrived since `startHistoryId` (users.history.list → messages.get). Returns the
 * parsed messages + the newest historyId to persist as the cursor. On a 401/403 the caller flags reauth. A null
 * cursor (first poll) reads nothing — the caller seeds the cursor from the mailbox's current historyId first.
 */
export async function fetchInboundSince(
  port: GmailReadPort,
  accessToken: string,
  startHistoryId: string,
  limit = 50,
): Promise<{ messages: ParsedGmailInbound[]; newHistoryId: string | null }> {
  const histUrl = `${GMAIL_API}/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded&maxResults=${limit}`;
  const hist = await port.getJson(histUrl, accessToken);
  if (hist.status === 401 || hist.status === 403) throw new GmailReadError("unauthorized", true);
  if (hist.status !== 200) return { messages: [], newHistoryId: null };
  const histBody = hist.body as {
    historyId?: string;
    history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
  } | null;
  const ids = new Set<string>();
  for (const h of histBody?.history ?? []) {
    for (const a of h.messagesAdded ?? []) {
      if (a.message?.id) ids.add(a.message.id);
    }
  }
  const messages: ParsedGmailInbound[] = [];
  for (const id of ids) {
    const res = await port.getJson(
      `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
      accessToken,
    );
    if (res.status !== 200) continue;
    const parsed = parseGmailMessage(res.body);
    if (parsed) messages.push(parsed);
  }
  return { messages, newHistoryId: histBody?.historyId ?? null };
}

/** The mailbox's CURRENT historyId (users.getProfile) — the baseline to seed the poll cursor on the first tick,
 *  so the next tick fetches only messages that arrive after now (no historical backfill). */
export async function fetchProfileHistoryId(
  port: GmailReadPort,
  accessToken: string,
): Promise<string | null> {
  const res = await port.getJson(`${GMAIL_API}/profile`, accessToken);
  if (res.status === 401 || res.status === 403) throw new GmailReadError("unauthorized", true);
  if (res.status !== 200) return null;
  return (res.body as { historyId?: string } | null)?.historyId ?? null;
}

/** A Gmail read failure. `reauth` true ⇒ the credential is the problem (401/403) → mark reauth_required. */
export class GmailReadError extends Error {
  constructor(
    readonly code: string,
    readonly reauth: boolean,
  ) {
    super(`gmail read failed: ${code}`);
    this.name = "GmailReadError";
  }
}
