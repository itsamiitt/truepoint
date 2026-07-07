// api.ts — the Sync status slice's data access: a typed, authenticated GET against the forge-api
// `/bff/sync-status` surface via the in-memory access token (fetchWithAuth, ADR-0016). Reads only; the console
// never touches a DB.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { SyncStatusResponse, SyncTarget } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /bff/sync-status — the downstream sync destinations and their backlog/health. */
export async function fetchSyncStatus(): Promise<SyncTarget[]> {
  const res = await fetchWithAuth(`${API_BASE}/bff/sync-status`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load sync status"));
  const body = (await res.json()) as SyncStatusResponse;
  return body.targets;
}
