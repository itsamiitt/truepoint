// api.ts — the feature-flags slice's only seam to the internal /admin/* API (apps/api). Self-contained:
// it calls the staff-authenticated admin endpoints over the session cookie (credentials: "include"). The
// admin shell (a sibling unit) owns global auth/session wiring; this slice only needs the typed calls and
// reads its API base from NEXT_PUBLIC_ADMIN_API_BASE (falls back to same-origin).

import type {
  FeatureFlagGlobalToggle,
  FeatureFlagTenantToggle,
  FeatureFlagUpsert,
  FeatureFlagWithOverrides,
} from "@leadwolf/types";

const API_BASE = process.env.NEXT_PUBLIC_ADMIN_API_BASE ?? "";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}/api/v1/admin${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** List every flag with its per-tenant overrides. */
export async function fetchFeatureFlags(): Promise<FeatureFlagWithOverrides[]> {
  const res = await adminFetch("/feature-flags");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load feature flags"));
  const body = (await res.json()) as { flags: FeatureFlagWithOverrides[] };
  return body.flags;
}

/** Define or update a flag (idempotent on key). */
export async function upsertFeatureFlag(input: FeatureFlagUpsert): Promise<void> {
  const res = await adminFetch("/feature-flags", { method: "PUT", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the flag"));
}

/** Toggle a flag's global default on/off. */
export async function setGlobalFlag(key: string, body: FeatureFlagGlobalToggle): Promise<void> {
  const res = await adminFetch(`/feature-flags/${encodeURIComponent(key)}/global`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not toggle the flag"));
}

/** Set or clear a per-tenant override (`enabled: null` clears it). */
export async function setTenantOverride(key: string, body: FeatureFlagTenantToggle): Promise<void> {
  const res = await adminFetch(`/feature-flags/${encodeURIComponent(key)}/tenant`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not set the tenant override"));
}
