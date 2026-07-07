// refreshToken — the SW-held rotating refresh token + body-based refresh (doc 12 §6.2, ADR-0045).
//
// SECURITY NOTE (improves on the doc's "encrypted in storage.local"): we keep the refresh token in
// chrome.storage.session, which is MEMORY-BACKED — it survives service-worker death (the real MV3
// problem) but is CLEARED ON BROWSER CLOSE and is NOT readable by content scripts (TRUSTED_CONTEXTS
// only). So no long-lived bearer secret is written to disk and there is no key to manage; on browser
// restart the user re-establishes via the companion window (instant if the web session is still alive).
import { EXT_TOKEN_BASE } from "../../shared/env.ts";
import { clearSession, getSession, setSession } from "../../shared/storage.ts";
import { AuthError } from "./errors.ts";

const KEY = "ext_refresh";

export interface RefreshResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export async function loadRefreshToken(): Promise<string | null> {
  return (await getSession<string>(KEY)) ?? null;
}

export async function saveRefreshToken(token: string): Promise<void> {
  await setSession(KEY, token);
}

export async function clearRefreshToken(): Promise<void> {
  await clearSession(KEY);
}

/** Exchange the rotating refresh token for a fresh access token (+ a rotated refresh token). An optional
 *  scope re-mints with a new workspace/org (doc 12 §6; server re-scope is NET-NEW). */
export async function refreshTokens(
  refreshToken: string,
  scope?: { workspaceId?: string; tenantId?: string },
): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(`${EXT_TOKEN_BASE}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken, ...scope }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AuthError(0, "network_error");
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string };
    throw new AuthError(res.status, problem.code ?? "refresh_failed");
  }
  return (await res.json()) as RefreshResult;
}
