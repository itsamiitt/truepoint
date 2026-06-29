// recordOutboundMessage.test.ts — outbound persistence orchestration (M12 P1). Hermetic: the @leadwolf/db
// layer is injected. Proves: a first send creates a thread (normalized subject) + an outbound email_message
// carrying the rfc822 Message-ID, and bumps the thread cursor; a subsequent send into the same conversation
// REUSES the thread (no duplicate). Plus subject normalization (Re:/Fwd: stripping).

import { describe, expect, it } from "bun:test";
import {
  type RecordOutboundDeps,
  normalizeSubject,
  recordOutboundMessage,
} from "./recordOutboundMessage.ts";

const INPUT = {
  scope: { tenantId: "t1", workspaceId: "w1" },
  mailboxIntegrationId: "mbx-1",
  contactId: "c-1",
  sequenceId: "seq-1",
  outreachLogId: "log-1",
  ownerUserId: "u-1",
  fromAddress: "sdr@acme.com",
  subject: "Re: Quick question",
  rfc822MessageId: "<mid-1@mail.acme.com>",
  occurredAt: new Date("2026-06-27T12:00:00Z"),
};

function recorder(existingThreadId: string | null): {
  deps: RecordOutboundDeps;
  threadInserts: Array<Record<string, unknown>>;
  messageInserts: Array<Record<string, unknown>>;
  bumps: Array<{ threadId: string; at: Date }>;
} {
  const threadInserts: Array<Record<string, unknown>> = [];
  const messageInserts: Array<Record<string, unknown>> = [];
  const bumps: Array<{ threadId: string; at: Date }> = [];
  const deps: RecordOutboundDeps = {
    withTenantTx: (async (_scope: unknown, fn: (tx: unknown) => unknown) =>
      fn({})) as RecordOutboundDeps["withTenantTx"],
    emailThreadRepository: {
      findConversation: async () => existingThreadId,
      insert: async (_tx, row) => {
        threadInserts.push(row as unknown as Record<string, unknown>);
        return "thr-new";
      },
      recordMessage: async (_tx, threadId, at) => {
        bumps.push({ threadId, at });
      },
    },
    emailMessageRepository: {
      insert: async (_tx, row) => {
        messageInserts.push(row as unknown as Record<string, unknown>);
        return "msg-new";
      },
    },
  };
  return { deps, threadInserts, messageInserts, bumps };
}

describe("recordOutboundMessage", () => {
  it("creates a thread + outbound message on the first send and bumps the cursor", async () => {
    const rec = recorder(null);

    const out = await recordOutboundMessage(INPUT, rec.deps);

    expect(out).toEqual({ threadId: "thr-new", messageId: "msg-new" });
    expect(rec.threadInserts).toHaveLength(1);
    expect(rec.threadInserts[0]).toMatchObject({
      workspaceId: "w1",
      mailboxIntegrationId: "mbx-1",
      contactId: "c-1",
      sequenceId: "seq-1",
      subjectNormalized: "quick question", // Re: stripped + lowercased
    });
    expect(rec.messageInserts[0]).toMatchObject({
      threadId: "thr-new",
      direction: "outbound",
      rfc822MessageId: "<mid-1@mail.acme.com>",
      outreachLogId: "log-1",
      contactId: "c-1",
      fromAddr: "sdr@acme.com",
    });
    // Recipient is via contact_id — the prospect address is NOT stored in clear on an outbound row.
    expect(rec.messageInserts[0]!.toAddrs ?? null).toBeNull();
    expect(rec.bumps[0]).toEqual({ threadId: "thr-new", at: INPUT.occurredAt });
  });

  it("reuses an existing conversation thread (no duplicate thread)", async () => {
    const rec = recorder("thr-existing");

    const out = await recordOutboundMessage(INPUT, rec.deps);

    expect(out.threadId).toBe("thr-existing");
    expect(rec.threadInserts).toHaveLength(0); // found, not created
    expect(rec.messageInserts[0]!.threadId).toBe("thr-existing");
    expect(rec.bumps[0]!.threadId).toBe("thr-existing");
  });
});

describe("normalizeSubject", () => {
  it("strips reply/forward prefixes, collapses whitespace, and lowercases", () => {
    expect(normalizeSubject("Re: Hello")).toBe("hello");
    expect(normalizeSubject("FWD:  Spaced   Out ")).toBe("spaced out");
    expect(normalizeSubject("Plain subject")).toBe("plain subject");
  });
});
