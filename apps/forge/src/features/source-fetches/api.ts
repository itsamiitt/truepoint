// api.ts — the Source fetches slice's data access: a typed, authenticated GET against the forge-api
// `/bff/source-fetches` surface via the in-memory access token (fetchWithAuth, ADR-0016). Reads only.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { SourceFetch, SourceFetchesResponse } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /bff/source-fetches — the live URL fetch-registry telemetry (most recently touched first). */
export async function fetchSourceFetches(): Promise<SourceFetch[]> {
  const res = await fetchWithAuth(`${API_BASE}/bff/source-fetches`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load source fetches"));
  const body = (await res.json()) as SourceFetchesResponse;
  return body.fetches;
}
