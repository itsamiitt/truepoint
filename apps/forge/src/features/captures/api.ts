// api.ts — the Captures slice's data access: a typed, authenticated GET against the forge-api `/bff/captures`
// surface via the in-memory access token (fetchWithAuth, ADR-0016). Reads only; the console never touches a DB.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { Capture, CapturesResponse } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /bff/captures — the captured-items feed (most recent first, as ordered by the BFF). */
export async function fetchCaptures(): Promise<Capture[]> {
  const res = await fetchWithAuth(`${API_BASE}/bff/captures`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load captures"));
  const body = (await res.json()) as CapturesResponse;
  return body.captures;
}
