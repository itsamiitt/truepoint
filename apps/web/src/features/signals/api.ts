// api.ts — data access for the Signals surface (market-intelligence MI-S5/MI-S6): the tenant signal feed
// (/api/v1/signals — the workspace's DELIVERED copy, never Layer 0) and watchlist CRUD + the caller's
// per-watchlist subscription (/api/v1/watchlists). The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { SignalFamily, TenantSignal, Watchlist } from "@leadwolf/types";

export async function fetchSignals(opts: {
  accountId?: string;
  limit?: number;
}): Promise<TenantSignal[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.accountId) params.set("accountId", opts.accountId);
  const res = await fetchWithAuth(`${API_BASE}/api/v1/signals?${params}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load signals"));
  return ((await res.json()) as { signals: TenantSignal[] }).signals;
}

export async function fetchWatchlists(): Promise<Watchlist[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/watchlists`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load watchlists"));
  return ((await res.json()) as { watchlists: Watchlist[] }).watchlists;
}

export async function createWatchlist(name: string): Promise<string> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/watchlists`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not create the watchlist"));
  return ((await res.json()) as { id: string }).id;
}

export async function deleteWatchlist(id: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/watchlists/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not delete the watchlist"));
}

export async function fetchWatchlistMembers(watchlistId: string): Promise<string[]> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/watchlists/${encodeURIComponent(watchlistId)}/members`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the watchlist"));
  return ((await res.json()) as { accountIds: string[] }).accountIds;
}

export async function addWatchlistMember(watchlistId: string, accountId: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/watchlists/${encodeURIComponent(watchlistId)}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not watch the account"));
}

export async function removeWatchlistMember(watchlistId: string, accountId: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/watchlists/${encodeURIComponent(watchlistId)}/members/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not unwatch the account"));
}

/** PUT the CALLER's subscription on one watchlist. Empty families = paused. */
export async function setSubscription(
  watchlistId: string,
  families: SignalFamily[],
): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/watchlists/${encodeURIComponent(watchlistId)}/subscription`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ families }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the subscription"));
}
