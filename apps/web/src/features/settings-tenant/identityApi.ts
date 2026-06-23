// identityApi.ts — the Tenant ▸ Security ▸ Domains & SCIM backend seam: authenticated calls (fetchWithAuth,
// ADR-0016) to the /settings/security/identity routes. Kept SEPARATE from the shared api.ts (this slice owns
// its own seam). A 403 (not security_admin/owner) surfaces as `{ forbidden: true }` so the panel shows a
// quiet access message; a 404/501 ("not built yet") surfaces as null/empty so the panel degrades gracefully.
//
//   GET    /settings/security/identity/domains             → claimed domains
//   POST   /settings/security/identity/domains             → claim a domain
//   POST   /settings/security/identity/domains/:id/verify  → verify a domain
//   GET    /settings/security/identity/scim/tokens         → SCIM tokens (masked)
//   POST   /settings/security/identity/scim/tokens         → mint a token (plaintext returned ONCE)
//   DELETE /settings/security/identity/scim/tokens/:id     → revoke a token

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DomainView, ScimTokenCreated, ScimTokenView } from "@leadwolf/types";

const BASE = `${API_BASE}/api/v1/settings/security/identity`;

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

// ── Domains ──────────────────────────────────────────────────────────────────────────────────────────────

/** Load claimed domains. 403 → forbidden; not-built → available:false (panel degrades, never errors). */
export async function fetchDomains(): Promise<{
  forbidden: boolean;
  available: boolean;
  domains: DomainView[];
}> {
  const res = await fetchWithAuth(`${BASE}/domains`);
  if (res.status === 403) return { forbidden: true, available: true, domains: [] };
  if (notBuilt(res.status)) return { forbidden: false, available: false, domains: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load domains"));
  const body = (await res.json()) as { domains?: DomainView[] };
  return { forbidden: false, available: true, domains: body.domains ?? [] };
}

export async function claimDomain(domain: string): Promise<DomainView> {
  const res = await fetchWithAuth(`${BASE}/domains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  if (res.status === 403)
    throw new Error("You need the owner or security-admin role to claim a domain.");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not claim that domain"));
  return (await res.json()) as DomainView;
}

export async function verifyDomain(id: string): Promise<DomainView> {
  const res = await fetchWithAuth(`${BASE}/domains/${encodeURIComponent(id)}/verify`, {
    method: "POST",
  });
  if (res.status === 403)
    throw new Error("You need the owner or security-admin role to verify a domain.");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not verify that domain"));
  return (await res.json()) as DomainView;
}

// ── SCIM tokens ──────────────────────────────────────────────────────────────────────────────────────────

/** Load SCIM tokens (masked). 403 → forbidden; not-built → available:false. */
export async function fetchScimTokens(): Promise<{
  forbidden: boolean;
  available: boolean;
  tokens: ScimTokenView[];
}> {
  const res = await fetchWithAuth(`${BASE}/scim/tokens`);
  if (res.status === 403) return { forbidden: true, available: true, tokens: [] };
  if (notBuilt(res.status)) return { forbidden: false, available: false, tokens: [] };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load SCIM tokens"));
  const body = (await res.json()) as { tokens?: ScimTokenView[] };
  return { forbidden: false, available: true, tokens: body.tokens ?? [] };
}

/** Mint a SCIM token. The plaintext `token` in the response is shown ONCE and is never recoverable. */
export async function createScimToken(name: string): Promise<ScimTokenCreated> {
  const res = await fetchWithAuth(`${BASE}/scim/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 403)
    throw new Error("You need the owner or security-admin role to create a SCIM token.");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not create the SCIM token"));
  return (await res.json()) as ScimTokenCreated;
}

export async function revokeScimToken(id: string): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/scim/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 403)
    throw new Error("You need the owner or security-admin role to revoke a SCIM token.");
  if (!res.ok && !notBuilt(res.status))
    throw new Error(await problemMessage(res, "Could not revoke the SCIM token"));
}
