// oauthProvider.ts — the provider-agnostic OAuth seam for connecting a sending/receiving mailbox (M12 P1, D1).
// A MailboxOAuthProvider builds the consent URL, exchanges the auth code (PKCE), refreshes, and revokes. Every
// network call goes through an injectable OAuthHttpPort so the providers are UNIT-TESTABLE without a real
// Google/Microsoft round-trip and without live credentials. Concrete providers (googleOAuth now, microsoftOAuth
// in the follow-on) register here; the API connect flow resolves one by provider id. No token or client secret
// is ever logged or returned to the client — only the bundle the secretStore encrypts server-side (D7).

/** A normalized token bundle. `refreshToken` is present on the first offline exchange and usually ABSENT on a
 *  plain refresh (the caller carries the existing one forward). `expiresAt` is computed from `expires_in` at
 *  exchange time so the refresh worker can act on a clock, not by decrypting the access token. */
export interface OAuthTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string[];
  tokenType: string;
}

export interface AuthorizeParams {
  state: string;
  codeChallenge: string; // S256
  loginHint?: string;
}

/** The connected account's stable provider id + primary email — the mailbox address and the dedup key. */
export interface OAuthIdentity {
  accountId: string;
  email: string;
}

export interface MailboxOAuthProvider {
  readonly provider: "google" | "microsoft";
  /** Build the consent-screen URL the user is redirected to (PKCE challenge + CSRF state ride along). */
  authorizeUrl(params: AuthorizeParams): string;
  /** Exchange the one-time auth code for tokens (presenting the PKCE verifier). */
  exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokenBundle>;
  /** Trade a refresh token for a fresh access token (refresh token carried forward by the caller if omitted). */
  refresh(refreshToken: string): Promise<OAuthTokenBundle>;
  /** Resolve the connected account identity (stable id + email) — derived server-side, never client-asserted. */
  fetchIdentity(accessToken: string): Promise<OAuthIdentity>;
  /** Best-effort revoke at disconnect — failures are swallowed by the caller (the local row is removed anyway). */
  revoke(token: string): Promise<void>;
}

/** A token-endpoint failure. `code` is the OAuth2 `error` field (e.g. 'invalid_grant') the caller maps to the
 *  "Reconnect" UX. NEVER carries the token, the client secret, or the raw response body. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/** The injectable HTTP seam — a form-encoded POST (token endpoints) and a Bearer GET (identity/userinfo),
 *  each returning the parsed JSON body + status. Tests substitute a fake; production uses fetchHttpPort. */
export interface OAuthHttpPort {
  postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: unknown }>;
  getJson(url: string, bearer: string): Promise<{ status: number; body: unknown }>;
}

/** Default port: form-POST / Bearer-GET via fetch, tolerant of a non-JSON body. */
export const fetchHttpPort: OAuthHttpPort = {
  async postForm(url, form) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  },
  async getJson(url, bearer) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  },
};

const registry = new Map<string, MailboxOAuthProvider>();

/** Register a concrete provider (called once at startup after reading config). */
export function registerOAuthProvider(p: MailboxOAuthProvider): void {
  registry.set(p.provider, p);
}

/** Resolve a registered provider by id, or null when the provider is not configured (connect fails closed). */
export function resolveOAuthProvider(provider: string): MailboxOAuthProvider | null {
  return registry.get(provider) ?? null;
}

/** Clear the registry — test hygiene only. */
export function resetOAuthProviders(): void {
  registry.clear();
}
