// mailboxTokenProvider.test.ts — send-time token loading (M12 P1, D7). Hermetic: the @leadwolf/db layer is
// injected; real secretStore + OAuth registry. Proves: a fresh token is returned without a refresh; a
// near-expiry token is refreshed + rotated (refresh token carried forward); invalid_grant / no-refresh-token
// flag reauth_required (never a silent send); a transient refresh error is re-thrown (the mailbox is NOT burned).

import { beforeEach, describe, expect, it } from "bun:test";
import {
  type MailboxTokenDeps,
  MailboxTokenError,
  getMailboxAccessToken,
} from "./mailboxTokenProvider.ts";
import type { MailboxOAuthProvider, OAuthTokenBundle } from "./oauthProvider.ts";
import { OAuthError, registerOAuthProvider, resetOAuthProviders } from "./oauthProvider.ts";
import { decryptSecret, encryptSecret } from "./secretStore.ts";

const SCOPE = { tenantId: "t1", workspaceId: "w1" };

/** Encrypt a stored bundle the way completeMailboxConnect/getMailboxAccessToken do. */
function encBundle(access: string, refresh: string | null): Uint8Array {
  return encryptSecret(
    JSON.stringify({ access_token: access, refresh_token: refresh, token_type: "Bearer" }),
  );
}

/** A fake Google provider whose `refresh` is supplied per-test. */
function fakeGoogle(refresh: MailboxOAuthProvider["refresh"]): MailboxOAuthProvider {
  return {
    provider: "google",
    authorizeUrl: () => "https://consent",
    exchangeCode: async () => ({}) as OAuthTokenBundle,
    refresh,
    fetchIdentity: async () => ({ accountId: "a", email: "e@x.com" }),
    revoke: async () => {},
  };
}

interface Bundle {
  provider: string;
  oauthTokenEnc: Uint8Array | null;
  oauthExpiresAt: Date | null;
  reauthRequired: boolean;
}

function recorder(bundle: Bundle | null): {
  deps: MailboxTokenDeps;
  updates: Array<{ id: string; enc: Uint8Array; exp: Date | null }>;
  reauths: Array<{ id: string; reason: string }>;
} {
  const updates: Array<{ id: string; enc: Uint8Array; exp: Date | null }> = [];
  const reauths: Array<{ id: string; reason: string }> = [];
  const deps: MailboxTokenDeps = {
    withTenantTx: (async (_scope: unknown, fn: (tx: unknown) => unknown) =>
      fn({})) as MailboxTokenDeps["withTenantTx"],
    mailboxRepository: {
      getTokenBundle: async () => bundle,
      updateOAuthToken: async (_tx, id, enc, exp) => {
        updates.push({ id, enc, exp });
      },
      markReauthRequired: async (_tx, id, reason) => {
        reauths.push({ id, reason });
      },
    },
  };
  return { deps, updates, reauths };
}

beforeEach(() => {
  resetOAuthProviders();
});

describe("getMailboxAccessToken", () => {
  it("returns the stored token unchanged when it is still fresh (no refresh, no write)", async () => {
    registerOAuthProvider(
      fakeGoogle(async () => {
        throw new Error("refresh must not be called for a fresh token");
      }),
    );
    const rec = recorder({
      provider: "google",
      oauthTokenEnc: encBundle("at-fresh", "rt-1"),
      oauthExpiresAt: new Date(Date.now() + 3_600_000),
      reauthRequired: false,
    });

    const token = await getMailboxAccessToken(SCOPE, "mbx-1", rec.deps);

    expect(token).toBe("at-fresh");
    expect(rec.updates).toHaveLength(0);
    expect(rec.reauths).toHaveLength(0);
  });

  it("refreshes + rotates a near-expiry token, carrying the refresh token forward", async () => {
    registerOAuthProvider(
      fakeGoogle(async () => ({
        accessToken: "at-new",
        refreshToken: undefined, // Google omits it on refresh
        expiresAt: new Date(Date.now() + 3_600_000),
        scope: ["https://www.googleapis.com/auth/gmail.send"],
        tokenType: "Bearer",
      })),
    );
    const rec = recorder({
      provider: "google",
      oauthTokenEnc: encBundle("at-old", "rt-1"),
      oauthExpiresAt: new Date(Date.now() + 60_000), // < 5-min skew
      reauthRequired: false,
    });

    const token = await getMailboxAccessToken(SCOPE, "mbx-1", rec.deps);

    expect(token).toBe("at-new");
    expect(rec.updates).toHaveLength(1);
    const rotated = JSON.parse(decryptSecret(rec.updates[0]!.enc)) as Record<string, unknown>;
    expect(rotated.access_token).toBe("at-new");
    expect(rotated.refresh_token).toBe("rt-1"); // carried forward
    expect(rec.reauths).toHaveLength(0);
  });

  it("flags reauth_required on invalid_grant (revoked refresh token)", async () => {
    registerOAuthProvider(
      fakeGoogle(async () => {
        throw new OAuthError("invalid_grant", "revoked", 400);
      }),
    );
    const rec = recorder({
      provider: "google",
      oauthTokenEnc: encBundle("at-old", "rt-dead"),
      oauthExpiresAt: new Date(Date.now() + 60_000),
      reauthRequired: false,
    });

    const err = await getMailboxAccessToken(SCOPE, "mbx-1", rec.deps).catch((e) => e);
    expect(err).toBeInstanceOf(MailboxTokenError);
    expect((err as MailboxTokenError).reauth).toBe(true);
    expect(rec.reauths[0]).toMatchObject({ id: "mbx-1", reason: "invalid_grant" });
    expect(rec.updates).toHaveLength(0);
  });

  it("refuses + flags reauth when an expired mailbox has no refresh token", async () => {
    registerOAuthProvider(fakeGoogle(async () => ({}) as OAuthTokenBundle));
    const rec = recorder({
      provider: "google",
      oauthTokenEnc: encBundle("at-old", null),
      oauthExpiresAt: new Date(Date.now() - 1_000), // expired
      reauthRequired: false,
    });

    await expect(getMailboxAccessToken(SCOPE, "mbx-1", rec.deps)).rejects.toMatchObject({
      reauth: true,
    });
    expect(rec.reauths[0]).toMatchObject({ reason: "no_refresh_token" });
  });

  it("refuses immediately when the mailbox is already flagged reauth_required", async () => {
    const rec = recorder({
      provider: "google",
      oauthTokenEnc: encBundle("at", "rt"),
      oauthExpiresAt: new Date(Date.now() + 3_600_000),
      reauthRequired: true,
    });

    await expect(getMailboxAccessToken(SCOPE, "mbx-1", rec.deps)).rejects.toMatchObject({
      code: "reauth_required",
      reauth: true,
    });
  });

  it("re-throws a TRANSIENT refresh error without burning the mailbox", async () => {
    registerOAuthProvider(
      fakeGoogle(async () => {
        throw new OAuthError("server_error", "503 from Google", 503);
      }),
    );
    const rec = recorder({
      provider: "google",
      oauthTokenEnc: encBundle("at-old", "rt-1"),
      oauthExpiresAt: new Date(Date.now() + 60_000),
      reauthRequired: false,
    });

    await expect(getMailboxAccessToken(SCOPE, "mbx-1", rec.deps)).rejects.toMatchObject({
      code: "server_error",
    });
    expect(rec.reauths).toHaveLength(0); // NOT flagged — a 5xx is retryable
    expect(rec.updates).toHaveLength(0);
  });
});
