// ssoApi.ts — the Tenant ▸ Single sign-on backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the
// tenant SSO config routes. A 403 (not security_admin/owner) → { forbidden: true } so the panel shows a quiet
// access message; a 404/501 ("not built yet") → null / ok:false so the panel degrades gracefully. The OIDC
// client secret is write-only — the GET view carries only `hasClientSecret`, never the secret itself.
//
//   GET /settings/security/sso → the masked SSO config (security_admin|owner; 403 otherwise; null when unset)
//   PUT /settings/security/sso → upsert the config → the re-read masked view

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { SsoConfigUpdate, SsoConfigView } from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

/** Load the org SSO config. 403 → { forbidden: true }; not-built → { config: null }; unset → { config: null }. */
export async function fetchSsoConfig(): Promise<{
  config: SsoConfigView | null;
  forbidden: boolean;
}> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/security/sso`);
  if (res.status === 403) return { config: null, forbidden: true };
  if (notBuilt(res.status)) return { config: null, forbidden: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the SSO configuration"));
  // The endpoint returns the masked view, or `null` when the org has not configured SSO yet.
  return { config: (await res.json()) as SsoConfigView | null, forbidden: false };
}

export async function saveSsoConfig(update: SsoConfigUpdate): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/security/sso`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  if (res.status === 403)
    throw new Error("You need the owner or security-admin role to change this.");
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the SSO configuration"));
  return { ok: true };
}
