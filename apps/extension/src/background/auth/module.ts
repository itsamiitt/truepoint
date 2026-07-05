// AuthModule — PKCE against auth.truepoint.in via chrome.identity.launchWebAuthFlow (03 §1.2, ADR-0016).
// The access token lives in memory ONLY (never chrome.storage / disk); a same-site refresh cookie on the
// auth origin mints new tokens silently. Tenancy is read from verified token claims — never sent in a body.
import { ENV } from "../../shared/env.ts";
import type { AuthState } from "../../shared/messages.ts";
import { clearSession, getSession, setSession } from "../../shared/storage.ts";

interface Claims {
  sub: string;
  tid: string;
  wid: string | null;
  account: string | null;
  exp: number;
}

const REFRESH_SKEW_MS = 60_000;

export class AuthModule {
  private accessToken: string | null = null;
  private claims: Claims | null = null;
  private expiresAt = 0;

  /** On worker wake, attempt a silent refresh if a prior session marker exists. */
  async init(): Promise<void> {
    if (await getSession<boolean>("logged_in")) {
      await this.refresh();
    }
  }

  getState(): AuthState {
    if (!this.claims) {
      return { status: "signed_out", account: null, workspaceId: null, credits: null };
    }
    return {
      status: "signed_in",
      account: this.claims.account,
      workspaceId: this.claims.wid,
      credits: null,
    };
  }

  get tenantId(): string | null {
    return this.claims?.tid ?? null;
  }

  get workspaceId(): string | null {
    return this.claims?.wid ?? null;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.expiresAt - REFRESH_SKEW_MS) {
      return this.accessToken;
    }
    return this.refresh();
  }

  async login(): Promise<AuthState> {
    const { verifier, challenge } = await createPkcePair();
    const redirectUri = chrome.identity.getRedirectURL("auth");
    const state = randomString(16);
    await setSession("pkce_verifier", verifier);
    await setSession("pkce_state", state);

    const authUrl =
      `${ENV.authOrigin}/auth/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(ENV.oauthClientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256` +
      `&state=${state}&scope=openid`;

    const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    if (!redirect) {
      throw new Error("auth_cancelled");
    }
    const params = new URL(redirect).searchParams;
    const returnedState = params.get("state");
    const code = params.get("code");
    if (!code || returnedState !== state) {
      throw new Error("auth_state_mismatch");
    }

    const res = await fetch(`${ENV.authOrigin}/auth/token/exchange`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
    });
    if (!res.ok) {
      throw new Error("auth_exchange_failed");
    }
    const { access_token: token } = (await res.json()) as { access_token: string };
    this.setToken(token);
    await setSession("logged_in", true);
    await clearSession("pkce_verifier");
    await clearSession("pkce_state");
    return this.getState();
  }

  async logout(): Promise<AuthState> {
    try {
      await fetch(`${ENV.authOrigin}/auth/token/revoke`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // best-effort
    }
    this.clear();
    await clearSession("logged_in");
    return this.getState();
  }

  private async refresh(): Promise<string | null> {
    try {
      const res = await fetch(`${ENV.authOrigin}/auth/token/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        this.clear();
        return null;
      }
      const { access_token: token } = (await res.json()) as { access_token: string };
      this.setToken(token);
      return this.accessToken;
    } catch {
      this.clear();
      return null;
    }
  }

  private setToken(token: string): void {
    this.accessToken = token;
    this.claims = decodeClaims(token);
    this.expiresAt = (this.claims?.exp ?? 0) * 1000;
  }

  private clear(): void {
    this.accessToken = null;
    this.claims = null;
    this.expiresAt = 0;
  }
}

// ---- PKCE + JWT helpers (crypto.subtle is available in the MV3 service worker) ----

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function decodeClaims(token: string): Claims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return null;
    }
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(json) as Record<string, unknown>;
    return {
      sub: String(data.sub ?? ""),
      tid: String(data.tid ?? ""),
      wid: data.wid ? String(data.wid) : null,
      account: data.account ? String(data.account) : data.email ? String(data.email) : null,
      exp: Number(data.exp ?? 0),
    };
  } catch {
    return null;
  }
}
