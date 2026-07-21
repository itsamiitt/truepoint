// api.ts — the Parsers slice's data access: a typed, authenticated GET against the forge-api `/bff/parsers`
// surface via the in-memory access token (fetchWithAuth, ADR-0016). Reads only; the console never touches a DB.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { Parser, ParsersResponse } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /bff/parsers — the registered parsers and their recent health. */
export async function fetchParsers(): Promise<Parser[]> {
  const res = await fetchWithAuth(`${API_BASE}/bff/parsers`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load parsers"));
  const body = (await res.json()) as ParsersResponse;
  return body.parsers;
}
