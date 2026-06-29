// mailboxConnectFlow.test.ts — the OAuth connect handshake security invariants (M12 P1). Hermetic: the
// data-access layer is injected via the `deps` seam (no DB), so we assert the policy directly — the callback
// recovers scope from the SINGLE-USE state (never the caller), rejects a stale/replayed state, rejects a consent
// that dropped the send scope, and upserts (connect vs reconnect). The real RLS/persistence path is proven by
// the cross-tenant isolation itest (oauth_connect_state) in CI.

import { beforeEach, describe, expect, it } from "bun:test";
import {
  type MailboxConnectDeps,
  completeMailboxConnect,
  startMailboxConnect,
} from "./mailboxConnectFlow.ts";
import type { MailboxOAuthProvider } from "./oauthProvider.ts";
import { registerOAuthProvider, resetOAuthProviders } from "./oauthProvider.ts";
import { encryptSecret } from "./secretStore.ts";

const SEND = "https://www.googleapis.com/auth/gmail.send";

/** A fake Google provider; override exchangeCode to simulate a downgraded grant. */
function fakeGoogle(over: Partial<MailboxOAuthProvider> = {}): MailboxOAuthProvider {
  const base: MailboxOAuthProvider = {
    provider: "google",
    authorizeUrl: ({ state, codeChallenge }) =>
      `https://consent.example/o?state=${state}&cc=${codeChallenge}`,
    exchangeCode: async () => ({
      accessToken: "at-live",
      refreshToken: "rt-live",
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: [SEND, "openid", "email"],
      tokenType: "Bearer",
    }),
    refresh: async () => ({
      accessToken: "at-2",
      refreshToken: "rt-live",
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: [SEND, "openid", "email"],
      tokenType: "Bearer",
    }),
    fetchIdentity: async () => ({ accountId: "g-acc-1", email: "sdr@acme.com" }),
    revoke: async () => {},
  };
  return { ...base, ...over } as MailboxOAuthProvider;
}

// ── A recording in-memory `deps` ────────────────────────────────────────────────────────────────────────
interface Recorder {
  deps: MailboxConnectDeps;
  inserts: unknown[];
  marks: Array<{ id: string; cred: Record<string, unknown> }>;
  audits: Array<Record<string, unknown>>;
  creates: unknown[];
}

function recorder(opts: {
  consumeRow?: Record<string, unknown> | null;
  existingId?: string | null;
}): Recorder {
  const inserts: unknown[] = [];
  const marks: Array<{ id: string; cred: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const creates: unknown[] = [];
  const deps: MailboxConnectDeps = {
    withTenantTx: (async (_scope: unknown, fn: (tx: unknown) => unknown) =>
      fn({})) as MailboxConnectDeps["withTenantTx"],
    mailboxRepository: {
      insert: async (_tx, row) => {
        inserts.push(row);
        return "mbx-new";
      },
      findIdByWorkspaceAddress: async () => opts.existingId ?? null,
      markConnected: async (_tx, id, cred) => {
        marks.push({ id, cred: cred as Record<string, unknown> });
      },
    },
    connectStateRepository: {
      create: async (_tx, row) => {
        creates.push(row);
      },
      consume: async () => (opts.consumeRow === undefined ? null : opts.consumeRow) as never,
    },
    writeAudit: (async (_tx: unknown, entry: unknown) => {
      audits.push(entry as Record<string, unknown>);
    }) as unknown as MailboxConnectDeps["writeAudit"],
  };
  return { deps, inserts, marks, audits, creates };
}

function stateRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: "t1",
    workspaceId: "w1",
    userId: "u1",
    provider: "google",
    pkceVerifierEnc: encryptSecret("the-verifier"),
    redirectAfter: "/settings/mailboxes",
    ...over,
  };
}

beforeEach(() => {
  resetOAuthProviders();
});

describe("completeMailboxConnect", () => {
  it("recovers scope from the single-use state and connects a NEW mailbox", async () => {
    registerOAuthProvider(fakeGoogle());
    const rec = recorder({ consumeRow: stateRow(), existingId: null });

    const out = await completeMailboxConnect({ stateToken: "st-1", code: "code-1" }, rec.deps);

    expect(out).toMatchObject({
      ok: true,
      mailboxId: "mbx-new",
      reconnect: false,
      address: "sdr@acme.com",
      redirectAfter: "/settings/mailboxes",
    });
    expect(rec.inserts).toHaveLength(1);
    expect(rec.marks[0]!.id).toBe("mbx-new");
    expect(rec.marks[0]!.cred.providerAccountId).toBe("g-acc-1");
    expect(rec.marks[0]!.cred.oauthScopes).toContain(SEND);
    expect(rec.marks[0]!.cred.oauthExpiresAt).toBeInstanceOf(Date);
    // The token bundle is stored ENCRYPTED, never in the clear.
    expect(rec.marks[0]!.cred.oauthTokenEnc).toBeInstanceOf(Uint8Array);
    expect(rec.audits[0]!.action).toBe("mailbox.connect");
    expect((rec.audits[0]!.metadata as Record<string, unknown>).reconnect).toBe(false);
  });

  it("rejects a stale/replayed/forged state with NO write", async () => {
    registerOAuthProvider(fakeGoogle());
    const rec = recorder({ consumeRow: null });

    const out = await completeMailboxConnect({ stateToken: "old", code: "c" }, rec.deps);

    expect(out).toEqual({ ok: false, reason: "invalid_state", redirectAfter: null });
    expect(rec.inserts).toHaveLength(0);
    expect(rec.marks).toHaveLength(0);
  });

  it("rejects a consent that dropped the send scope (un-sendable mailbox)", async () => {
    registerOAuthProvider(
      fakeGoogle({
        exchangeCode: async () => ({
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: new Date(Date.now() + 3_600_000),
          scope: ["openid", "email"], // no gmail.send
          tokenType: "Bearer",
        }),
      }),
    );
    const rec = recorder({ consumeRow: stateRow() });

    const out = await completeMailboxConnect({ stateToken: "st", code: "c" }, rec.deps);

    expect(out).toMatchObject({ ok: false, reason: "missing_send_scope" });
    expect(rec.inserts).toHaveLength(0);
    expect(rec.marks).toHaveLength(0);
  });

  it("maps an exchange OAuthError to a reason without throwing", async () => {
    registerOAuthProvider(
      fakeGoogle({
        exchangeCode: async () => {
          const { OAuthError } = await import("./oauthProvider.ts");
          throw new OAuthError("invalid_grant", "stale code", 400);
        },
      }),
    );
    const rec = recorder({ consumeRow: stateRow() });

    const out = await completeMailboxConnect({ stateToken: "st", code: "c" }, rec.deps);

    expect(out).toMatchObject({ ok: false, reason: "invalid_grant" });
    expect(rec.marks).toHaveLength(0);
  });

  it("re-auths an EXISTING mailbox in place (no duplicate row)", async () => {
    registerOAuthProvider(fakeGoogle());
    const rec = recorder({ consumeRow: stateRow(), existingId: "mbx-existing" });

    const out = await completeMailboxConnect({ stateToken: "st", code: "c" }, rec.deps);

    expect(out).toMatchObject({ ok: true, mailboxId: "mbx-existing", reconnect: true });
    expect(rec.inserts).toHaveLength(0); // upsert, not insert
    expect(rec.marks[0]!.id).toBe("mbx-existing");
    expect((rec.audits[0]!.metadata as Record<string, unknown>).reconnect).toBe(true);
  });
});

describe("startMailboxConnect", () => {
  it("fails closed (503 provider_unconfigured) when the provider is not registered", async () => {
    const rec = recorder({});
    await expect(
      startMailboxConnect(
        { scope: { tenantId: "t1", workspaceId: "w1" }, userId: "u1", provider: "google" },
        rec.deps,
      ),
    ).rejects.toMatchObject({ code: "provider_unconfigured", status: 503 });
    expect(rec.creates).toHaveLength(0);
  });

  it("persists a handshake and returns the provider consent URL", async () => {
    registerOAuthProvider(fakeGoogle());
    const rec = recorder({});

    const { authorizeUrl } = await startMailboxConnect(
      {
        scope: { tenantId: "t1", workspaceId: "w1" },
        userId: "u1",
        provider: "google",
        redirectAfter: "/settings/mailboxes",
      },
      rec.deps,
    );

    expect(rec.creates).toHaveLength(1);
    expect(authorizeUrl.startsWith("https://consent.example/o?state=")).toBe(true);
  });
});
