// api.ts — the retention-policy slice's only seam to the internal /admin/* API (apps/api). Authenticates via
// the in-memory access token (fetchWithAuth, Bearer — ADR-0016), the SAME client the Tenants/Imports slices +
// the platform-admin gate (adminGate) use. The api authn middleware is Bearer-only (no cookie fallback —
// authn.ts), so the previous cookie credentials carried nothing usable. The shapes are the shared
// @leadwolf/types contract; the server is the real authz boundary (the write is super_admin-only + audited
// there — this client cannot bypass it).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { RetentionPolicy } from "@leadwolf/types";
import type { RetentionPolicyPatch, RetentionRunRow } from "./types";

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

/** List every global retention policy (one row per data class). */
export async function listRetentionPolicies(): Promise<RetentionPolicy[]> {
  const res = await adminFetch("/retention-policies");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load retention policies"));
  const body = (await res.json()) as { policies: RetentionPolicy[] };
  return body.policies;
}

/** Define or update one class's policy (idempotent on data class). super_admin only + audited on the server. */
export async function updateRetentionPolicy(
  dataClass: RetentionPolicy["dataClass"],
  patch: RetentionPolicyPatch,
): Promise<void> {
  const res = await adminFetch("/retention-policies", {
    method: "PUT",
    body: JSON.stringify({ dataClass, ...patch }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the policy"));
}

/** List recent retention-engine RUNS across all tenants — the cross-tenant SHADOW evidence (bounded +
 *  newest-first by the api). Read-only + audited (admin.list_retention_runs) on the server. */
export async function listRetentionRuns(): Promise<RetentionRunRow[]> {
  const res = await adminFetch("/retention-runs");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load retention runs"));
  const body = (await res.json()) as { runs: RetentionRunRow[] };
  return body.runs;
}
