// gmailSend.test.ts — the Gmail send adapter through a FAKE GmailHttpPort: it POSTs the base64url RFC822 with
// the fresh access token, returns the generated Message-ID (the threading key), threads a reply, and maps
// 401/403 to a reauth-flagged GmailSendError (M12 P1). No network, no credentials.

import { describe, expect, it } from "bun:test";
import type { OutboundEmail } from "../outreach/senderPort.ts";
import { type GmailHttpPort, GmailSendError, createGmailSender } from "./gmailSend.ts";

const MSG: OutboundEmail = {
  to: "lead@example.com",
  from: "sdr@acme.com",
  subject: "Hello",
  htmlBody: "<p>Hi there</p>",
};

function fakePort(response: { status: number; body: unknown }): {
  port: GmailHttpPort;
  calls: Array<{ url: string; bearer: string; body: unknown }>;
} {
  const calls: Array<{ url: string; bearer: string; body: unknown }> = [];
  return {
    calls,
    port: {
      async postJson(url, bearer, body) {
        calls.push({ url, bearer, body });
        return response;
      },
    },
  };
}

/** Decode the `raw` field of a captured Gmail send request back to RFC822 text. */
function decodeRaw(call: { body: unknown }): string {
  const raw = (call.body as { raw: string }).raw;
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("createGmailSender.send", () => {
  it("POSTs the base64url message with the fresh token and returns the Message-ID", async () => {
    const { port, calls } = fakePort({
      status: 200,
      body: { id: "gmail-mid-1", threadId: "thr-1" },
    });
    let tokenFetches = 0;
    const sender = createGmailSender({
      getAccessToken: async () => {
        tokenFetches += 1;
        return "at-fresh";
      },
      sendingDomain: "mail.acme.com",
      http: port,
    });

    const result = await sender.send(MSG);

    expect(tokenFetches).toBe(1); // token fetched fresh, not cached at construction
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(calls[0]!.bearer).toBe("at-fresh");
    expect(result.messageId).toMatch(/^<[0-9a-f-]{36}@mail\.acme\.com>$/);

    const rfc822 = decodeRaw(calls[0]!);
    expect(rfc822).toContain(`Message-ID: ${result.messageId}`);
    expect(rfc822).toContain("To: lead@example.com");
  });

  it("threads a reply via In-Reply-To/References", async () => {
    const { port, calls } = fakePort({ status: 200, body: { id: "g2" } });
    const sender = createGmailSender({
      getAccessToken: async () => "at",
      sendingDomain: "mail.acme.com",
      http: port,
      thread: { inReplyTo: "<parent@x.com>", references: ["<root@x.com>", "<parent@x.com>"] },
    });

    await sender.send(MSG);

    const rfc822 = decodeRaw(calls[0]!);
    expect(rfc822).toContain("In-Reply-To: <parent@x.com>");
    expect(rfc822).toContain("References: <root@x.com> <parent@x.com>");
  });

  it("maps 401 to a reauth-flagged GmailSendError", async () => {
    const sender = createGmailSender({
      getAccessToken: async () => "stale",
      sendingDomain: "mail.acme.com",
      http: fakePort({ status: 401, body: { error: { message: "Invalid Credentials" } } }).port,
    });
    const err = await sender.send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(GmailSendError);
    expect((err as GmailSendError).reauth).toBe(true);
  });

  it("maps 403 (scope/grant) to reauth, and 5xx to a non-reauth failure", async () => {
    const forbidden = createGmailSender({
      getAccessToken: async () => "t",
      sendingDomain: "mail.acme.com",
      http: fakePort({ status: 403, body: { error: { message: "insufficient" } } }).port,
    });
    await expect(forbidden.send(MSG)).rejects.toMatchObject({ reauth: true });

    const serverErr = createGmailSender({
      getAccessToken: async () => "t",
      sendingDomain: "mail.acme.com",
      http: fakePort({ status: 503, body: null }).port,
    });
    await expect(serverErr.send(MSG)).rejects.toMatchObject({ reauth: false, code: "send_failed" });
  });
});
