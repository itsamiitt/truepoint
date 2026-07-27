// credits.ts — the tenant's reveal-credit balance, as ONE query the whole app shares.
//
// It lives in lib rather than in a feature because two surfaces read it: the top-bar CreditPill (shell) and
// the prospect bulk bar. They used to be two independent fetches of the same endpoint, each holding its own
// copy of the number and each re-fetching on a `credits:changed` window event — so a spend produced two
// requests, and any moment where only one of them had re-read showed two different balances in one viewport.
//
// The authoritative balance is server-side (07 §3); the UI never computes or mutates it.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { sharedKeys } from "@/lib/queryKeys";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";

export async function fetchCreditBalance(): Promise<number> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/balance`);
  if (!res.ok) throw new Error(`Could not load credit balance (${res.status})`);
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

export function useCreditBalance() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: sharedKeys.creditBalance(),
    queryFn: fetchCreditBalance,
  });

  return {
    // A read failure must never block selection/reveal — both surfaces render "—" for null.
    balance: query.data ?? null,
    reload: () => {
      void qc.invalidateQueries({ queryKey: sharedKeys.creditBalance() });
    },
  };
}

/**
 * Announce that credits moved.
 *
 * This replaces `window.dispatchEvent(new Event("credits:changed"))`. The window bus worked, but it was a
 * second, parallel invalidation mechanism that only the components which happened to subscribe could hear —
 * invisible to the query cache, untestable without a DOM, and silently missed by any surface added later.
 * Invalidation reaches every reader of these keys, including ones that do not exist yet.
 *
 * The notification feed is invalidated alongside the balance because a spend can produce a notification, and
 * the bell was subscribed to the same event for exactly that reason.
 */
export function invalidateCreditSignals(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: sharedKeys.creditBalance() });
  void qc.invalidateQueries({ queryKey: sharedKeys.notifications() });
}
