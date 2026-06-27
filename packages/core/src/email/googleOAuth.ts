// googleOAuth.ts — the Google (Gmail) MailboxOAuthProvider (M12 P1, D1). Authorization-code + PKCE; scopes
// gmail.send + gmail.readonly + openid email — enough to SEND as the tenant's own identity and SYNC inbound for
// reply detection, with NO mailbox-write scope (the lighter, agreed posture: gmail.send is "sensitive" and
// gmail.readonly is "restricted"/CASA, but we avoid gmail.modify). access_type=offline + prompt=consent so
// Google returns a durable refresh token even on re-consent. Token exchange/refresh/revoke flow through the
// injected OAuthHttpPort (testable). Client id/secret come from config and stay SERVER-SIDE. An invalid_grant
// on refresh surfaces as OAuthError('invalid_grant') so the caller marks the mailbox reauth_required (the
// "Reconnect" UX) instead of silently dropping sends.

import {
  type AuthorizeParams,
  type MailboxOAuthProvider,
  OAuthError,
  type OAuthHttpPort,
  type OAuthTokenBundle,
  fetchHttpPort,
} from "./oauthProvider.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/** The connect scopes — send + read-only inbound + identity. Exported so the connect flow can record the
 *  requested set on oauth_connect_state and detect a post-consent downgrade against the granted scopes. */
export const GOOGLE_MAILBOX_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Shape we read from Google's token endpoint (only the fields we use). */
interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Parse + validate a token-endpoint response into a normalized bundle. On a non-200 (or an `error` field) throw
 *  an OAuthError carrying ONLY the error code/description — never the request secrets. `carryRefresh` is the
 *  existing refresh token to keep when a refresh response omits one (Google's usual behaviour). */
function toBundle(
  status: number,
  raw: unknown,
  carryRefresh: string | undefined,
): OAuthTokenBundle {
  const body = (raw ?? {}) as GoogleTokenResponse;
  if (status !== 200 || body.error) {
    throw new OAuthError(
      body.error ?? "oauth_error",
      body.error_description ?? `Google token endpoint returned ${status}`,
      status,
    );
  }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new OAuthError("invalid_response", "Google token response missing access_token", status);
  }
  const expiresInSec = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? carryRefresh,
    expiresAt: new Date(Date.now() + expiresInSec * 1000),
    scope: (body.scope ?? "").split(" ").filter(Boolean),
    tokenType: body.token_type ?? "Bearer",
  };
}

/** Build the Google provider. `http` is injectable so the exchange/refresh/revoke are unit-testable. */
export function createGoogleOAuthProvider(
  config: GoogleOAuthConfig,
  http: OAuthHttpPort = fetchHttpPort,
): MailboxOAuthProvider {
  return {
    provider: "google",

    authorizeUrl({ state, codeChallenge, loginHint }: AuthorizeParams): string {
      const q = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: GOOGLE_MAILBOX_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      if (loginHint) q.set("login_hint", loginHint);
      return `${AUTH_ENDPOINT}?${q.toString()}`;
    },

    async exchangeCode(code, codeVerifier) {
      const { status, body } = await http.postForm(TOKEN_ENDPOINT, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
      });
      return toBundle(status, body, undefined);
    },

    async refresh(refreshToken) {
      const { status, body } = await http.postForm(TOKEN_ENDPOINT, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      // Google omits refresh_token on a plain refresh — carry the existing one forward.
      return toBundle(status, body, refreshToken);
    },

    async fetchIdentity(accessToken) {
      const { status, body } = await http.getJson(USERINFO_ENDPOINT, accessToken);
      const info = (body ?? {}) as { sub?: string; email?: string };
      if (status !== 200 || !info.sub || !info.email) {
        throw new OAuthError("identity_failed", `Google userinfo returned ${status}`, status);
      }
      return { accountId: info.sub, email: info.email };
    },

    async revoke(token) {
      // Best-effort; Google returns 200 on success and 400 for an already-invalid token. We don't throw — the
      // caller is disconnecting and removes the local row regardless.
      await http.postForm(REVOKE_ENDPOINT, { token });
    },
  };
}
