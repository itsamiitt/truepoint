// api.ts — the feature-flags slice's only seam to the internal /admin/* API (apps/api). Authenticates via the
// in-memory access token (fetchWithAuth, Bearer — ADR-0016), the SAME client the Tenants/Imports slices + the
// platform-admin gate use. The api authn middleware is Bearer-only (no cookie fallback — authn.ts), so the
// previous cookie credentials carried no usable credential. Reads its API base from publicConfig.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  EnvFeatureGate,
  FeatureFlagGlobalToggle,
  FeatureFlagTenantToggle,
  FeatureFlagUpsert,
  FeatureFlagWithOverrides,
} from "@leadwolf/types";

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

/** Read the deploy-time env master-switch states (read-only; process-level kill-switches). */
export async function fetchEnvGates(): Promise<EnvFeatureGate[]> {
  const res = await adminFetch("/feature-flags/env-gates");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load master switches"));
  const body = (await res.json()) as { gates: EnvFeatureGate[] };
  return body.gates;
}
