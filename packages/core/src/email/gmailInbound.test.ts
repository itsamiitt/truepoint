// gmailInbound.test.ts — unit tests for the Gmail READ transport (M12 P3): parseGmailMessage turns a
// users.messages.get payload into a ParsedGmailInbound; fetchInboundSince lists history + fetches messages
// through an injectable fake port. No Google, no DB.

import { describe, expect, test } from "bun:test";
import { type GmailReadPort, fetchInboundSince, parseGmailMessage } from "./gmailInbound.ts";

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const message = (id: string) => ({
  id,
  internalDate: "1735689600000", // 2025-01-01
  snippet: "Yes, let's talk next week",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Jane Doe <jane@acme.com>" },
      { name: "To", value: "rep@truepoint.in" },
      { name: "Subject", value: "Re: your proposal" },
      { name: "Message-ID", value: "<reply-1@acme.com>" },
      { name: "In-Reply-To", value: "<sent-1@send.truepoint.in>" },
      { name: "References", value: "<sent-0@send.truepoint.in> <sent-1@send.truepoint.in>" },
    ],
    parts: [{ mimeType: "text/plain", body: { data: b64u("Yes, let's talk next week.") } }],
  },
});

describe("parseGmailMessage", () => {
  test("extracts threading headers, addresses, and the decoded body", () => {
    const p = parseGmailMessage(message("gmail-1"));
    expect(p).not.toBeNull();
    expect(p?.providerMessageId).toBe("gmail-1");
    expect(p?.rfc822MessageId).toBe("<reply-1@acme.com>");
    expect(p?.inReplyTo).toBe("<sent-1@send.truepoint.in>");
    expect(p?.referenceIds).toEqual(["<sent-0@send.truepoint.in>", "<sent-1@send.truepoint.in>"]);
    expect(p?.subject).toBe("Re: your proposal");
    expect(p?.fromAddr).toBe("jane@acme.com");
    expect(p?.toAddrs).toEqual(["rep@truepoint.in"]);
    expect(p?.bodyText).toBe("Yes, let's talk next week.");
    expect(p?.headers.subject).toBe("Re: your proposal");
  });

  test("returns null for a payload with no id", () => {
    expect(parseGmailMessage({ payload: { headers: [] } })).toBeNull();
  });
});

describe("fetchInboundSince", () => {
  test("lists messageAdded ids, fetches each, and returns the new cursor", async () => {
    const port: GmailReadPort = {
      async getJson(url) {
        if (url.includes("/history")) {
          return {
            status: 200,
            body: {
              historyId: "9999",
              history: [{ messagesAdded: [{ message: { id: "gmail-1" } }] }],
            },
          };
        }
        return { status: 200, body: message("gmail-1") };
      },
    };
    const { messages, newHistoryId } = await fetchInboundSince(port, "tok", "1000");
    expect(newHistoryId).toBe("9999");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.rfc822MessageId).toBe("<reply-1@acme.com>");
  });

  test("a 401 throws a reauth error", async () => {
    const port: GmailReadPort = {
      async getJson() {
        return { status: 401, body: null };
      },
    };
    await expect(fetchInboundSince(port, "tok", "1000")).rejects.toThrow(/gmail read failed/);
  });
});
