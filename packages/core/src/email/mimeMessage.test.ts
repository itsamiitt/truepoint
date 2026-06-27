// mimeMessage.test.ts — RFC 5322 message construction for a provider send (M12 P1): the Message-ID threading
// key, reply headers, the header-injection guard, and the Gmail base64url encoding. Pure, no network.

import { describe, expect, it } from "bun:test";
import { buildRfc822, generateMessageId, toGmailRaw } from "./mimeMessage.ts";

const FIXED = new Date("2026-06-26T10:00:00Z");

describe("generateMessageId", () => {
  it("returns <uuid@domain> using the sending domain", () => {
    const id = generateMessageId("mail.acme.com");
    expect(id).toMatch(/^<[0-9a-f-]{36}@mail\.acme\.com>$/);
  });

  it("falls back to a safe host when the domain is empty/unsafe", () => {
    expect(generateMessageId("")).toMatch(/@mail\.local>$/);
    expect(generateMessageId("bad host!")).toMatch(/^<[0-9a-f-]{36}@badhost>$/);
  });
});

describe("buildRfc822", () => {
  const base = {
    from: "sdr@acme.com",
    to: "lead@example.com",
    subject: "Quick question",
    htmlBody: "<p>Hello</p>",
    messageId: "<mid-1@mail.acme.com>",
    date: FIXED,
  };

  it("emits the core headers, the Message-ID, and a base64 HTML body", () => {
    const out = buildRfc822(base);
    expect(out).toContain("From: sdr@acme.com");
    expect(out).toContain("To: lead@example.com");
    expect(out).toContain("Subject: Quick question");
    expect(out).toContain("Message-ID: <mid-1@mail.acme.com>");
    expect(out).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(out).toContain("Content-Transfer-Encoding: base64");
    const body = out.split("\r\n\r\n")[1]!;
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("<p>Hello</p>");
  });

  it("STRIPS CR/LF from header values (header-injection guard)", () => {
    const out = buildRfc822({
      ...base,
      subject: "Hi\r\nBcc: victim@evil.com",
    });
    // The injected Bcc must NOT become its own header line.
    expect(out).not.toMatch(/^Bcc:/m);
    expect(out).toContain("Subject: Hi Bcc: victim@evil.com");
  });

  it("RFC 2047 B-encodes a non-ASCII subject", () => {
    const out = buildRfc822({ ...base, subject: "Café ☕" });
    expect(out).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it("adds In-Reply-To and References only when replying", () => {
    const plain = buildRfc822(base);
    expect(plain).not.toContain("In-Reply-To:");
    expect(plain).not.toContain("References:");

    const reply = buildRfc822({
      ...base,
      inReplyTo: "<parent@x.com>",
      references: ["<root@x.com>", "<parent@x.com>"],
    });
    expect(reply).toContain("In-Reply-To: <parent@x.com>");
    expect(reply).toContain("References: <root@x.com> <parent@x.com>");
  });
});

describe("toGmailRaw", () => {
  it("is url-safe base64 with no padding and round-trips", () => {
    const raw = toGmailRaw("From: a@b.com\r\n\r\nbody>>>");
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw).not.toContain("=");
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    expect(decoded).toBe("From: a@b.com\r\n\r\nbody>>>");
  });
});
