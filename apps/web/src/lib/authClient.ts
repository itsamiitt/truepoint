// authClient.ts — the app-domain token client (ADR-0016). The access token lives IN MEMORY only (never
// localStorage, never an app-domain cookie). It starts login via a PKCE redirect to the auth origin,
// exchanges the returned code, and silently refreshes against auth.*/token/refresh (same-site, credentialed
// fetch — the refresh cookie stays on the auth origin) shortly before expiry.

import { createPkcePair, randomState } from "./pkce";
import { APP_ORIGIN, AUTH_ORIGIN } from "./publicConfig";

let accessToken: string | null = null;
let expiresAtMs = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
// In-flight de-dup: the auth gate and the route's first data fetch both call silentRefresh on cold load.
// Without this they'd fire two redundant cross-origin /token/refresh calls (and the slower one could rotate
// the cookie out from under the faster one). A single shared promise collapses them into one network round-trip.
let refreshInFlight: Promise<boolean> | null = null;

const PKCE_VERIFIER_KEY = "lw_pkce_verifier";
const STATE_KEY = "lw_oauth_state";

/** One-shot flag the callback sets before auto-restarting login, so recovery happens AT MOST once. */
export const RECOVERY_KEY = "lw_auth_recovery";

export type RecoveryAction = "restart" | "retry" | "fail";

/**
 * Classify an exchange failure into a recovery action (pure, DOM-free):
 *   restart — the stale/expired/single-use class (a fresh login can succeed) → auto-start a new login;
 *   retry   — the auth origin is down → show "temporarily unavailable", do NOT auto-loop;
 *   fail    — anything else → generic message.
 */
export function recoveryActionFor(reason: string): RecoveryAction {
  if (reason === "invalid_state" || reason === "pkce_mismatch" || reason === "code_not_found")
    return "restart";
  if (reason === "auth_unavailable") return "retry";
  return "fail";
}

export function getAccessToken(): string | null {
  return accessToken && Date.now() < expiresAtMs ? accessToken : null;
}

function setToken(token: string, expiresIn: number): void {
  accessToken = token;
  expiresAtMs = Date.now() + expiresIn * 1000;
  if (refreshTimer) clearTimeout(refreshTimer);
  const leadMs = Math.max(5, expiresIn - 60) * 1000; // refresh ~60s before expiry
  refreshTimer = setTimeout(() => void silentRefresh(), leadMs);
}

/** Drop the in-memory token + cancel the pending refresh. The auth-origin cookie is cleared server-side.
 * Exported so the shell can discard a token the SERVER has rejected (a 401/403 on a protected read) and
 * re-gate to a fresh login — the client-side expiry check alone can't detect a server-side revocation. */
export function clearAccessToken(): void {
  accessToken = null;
  expiresAtMs = 0;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

/** Begin login: generate PKCE + state, stash the verifier, and redirect to the auth origin.
 * The auth app runs at basePath="/auth" so the login page is at /auth/login (not /login). */
export async function startLogin(): Promise<void> {
  const { verifier, challenge } = await createPkcePair();
  const state = randomState();
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({ app_origin: APP_ORIGIN, code_challenge: challenge, state });
  window.location.assign(`${AUTH_ORIGIN}/auth/login?${params.toString()}`);
}

/** Complete login at /auth/callback: validate state, exchange the code server-side at the auth origin. */
export async function completeLogin(code: string, returnedState: string): Promise<void> {
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  const state = sessionStorage.getItem(STATE_KEY);
  // Validate BEFORE consuming: a failed check leaves the single-use keys intact so a re-entrant
  // callback (StrictMode double-run) doesn't clobber a still-valid attempt.
  if (!verifier || !state || state !== returnedState) throw new Error("invalid_state");
  // Single-use: clear the verifier/state now that they've validated; the code is consumed by the exchange.
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  const res = await fetch(`${AUTH_ORIGIN}/auth/token/exchange`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, state }),
  });
  if (!res.ok) {
    // Surface the server's diagnostic so the callback can log/show the real cause instead of swallowing it.
    // For an invalid code the body carries a `reason` (ip_mismatch | origin_mismatch | pkce_mismatch |
    // code_not_found); for a server fault it carries `code: "auth_unavailable"`.
    const body = (await res.json().catch(() => null)) as { code?: string; reason?: string } | null;
    throw new Error(body?.reason ?? body?.code ?? "exchange_failed");
  }
  const data = (await res.json()) as { accessToken: string; expiresIn: number };
  setToken(data.accessToken, data.expiresIn);
}

/** Silent refresh against the auth origin (the refresh cookie rides the same-site credentialed fetch).
 * Concurrent callers share one in-flight request: the shell gate and the route's first data fetch both ask
 * for a refresh on cold load, and collapsing them avoids a duplicate cross-origin round-trip + cookie race. */
export async function silentRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${AUTH_ORIGIN}/auth/token/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; expiresIn: number };
      setToken(data.accessToken, data.expiresIn);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Fetch with the in-memory access token, attempting one silent refresh if it's missing/expired. */
export async function fetchWithAuth(input: string, init: RequestInit = {}): Promise<Response> {
  let token = getAccessToken();
  if (!token) {
    await silentRefresh();
    token = getAccessToken();
  }
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/**
 * End the session: revoke + clear the refresh cookie on the auth origin (idempotent 204), drop the
 * in-memory access token, then send the browser back to the app origin (the shell re-gates to sign-in).
 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_ORIGIN}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // Best-effort: logout must always feel complete to the user even if the network call fails.
  }
  clearAccessToken();
  window.location.assign(APP_ORIGIN);
}

/**
 * Re-pin the active workspace: the auth origin authorizes the target, rotates the session cookie, and
 * mints a fresh access JWT carrying the new wid. On success we store the new token (resetting the refresh
 * timer), announce workspace:changed, and reload so every per-workspace surface re-fetches under the new
 * scope. Throws on a non-200 (e.g. 403 no-access) so the caller can surface it and keep the current scope.
 */
export async function switchWorkspace(workspaceId: string): Promise<void> {
  const res = await fetch(`${AUTH_ORIGIN}/auth/workspace/switch`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) throw new Error("switch_failed");
  const data = (await res.json()) as { accessToken: string; expiresIn: number };
  setToken(data.accessToken, data.expiresIn);
  window.dispatchEvent(new CustomEvent("workspace:changed", { detail: { workspaceId } }));
  window.location.reload();
}

export interface OrgOption {
  tenantId: string;
  tenantName: string;
  isTenantOwner: boolean;
}

/**
 * The organizations the signed-in user belongs to (auth origin, credentialed — the org list is cross-tenant, so
 * it cannot come from api.* which is scoped to the active tenant). Returns the active tenant id so the switcher
 * can mark the current org. Throws on a non-200 so the caller can show an error state.
 */
export async function listOrgs(): Promise<{ orgs: OrgOption[]; activeTenantId: string | null }> {
  const res = await fetch(`${AUTH_ORIGIN}/auth/orgs`, { credentials: "include" });
  if (!res.ok) throw new Error("orgs_failed");
  return (await res.json()) as { orgs: OrgOption[]; activeTenantId: string | null };
}

/**
 * Re-pin the active ORGANIZATION (tenant): the auth origin authorizes the target org, lands the session on that
 * org's remembered/default workspace, rotates the session cookie, and mints a fresh access JWT carrying the new
 * tid/wid. On success we store the new token, announce org:changed, and reload so every scoped surface
 * re-fetches under the new org. Throws on a non-200 (e.g. 403 not-a-member) so the caller keeps the current org.
 */
export async function switchOrg(tenantId: string): Promise<void> {
  const res = await fetch(`${AUTH_ORIGIN}/auth/org/switch`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId }),
  });
  if (!res.ok) throw new Error("switch_failed");
  const data = (await res.json()) as { accessToken: string; expiresIn: number };
  setToken(data.accessToken, data.expiresIn);
  window.dispatchEvent(new CustomEvent("org:changed", { detail: { tenantId } }));
  window.location.reload();
}
