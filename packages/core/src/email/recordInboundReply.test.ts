// recordInboundReply.test.ts — unit tests for the M12 P3 inbound-recorder core, with injected fake repos: a
// human reply auto-pauses its enrollment; an auto-reply is recorded but NEVER pauses; an unmatched reply is
// skipped. No database — the repo contract is faked.

import { describe, expect, test } from "bun:test";
import {
  type ParsedInboundReply,
  type RecordInboundDeps,
  recordInboundReply,
} from "./recordInboundReply.ts";

type Match = {
  threadId: string;
  outreachLogId: string | null;
  contactId: string | null;
  mailboxIntegrationId: string | null;
};

interface Calls {
  insert: Array<Record<string, unknown>>;
  ingest: Array<Record<string, unknown>>;
  setReplied: Array<{ id: string; at: Date }>;
  recordMessage: Array<{ id: string; at: Date }>;
}

function fakeDeps(match: Match | null): { deps: RecordInboundDeps; calls: Calls } {
  const calls: Calls = { insert: [], ingest: [], setReplied: [], recordMessage: [] };
  const deps: RecordInboundDeps = {
    emailMessageRepository: {
      findOutboundByRfc822MessageId: async () => match,
      insert: async (_tx, row) => {
        calls.insert.push(row as unknown as Record<string, unknown>);
        return "msg-1";
      },
    },
    emailThreadRepository: {
      recordMessage: async (_tx, id, at) => {
        calls.recordMessage.push({ id, at });
      },
    },
    emailEventRepository: {
      ingest: async (_tx, row) => {
        calls.ingest.push(row as unknown as Record<string, unknown>);
        return "evt-1";
      },
    },
    outreachLogRepository: {
      setReplied: async (_tx, id, at) => {
        calls.setReplied.push({ id, at });
      },
    },
  };
  return { deps, calls };
}

const tx = {} as unknown as Parameters<typeof recordInboundReply>[0];
const scope = { tenantId: "t", workspaceId: "w", mailboxIntegrationId: "m" };

function parsed(over: Partial<ParsedInboundReply> = {}): ParsedInboundReply {
  return {
    providerMessageId: "gmail-1",
    rfc822MessageId: "<reply@acme.com>",
    inReplyTo: "<sent@send.truepoint.in>",
    referenceIds: [],
    subject: "Re: your proposal",
    snippet: "Yes, let's talk",
    fromAddr: "jane@acme.com",
    toAddrs: ["rep@truepoint.in"],
    bodyEnc: null,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    headers: { subject: "Re: your proposal" },
    ...over,
  };
}

describe("recordInboundReply", () => {
  test("a human reply matched to an enrollment auto-pauses it", async () => {
    const { deps, calls } = fakeDeps({
      threadId: "th",
      outreachLogId: "log",
      contactId: "c",
      mailboxIntegrationId: "m",
    });
    const r = await recordInboundReply(tx, scope, parsed(), deps);
    expect(r).toEqual({ matched: true, classification: "human", autoPaused: true });
    expect(calls.insert[0]?.direction).toBe("inbound");
    expect(calls.ingest[0]?.eventType).toBe("reply");
    expect(calls.recordMessage).toHaveLength(1);
    expect(calls.setReplied).toHaveLength(1);
    expect(calls.setReplied[0]?.id).toBe("log");
  });

  test("an auto-reply is recorded but NEVER pauses the sequence", async () => {
    const { deps, calls } = fakeDeps({
      threadId: "th",
      outreachLogId: "log",
      contactId: "c",
      mailboxIntegrationId: "m",
    });
    const r = await recordInboundReply(
      tx,
      scope,
      parsed({ headers: { subject: "Re: hi", "auto-submitted": "auto-replied" } }),
      deps,
    );
    expect(r).toMatchObject({ matched: true, classification: "auto_reply", autoPaused: false });
    expect(calls.ingest[0]?.eventType).toBe("auto_reply");
    expect(calls.setReplied).toHaveLength(0);
  });

  test("a reply matching nothing we sent is skipped", async () => {
    const { deps, calls } = fakeDeps(null);
    const r = await recordInboundReply(tx, scope, parsed(), deps);
    expect(r).toEqual({ matched: false, classification: "unknown", autoPaused: false });
    expect(calls.insert).toHaveLength(0);
    expect(calls.setReplied).toHaveLength(0);
  });
});
