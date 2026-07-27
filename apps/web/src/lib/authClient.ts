// authClient.ts — the app-domain token client (ADR-0016). A thin instantiation of @leadwolf/auth-client plus
// the multi-org / multi-workspace switching that only the customer app has.
//
// The access token lives IN MEMORY only (never localStorage, never an app-domain cookie). Login is a PKCE
// redirect to the auth origin; the session silently refreshes against auth.*/token/refresh (same-site
// credentialed fetch — the refresh cookie stays on the auth origin) shortly before expiry.
//
// This was a ~280-line file duplicated (with drift) into apps/admin and apps/forge. The shared 90% now lives
// in @leadwolf/auth-client, so a fix lands in all three at once; what stays here is genuinely web-only
// (T-2.3).
import { createAuthClient } from "@leadwolf/auth-client";
import { APP_ORIGIN, AUTH_ORIGIN } from "./publicConfig";

const client = createAuthClient({
  appOrigin: APP_ORIGIN,
  authOrigin: AUTH_ORIGIN,
  storagePrefix: "lw_",
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

// ── Web-only: org + workspace switching ────────────────────────────────────────────────────────────────
// These are not in the shared client because admin and forge have no org/workspace switcher — the staff
// consoles are cross-tenant by construction. Each mints a FRESH access JWT carrying the new tid/wid, which is
// why they need installToken rather than going through the normal exchange.

/**
 * Re-pin the active workspace: the auth origin authorizes the target, rotates the session cookie, and mints a
 * fresh access JWT carrying the new wid. On success we store the new token (resetting the refresh timer),
 * announce workspace:changed, and reload so every per-workspace surface re-fetches under the new scope.
 * Throws on a non-200 (e.g. 403 no-access) so the caller can surface it and keep the current scope.
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
  client.installToken(data.accessToken, data.expiresIn);
  window.dispatchEvent(new CustomEvent("workspace:changed", { detail: { workspaceId } }));
  window.location.reload();
}

export interface OrgOption {
  tenantId: string;
  tenantName: string;
  isTenantOwner: boolean;
}

/**
 * The organizations the signed-in user belongs to (auth origin, credentialed — the org list is cross-tenant,
 * so it cannot come from api.* which is scoped to the active tenant). Returns the active tenant id so the
 * switcher can mark the current org. Throws on a non-200 so the caller can show an error state.
 */
export async function listOrgs(): Promise<{ orgs: OrgOption[]; activeTenantId: string | null }> {
  const res = await fetch(`${AUTH_ORIGIN}/auth/orgs`, { credentials: "include" });
  if (!res.ok) throw new Error("orgs_failed");
  return (await res.json()) as { orgs: OrgOption[]; activeTenantId: string | null };
}

/**
 * Re-pin the active ORGANIZATION (tenant): the auth origin authorizes the target org, lands the session on
 * that org's remembered/default workspace, rotates the session cookie, and mints a fresh access JWT carrying
 * the new tid/wid. On success we store the new token, announce org:changed, and reload so every scoped
 * surface re-fetches under the new org. Throws on a non-200 (e.g. 403 not-a-member) so the caller keeps the
 * current org.
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
  client.installToken(data.accessToken, data.expiresIn);
  window.dispatchEvent(new CustomEvent("org:changed", { detail: { tenantId } }));
  window.location.reload();
}
