// api.ts — the reports slice's data access. The MVP report is composed client-side from the existing
// credits + contacts endpoints (the ClickHouse pipeline is post-MVP — ADR-0010), fetched in parallel via
// fetchWithAuth and the in-memory access token (ADR-0016). The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { MaskedContact } from "@leadwolf/types";
import type { UsageReveal } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** The raw inputs every report section derives from (see rollups.ts). */
export interface ReportsSource {
  balance: number;
  reveals: UsageReveal[];
  contacts: MaskedContact[];
}

/** GET /credits/balance — the headline tile. */
async function fetchBalance(): Promise<number> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/balance`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load credit balance"));
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

/** GET /credits/usage — the metered reveals feeding the 7/14-day rollups. */
async function fetchUsage(limit = 100): Promise<UsageReveal[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/usage?limit=${limit}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load usage history"));
  const data = (await res.json()) as { reveals: UsageReveal[] };
  return data.reveals;
}

/** GET /contacts — masked rows feeding the funnel + data-health rollups (no PII needed). */
async function fetchContacts(limit = 100): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts?limit=${limit}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load contacts"));
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
}

/** Fetch all three report inputs in parallel. */
export async function fetchReportsSource(): Promise<ReportsSource> {
  const [balance, reveals, contacts] = await Promise.all([
    fetchBalance(),
    fetchUsage(100),
    fetchContacts(100),
  ]);
  return { balance, reveals, contacts };
}
