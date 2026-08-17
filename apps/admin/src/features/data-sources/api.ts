// api.ts — the data-sources slice's seam to /admin/data-sources (the provider_origins fleet, 0117).
// Same client posture as provider-configs: Bearer via fetchWithAuth, masked reads (key HINT only), a 404
// degrades to "not yet available". The API key is WRITE-ONLY: it leaves this module once, on create/update,
// and is never read back.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DataSourceOriginView, OriginTestResult } from "./types";

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

export async function fetchDataSourceOrigins(): Promise<DataSourceOriginView[]> {
  const res = await adminFetch("/data-sources");
  if (res.status === 404) throw new Error("DATA_SOURCES_ENDPOINT_UNAVAILABLE");
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load data sources"));
  const body = (await res.json()) as { origins: DataSourceOriginView[] };
  return body.origins;
}

export async function createOrigin(input: {
  label: string;
  baseUrl: string;
  apiKey?: string | null;
  priority?: number;
}): Promise<void> {
  const res = await adminFetch("/data-sources", { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not add the origin"));
}

export async function setOriginPaused(id: string, paused: boolean): Promise<void> {
  const res = await adminFetch(`/data-sources/${encodeURIComponent(id)}/pause`, {
    method: "POST",
    body: JSON.stringify({ paused }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the origin"));
}

export async function deleteOrigin(id: string): Promise<void> {
  const res = await adminFetch(`/data-sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not delete the origin"));
}

/** Live probe through the whole failover machinery. Status + latency only — the payload never crosses. */
export async function testOrigin(id: string): Promise<OriginTestResult> {
  const res = await adminFetch(`/data-sources/${encodeURIComponent(id)}/test`, { method: "POST" });
  if (!res.ok) throw new Error(await problemMessage(res, "Test failed"));
  return (await res.json()) as OriginTestResult;
}
