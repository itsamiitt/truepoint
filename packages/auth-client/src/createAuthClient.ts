// createAuthClient.ts — ONE token client for apps/web, apps/admin and apps/forge (T-2.3, ADR-0016).
//
// This existed three times. The copies were ~90% identical and had drifted in the way copies always do —
// not by diverging on purpose, but by one of them getting fixed. `apps/web` had an in-flight de-dup for
// concurrent refreshes and the cross-tab refresh election (T-2.6); admin and forge had neither, so every
// staff tab still fired its own rotation chain. The drift was never a decision, and nobody could see it
// without diffing three files.
//
// What genuinely differs between the apps is parametric and small: the origin the app lives on, and the
// sessionStorage key prefix (so a web tab and an admin tab do not clobber each other's PKCE state mid-login).
// Everything else — PKCE redirect, code exchange, silent refresh, authenticated fetch, logout — is one
// implementation now, and a fix lands in all three at once.
//
// The access token stays IN MEMORY only: never localStorage, never an app-domain cookie (ADR-0016). The
// refresh cookie lives on the auth origin and rides same-site credentialed fetches, so it is never readable
// by app-origin script.

import { createPkcePair, randomState } from "./pkce.ts";
import {
  type ElectionChannel,
  type ElectionDeps,
  LOCK_TTL_MS,
  broadcastRefreshResult,
  parseRefreshMessage,
  releaseRefreshLock,
  tryAcquireRefreshLock,
} from "./refreshElection.ts";

export interface AuthClientConfig {
  /** This app's own origin — where login returns to, and where logout lands. */
  appOrigin: string;
  /** The auth origin (auth.*). Owns the refresh cookie and every token endpoint. */
  authOrigin: string;
  /** Namespaces this app's sessionStorage keys. Two apps open in one browser each run their own PKCE
   *  handshake; a shared prefix would let one overwrite the other's verifier and break the callback. */
  storagePrefix: string;
}

export type RecoveryAction = "restart" | "retry" | "fail";

export interface AuthClient {
  /** One-shot flag the callback sets before auto-restarting login, so recovery happens AT MOST once. */
  readonly RECOVERY_KEY: string;
  recoveryActionFor(reason: string): RecoveryAction;
  getAccessToken(): string | null;
  clearAccessToken(): void;
  startLogin(): Promise<void>;
  completeLogin(code: string, returnedState: string): Promise<void>;
  silentRefresh(): Promise<boolean>;
  fetchWithAuth(input: string, init?: RequestInit): Promise<Response>;
  logout(): Promise<void>;
  /** Install a token minted OUTSIDE the standard exchange/refresh — the org and workspace switches mint a
   *  fresh JWT carrying the new tid/wid. Resets the refresh timer, like any other token install. */
  installToken(token: string, expiresIn: number): void;
}

/**
 * Classify an exchange failure into a recovery action (pure, DOM-free):
 *   restart — the stale/expired/single-use class (a fresh login can succeed) → auto-start a new login;
 *   retry   — the auth origin is down → show "temporarily unavailable", do NOT auto-loop;
 *   fail    — anything else → generic message.
 */
export function recoveryActionFor(reason: string): RecoveryAction {
  if (reason === "invalid_state" || reason === "pkce_mismatch" || reason === "code_not_found") {
    return "restart";
  }
  if (reason === "auth_unavailable") return "retry";
  return "fail";
}

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const { appOrigin, authOrigin, storagePrefix } = config;

  const PKCE_VERIFIER_KEY = `${storagePrefix}pkce_verifier`;
  const STATE_KEY = `${storagePrefix}oauth_state`;
  const RECOVERY_KEY = `${storagePrefix}auth_recovery`;

  let accessToken: string | null = null;
  let expiresAtMs = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // In-flight de-dup: the auth gate and the route's first data fetch both call silentRefresh on cold load.
  // Without this they fire two redundant cross-origin /token/refresh calls, and the slower one can rotate the
  // cookie out from under the faster one. A single shared promise collapses them into one round-trip.
  // (apps/web had this; admin and forge did not — the exact drift this extraction removes.)
  let refreshInFlight: Promise<boolean> | null = null;

  // ── cross-tab refresh election (T-2.6) ───────────────────────────────────────────────────────────────
  const TAB_ID =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Math.random()}`;
  let electionChannel: ElectionChannel | undefined;

  function electionDeps(): ElectionDeps | null {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
    if (!electionChannel && typeof BroadcastChannel !== "undefined") {
      // Channel name is per-app: an admin tab must not adopt a token minted for the web origin, since the
      // audiences differ and the api would reject it.
      const channel = new BroadcastChannel(`${storagePrefix}auth`);
      channel.onmessage = (event: MessageEvent) => {
        const result = parseRefreshMessage(event.data);
        if (result) adoptToken(result.token, result.expiresIn);
      };
      electionChannel = channel;
    }
    return {
      storage: localStorage,
      channel: electionChannel,
      now: () => Date.now(),
      tabId: TAB_ID,
    };
  }

  /** Install a token WITHOUT re-broadcasting — the follower path. Re-broadcasting would loop the tabs. */
  function adoptToken(token: string, expiresIn: number): void {
    accessToken = token;
    expiresAtMs = Date.now() + expiresIn * 1000;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void scheduledRefresh(), Math.max(5, expiresIn - 60) * 1000);
  }

  /**
   * The TIMER-driven refresh, elected across tabs. Each tab used to arm its own ~14 min timer, so N tabs
   * fired N rotation chains — each a DB revoke + insert plus a Redis write, with losers presenting a token
   * the winner had just replaced, surviving only on the 30s reuse-grace.
   *
   * A losing tab does nothing, which is safe: if it never receives the broadcast its token simply expires and
   * the ON-DEMAND path in fetchWithAuth refreshes it — exactly the old behaviour, so the worst case is
   * unchanged while the common case is one rotation per browser.
   */
  async function scheduledRefresh(): Promise<void> {
    const deps = electionDeps();
    if (!deps) {
      await silentRefresh(); // no browser storage (SSR): behave as before
      return;
    }
    if (!tryAcquireRefreshLock(deps)) {
      // Another tab is refreshing. Losing the election used to mean this tab simply stopped: its timer had
      // already fired and nothing re-armed one, so if the winner's broadcast never arrived — the winner's
      // refresh failed, its tab was closed mid-flight, or the BroadcastChannel message was missed — this tab
      // sat with no timer at all until some component happened to fetch. Re-arm a short retry instead. It
      // costs nothing in the common case (the broadcast lands first, adoptToken replaces this timer with the
      // full-length one) and it means a lost broadcast degrades to a slightly late refresh rather than to
      // waiting on the next user action.
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void scheduledRefresh(), LOCK_TTL_MS);
      return;
    }
    try {
      const ok = await silentRefresh();
      const token = ok ? getAccessToken() : null;
      if (token) {
        broadcastRefreshResult(deps, {
          token,
          expiresIn: Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000)),
        });
        return;
      }
      // WON the election and the refresh still failed. The likeliest cause is the race this whole mechanism
      // cannot fully prevent: the election is localStorage-backed and therefore per-ORIGIN, while the refresh
      // cookie is host-scoped to the auth origin and shared by app./admin./forge — so winning here only means
      // winning among THIS app's tabs, and another app may have rotated the cookie a moment ago. That failure
      // is transient by construction: the browser now holds the winner's rotated value, so the next attempt
      // sends it and succeeds. Without a re-arm this tab had no timer at all and coasted on a token with ~60s
      // left, relying on some component happening to fetch before it expired.
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void scheduledRefresh(), LOCK_TTL_MS);
    } finally {
      releaseRefreshLock(deps);
    }
  }

  function setToken(token: string, expiresIn: number): void {
    accessToken = token;
    expiresAtMs = Date.now() + expiresIn * 1000;
    if (refreshTimer) clearTimeout(refreshTimer);
    const leadMs = Math.max(5, expiresIn - 60) * 1000; // refresh ~60s before expiry
    refreshTimer = setTimeout(() => void scheduledRefresh(), leadMs);
  }

  function getAccessToken(): string | null {
    return accessToken && Date.now() < expiresAtMs ? accessToken : null;
  }

  async function silentRefresh(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${authOrigin}/auth/token/refresh`, {
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

  return {
    RECOVERY_KEY,
    recoveryActionFor,
    getAccessToken,
    installToken: setToken,
    silentRefresh,

    /** Drop the in-memory token + cancel the pending refresh. The auth-origin cookie is cleared server-side.
     *  Exported so a shell can discard a token the SERVER has rejected (a 401/403 on a protected read) — the
     *  client-side expiry check alone cannot detect a server-side revocation. */
    clearAccessToken(): void {
      accessToken = null;
      expiresAtMs = 0;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
    },

    /** Begin login: generate PKCE + state, stash the verifier, redirect to the auth origin. The auth app runs
     *  at basePath="/auth", so the login page is at /auth/login. */
    async startLogin(): Promise<void> {
      const { verifier, challenge } = await createPkcePair();
      const state = randomState();
      sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
      sessionStorage.setItem(STATE_KEY, state);
      const params = new URLSearchParams({
        app_origin: appOrigin,
        code_challenge: challenge,
        state,
      });
      window.location.assign(`${authOrigin}/auth/login?${params.toString()}`);
    },

    /** Complete login at /auth/callback: validate state, exchange the code server-side at the auth origin. */
    async completeLogin(code: string, returnedState: string): Promise<void> {
      const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
      const state = sessionStorage.getItem(STATE_KEY);
      // Validate BEFORE consuming: a failed check leaves the single-use keys intact so a re-entrant callback
      // (StrictMode double-run) does not clobber a still-valid attempt.
      if (!verifier || !state || state !== returnedState) throw new Error("invalid_state");
      sessionStorage.removeItem(PKCE_VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);

      const res = await fetch(`${authOrigin}/auth/token/exchange`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, codeVerifier: verifier, state }),
      });
      if (!res.ok) {
        // Surface the server's diagnostic instead of swallowing it. An invalid code carries a `reason`
        // (ip_mismatch | origin_mismatch | pkce_mismatch | code_not_found); a server fault carries
        // `code: "auth_unavailable"`.
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          reason?: string;
        } | null;
        throw new Error(body?.reason ?? body?.code ?? "exchange_failed");
      }
      const data = (await res.json()) as { accessToken: string; expiresIn: number };
      setToken(data.accessToken, data.expiresIn);
    },

    /**
     * Fetch with the in-memory access token, attempting one silent refresh if it is missing/expired, and ONE
     * refresh-and-retry if the server answers 401 anyway.
     *
     * The retry is the part that was missing, and its absence was load-bearing. The client-side expiry check
     * only knows what THIS tab believes; the server can reject a token the tab still considers fresh — the two
     * routine causes being a rotation performed by another tab or another app (the refresh cookie is shared
     * across app./admin./forge while the rotation election is per-origin) and clock skew against the ≤30s
     * tolerance in verifyAccessToken. Without a retry that 401 flowed straight out to AppShell, which reads a
     * 401 on the session probe as a revocation and re-gates to login — so an ordinary race presented to the
     * user as being signed out.
     *
     * Bounded to a single retry ON PURPOSE: if a fresh token is ALSO rejected the session really is gone, and
     * looping would turn one dead session into a request storm against an auth origin that may already be the
     * thing struggling. `silentRefresh` de-dups in flight, so N concurrent 401s share one rotation. A request
     * with no body-less/idempotent guarantee is safe here because the first attempt provably did not succeed —
     * a 401 is rejected at authn, before any handler runs.
     */
    async fetchWithAuth(input: string, init: RequestInit = {}): Promise<Response> {
      let token = getAccessToken();
      if (!token) {
        await silentRefresh();
        token = getAccessToken();
      }
      const send = (bearer: string | null): Promise<Response> => {
        const headers = new Headers(init.headers);
        if (bearer) headers.set("authorization", `Bearer ${bearer}`);
        return fetch(input, { ...init, headers });
      };

      const res = await send(token);
      if (res.status !== 401 || !token) return res;
      // A stream body is consumed by the first attempt and cannot be replayed; hand back the 401 rather than
      // re-sending a request whose body is now empty. Every other body type (string, FormData, URLSearchParams,
      // Blob, ArrayBuffer) re-reads cleanly, and the overwhelming majority of callers send a JSON string.
      if (init.body instanceof ReadableStream) return res;

      // The server rejected a token we believed was live. Rotate once and replay.
      if (!(await silentRefresh())) return res;
      const refreshed = getAccessToken();
      if (!refreshed || refreshed === token) return res;
      return send(refreshed);
    },

    /** End the session: revoke + clear the refresh cookie on the auth origin (idempotent 204), drop the
     *  in-memory token, then send the browser back to the app origin (the shell re-gates to sign-in). */
    async logout(): Promise<void> {
      try {
        await fetch(`${authOrigin}/auth/logout`, { method: "POST", credentials: "include" });
      } catch {
        // Best-effort: logout must feel complete to the user even if the network call fails.
      }
      accessToken = null;
      expiresAtMs = 0;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      window.location.assign(appOrigin);
    },
  };
}
