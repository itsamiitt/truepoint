// pkceFlow — PKCE S256 + the launchWebAuthFlow round-trip against auth.truepoint.in (doc 10 §2.2).
// The login URL mirrors the web client's real params (app_origin/code_challenge/state — apps/web/src/lib/
// authClient.ts); `prompt=none` requests the SILENT re-auth path (NET-NEW server support, doc 10 §7).
import { ENV } from "../../shared/env.ts";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** The extension's own origin — bound to the auth code and sent as the exchange `Origin` (must be a
 *  registered `APP_ORIGINS` value server-side, doc 10 §7). e.g. "chrome-extension://<id>". */
export function extensionOrigin(): string {
  return chrome.runtime.getURL("").replace(/\/$/, "");
}

/** The launchWebAuthFlow redirect target, e.g. "https://<id>.chromiumapp.org/auth". */
export function redirectUri(): string {
  return chrome.identity.getRedirectURL("auth");
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

export function randomState(): string {
  return randomToken(16);
}

export function buildLoginUrl(opts: {
  challenge: string;
  state: string;
  prompt: "login" | "none";
  workspaceId?: string;
  tenantId?: string;
}): string {
  const params = new URLSearchParams({
    app_origin: extensionOrigin(),
    redirect_uri: redirectUri(),
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    state: opts.state,
    prompt: opts.prompt,
    scope: "openid",
  });
  if (opts.workspaceId) {
    params.set("workspace_id", opts.workspaceId);
  }
  if (opts.tenantId) {
    params.set("tenant_id", opts.tenantId);
  }
  return `${ENV.authOrigin}/auth/login?${params.toString()}`;
}

/** Run the flow; returns the final redirect URL, or undefined if it did not complete (e.g. a silent
 *  attempt that needed interaction, or the user cancelled an interactive one). */
export async function runAuthFlow(url: string, interactive: boolean): Promise<string | undefined> {
  return chrome.identity.launchWebAuthFlow({ url, interactive });
}

/** Pull the code from the redirect and verify the CSRF `state` round-trip. */
export function extractCode(redirectUrl: string, expectedState: string): { code: string } {
  const params = new URL(redirectUrl).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code) {
    throw new Error("auth_no_code");
  }
  if (state !== expectedState) {
    throw new Error("auth_state_mismatch");
  }
  return { code };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
