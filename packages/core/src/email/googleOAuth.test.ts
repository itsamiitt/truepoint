// googleOAuth.test.ts — the Google MailboxOAuthProvider, exercised through a FAKE OAuthHttpPort so the
// authorize URL, token exchange/refresh, refresh-token carry-forward, and invalid_grant→OAuthError mapping are
// all verified without a real Google round-trip or credentials (M12 P1).

import { describe, expect, it } from "bun:test";
import {
  GOOGLE_MAILBOX_SCOPES,
  type GoogleOAuthConfig,
  createGoogleOAuthProvider,
} from "./googleOAuth.ts";
import { OAuthError, type OAuthHttpPort } from "./oauthProvider.ts";

const config: GoogleOAuthConfig = {
  clientId: "client-123.apps.googleusercontent.com",
  clientSecret: "shh-secret",
  redirectUri: "https://api.truepoint.in/api/v1/email/mailboxes/connect/callback",
};

/** A fake port that records calls and returns scripted responses (postForm + getJson share `response` unless a
 *  dedicated `getResponse` is supplied for the identity/userinfo GET). */
function fakePort(
  response: { status: number; body: unknown },
  getResponse?: { status: number; body: unknown },
): {
  port: OAuthHttpPort;
  calls: Array<{ url: string; form: Record<string, string> }>;
  gets: Array<{ url: string; bearer: string }>;
} {
  const calls: Array<{ url: string; form: Record<string, string> }> = [];
  const gets: Array<{ url: string; bearer: string }> = [];
  return {
    calls,
    gets,
    port: {
      async postForm(url, form) {
        calls.push({ url, form });
        return response;
      },
      async getJson(url, bearer) {
        gets.push({ url, bearer });
        return getResponse ?? response;
      },
    },
  };
}

describe("authorizeUrl", () => {
  it("builds a Google consent URL with PKCE S256, offline access, and the connect scopes", () => {
    const provider = createGoogleOAuthProvider(config, fakePort({ status: 200, body: {} }).port);
    const url = new URL(
      provider.authorizeUrl({
        state: "state-tok",
        codeChallenge: "chal-xyz",
        loginHint: "u@acme.com",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(config.clientId);
    expect(q.get("redirect_uri")).toBe(config.redirectUri);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge")).toBe("chal-xyz");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBe("state-tok");
    expect(q.get("login_hint")).toBe("u@acme.com");
    expect(q.get("scope")).toBe(GOOGLE_MAILBOX_SCOPES.join(" "));
  });

  it("omits login_hint when not supplied", () => {
    const provider = createGoogleOAuthProvider(config, fakePort({ status: 200, body: {} }).port);
    const url = new URL(provider.authorizeUrl({ state: "s", codeChallenge: "c" }));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("POSTs the code+verifier and normalizes the token bundle", async () => {
    const { port, calls } = fakePort({
      status: 200,
      body: {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3599,
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
        token_type: "Bearer",
      },
    });
    const provider = createGoogleOAuthProvider(config, port);
    const bundle = await provider.exchangeCode("auth-code", "verifier-abc");

    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]!.form.grant_type).toBe("authorization_code");
    expect(calls[0]!.form.code).toBe("auth-code");
    expect(calls[0]!.form.code_verifier).toBe("verifier-abc");
    expect(calls[0]!.form.client_secret).toBe(config.clientSecret);

    expect(bundle.accessToken).toBe("at-1");
    expect(bundle.refreshToken).toBe("rt-1");
    expect(bundle.tokenType).toBe("Bearer");
    expect(bundle.scope).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(bundle.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("maps a 400 invalid_grant to OAuthError without leaking the body", async () => {
    const provider = createGoogleOAuthProvider(
      config,
      fakePort({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } })
        .port,
    );
    await expect(provider.exchangeCode("stale", "v")).rejects.toMatchObject({
      name: "OAuthError",
      code: "invalid_grant",
      status: 400,
    });
  });

  it("rejects a 200 response that is missing the access_token", async () => {
    const provider = createGoogleOAuthProvider(
      config,
      fakePort({ status: 200, body: { token_type: "Bearer" } }).port,
    );
    const err = await provider.exchangeCode("c", "v").catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_response");
  });
});

describe("refresh", () => {
  it("carries the existing refresh token forward when Google omits it", async () => {
    const { port, calls } = fakePort({
      status: 200,
      body: {
        access_token: "at-2",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    });
    const provider = createGoogleOAuthProvider(config, port);
    const bundle = await provider.refresh("rt-existing");

    expect(calls[0]!.form.grant_type).toBe("refresh_token");
    expect(calls[0]!.form.refresh_token).toBe("rt-existing");
    expect(bundle.accessToken).toBe("at-2");
    expect(bundle.refreshToken).toBe("rt-existing"); // carried forward
  });

  it("surfaces invalid_grant so the caller can mark reauth_required", async () => {
    const provider = createGoogleOAuthProvider(
      config,
      fakePort({ status: 400, body: { error: "invalid_grant" } }).port,
    );
    await expect(provider.refresh("revoked-rt")).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("fetchIdentity", () => {
  it("reads sub+email from userinfo with the access token as Bearer", async () => {
    const { port, gets } = fakePort(
      { status: 200, body: {} },
      { status: 200, body: { sub: "google-uid-9", email: "sdr@acme.com" } },
    );
    const provider = createGoogleOAuthProvider(config, port);
    const identity = await provider.fetchIdentity("at-live");
    expect(gets[0]!.url).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
    expect(gets[0]!.bearer).toBe("at-live");
    expect(identity).toEqual({ accountId: "google-uid-9", email: "sdr@acme.com" });
  });

  it("throws OAuthError when userinfo is incomplete or non-200", async () => {
    const provider = createGoogleOAuthProvider(
      config,
      fakePort({ status: 200, body: {} }, { status: 200, body: { sub: "x" } }).port,
    );
    await expect(provider.fetchIdentity("at")).rejects.toMatchObject({ code: "identity_failed" });
  });
});

describe("revoke", () => {
  it("POSTs the token to the revoke endpoint and never throws on a 400", async () => {
    const { port, calls } = fakePort({ status: 400, body: { error: "invalid_token" } });
    const provider = createGoogleOAuthProvider(config, port);
    await provider.revoke("some-token");
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(calls[0]!.form.token).toBe("some-token");
  });
});
