// authClient.ts — the staff-console token client (ADR-0016). Mirrors apps/web: the access token lives IN
// MEMORY only (never localStorage, never a cookie). It starts login via a PKCE redirect to the auth origin,
// exchanges the returned code, and silently refreshes against auth.*/token/refresh (same-site credentialed
// fetch — the refresh cookie stays on the auth origin) shortly before expiry. The platform-admin gate
// (adminGate.ts) is layered on top: a valid token is necessary but NOT sufficient — the api `/admin/*` surface
// re-checks the signed `pa` claim and 403s a non-staff caller (ADR-0034).

import { createPkcePair, randomState } from "./pkce";
import { APP_ORIGIN, AUTH_ORIGIN } from "./publicConfig";

let accessToken: string | null = null;
let expiresAtMs = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const PKCE_VERIFIER_KEY = "lw_admin_pkce_verifier";
const STATE_KEY = "lw_admin_oauth_state";

/** One-shot flag the callback sets before auto-restarting login, so recovery happens AT MOST once. */
export const RECOVERY_KEY = "lw_admin_auth_recovery";

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

/** Drop the in-memory token + cancel the pending refresh. The auth-origin cookie is cleared server-side. */
function clearToken(): void {
  accessToken = null;
  expiresAtMs = 0;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

/** Begin login: generate PKCE + state, stash the verifier, and redirect to the auth origin. */
export async function startLogin(): Promise<void> {
  const { verifier, challenge } = await createPkcePair();
  const state = randomState();
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({ app_origin: APP_ORIGIN, code_challenge: challenge, state });
  window.location.assign(`${AUTH_ORIGIN}/auth/login?${params.toString()}`);
}

/** Complete login at /callback: validate state, exchange the code server-side at the auth origin. */
export async function completeLogin(code: string, returnedState: string): Promise<void> {
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  const state = sessionStorage.getItem(STATE_KEY);
  // Validate BEFORE consuming so a re-entrant callback (StrictMode double-run) cannot clobber a valid attempt.
  if (!verifier || !state || state !== returnedState) throw new Error("invalid_state");
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  const res = await fetch(`${AUTH_ORIGIN}/auth/token/exchange`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, state }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string; reason?: string } | null;
    throw new Error(body?.reason ?? body?.code ?? "exchange_failed");
  }
  const data = (await res.json()) as { accessToken: string; expiresIn: number };
  setToken(data.accessToken, data.expiresIn);
}

/** Silent refresh against the auth origin (the refresh cookie rides the same-site credentialed fetch). */
export async function silentRefresh(): Promise<boolean> {
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
  }
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
 * End the staff session: revoke + clear the refresh cookie on the auth origin (idempotent), drop the
 * in-memory access token, then send the browser back to the console origin (the shell re-gates to sign-in).
 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_ORIGIN}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // Best-effort: logout must always feel complete even if the network call fails.
  }
  clearToken();
  window.location.assign(APP_ORIGIN);
}
