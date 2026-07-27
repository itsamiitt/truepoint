// authClient.ts — the Forge operator console token client (ADR-0016). A thin instantiation of @leadwolf/auth-client:
// the access token lives IN MEMORY only (never localStorage, never a cookie), login is a PKCE redirect to the
// auth origin, and the session silently refreshes against auth.*/token/refresh shortly before expiry.
//
// The Forge staff gate (forgeGate.ts) is layered on top: a valid token is necessary but NOT sufficient — the
// forge-api re-checks staff capabilities server-side and 403s a caller without them.
//
// This file used to be a ~140-line copy of the web and forge clients. The copies had drifted: web gained an
// in-flight refresh de-dup and the cross-tab refresh election, and this one had neither — so every open staff
// tab fired its own token rotation. Sharing the implementation means those fixes apply here too, and the next
// one lands in all three at once (T-2.3).
import { createAuthClient } from "@leadwolf/auth-client";
import { APP_ORIGIN, AUTH_ORIGIN } from "./publicConfig";

// The storage prefix is what keeps a staff tab and a customer tab from clobbering each other's PKCE verifier
// mid-login when both are open in one browser.
const client = createAuthClient({
  appOrigin: APP_ORIGIN,
  authOrigin: AUTH_ORIGIN,
  storagePrefix: "lw_forge_",
});

export type { RecoveryAction } from "@leadwolf/auth-client";
export { recoveryActionFor } from "@leadwolf/auth-client";

/** One-shot flag the callback sets before auto-restarting login, so recovery happens AT MOST once. */
export const RECOVERY_KEY = client.RECOVERY_KEY;

export const getAccessToken = client.getAccessToken;
export const clearAccessToken = client.clearAccessToken;
export const startLogin = client.startLogin;
export const completeLogin = client.completeLogin;
export const silentRefresh = client.silentRefresh;
export const fetchWithAuth = client.fetchWithAuth;
export const logout = client.logout;
