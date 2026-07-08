// api.ts — the auth-policy admin slice's API wrapper. Mirrors the retention slice: a private adminFetch over
// fetchWithAuth (in-memory Bearer, no cookie — the /admin API is Bearer-only) against /api/v1/admin, with
// RFC-7807 problem+json error extraction. Reads the platform-DEFAULT auth policy the effective-policy engine
// resolves for every org (GET /admin/auth/platform-policy → getPlatformRows on the server, super_admin-gated).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";

/** One platform-default policy row: a key (e.g. "mfa_enforcement") and its jsonb value. */
export interface PlatformDefault {
  key: string;
  value: unknown;
}

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetchWithAuth(`${API_BASE}/api/v1/admin${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Every platform-default policy key currently set (the base every org inherits + can only tighten). */
export async function listPlatformDefaults(): Promise<PlatformDefault[]> {
  const res = await adminFetch("/auth/platform-policy");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load platform auth defaults"));
  return ((await res.json()) as { policies: PlatformDefault[] }).policies;
}

/** Set ONE platform-default key. The server (validatePolicyWrite) is the real guard — it validates the value's
 *  shape and rejects anything below the security floor — so this sends the typed value and surfaces its error. */
export async function setPlatformDefault(key: string, value: unknown): Promise<void> {
  const res = await adminFetch("/auth/platform-policy", {
    method: "PUT",
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the platform default"));
}
