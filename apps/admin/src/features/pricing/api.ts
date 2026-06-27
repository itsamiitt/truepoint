// api.ts — the Pricing slice's data access: typed, authenticated calls against the apps/api
// `/admin/pricing/*` surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER
// touches the database directly — every read/write goes through the audited, pricing:manage-gated endpoints.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { CreditPack } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export interface CreditPackInput {
  key: string;
  name: string;
  credits: number;
  priceCents: number;
  sortOrder: number;
}

/** GET /admin/pricing/credit-packs — the full catalog (active + retired). */
export async function fetchCreditPacks(): Promise<CreditPack[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/pricing/credit-packs`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load credit packs"));
  const body = (await res.json()) as { packs: CreditPack[] };
  return body.packs;
}

/** PUT /admin/pricing/credit-packs — create or update a pack (idempotent on key). */
export async function upsertCreditPack(input: CreditPackInput): Promise<CreditPack> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/pricing/credit-packs`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the pack"));
  const body = (await res.json()) as { pack: CreditPack };
  return body.pack;
}

/** POST /admin/pricing/credit-packs/:key/active — offer or retire a pack. */
export async function setCreditPackActive(key: string, active: boolean): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/pricing/credit-packs/${encodeURIComponent(key)}/active`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the pack"));
}
