// useCompany.ts — the /companies/:id page reads: the masked account + its delivered signals + the
// watch state (membership of the auto-created "Watched accounts" list). Presentation state only.
"use client";

import {
  addWatchlistMember,
  createWatchlist,
  fetchSignals,
  fetchWatchlistMembers,
  fetchWatchlists,
  removeWatchlistMember,
} from "@/features/signals/api";
import type { TenantSignal } from "@leadwolf/types";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAccount } from "../api";

const WATCH_LIST_NAME = "Watched accounts";

export function useCompany(accountId: string) {
  // Navigating company → company is a NEW key per account — hold the previous record while the fresh one
  // lands instead of strobing to a skeleton (perf-checklist PA-8).
  const account = useQuery({
    queryKey: ["companies", "account", accountId],
    queryFn: () => fetchAccount(accountId),
    placeholderData: keepPreviousData,
  });
  const signals = useQuery<TenantSignal[]>({
    queryKey: ["companies", "signals", accountId],
    queryFn: () => fetchSignals({ accountId, limit: 25 }),
    placeholderData: keepPreviousData,
  });
  return { account, signals };
}

/** Watch/unwatch via the auto-created "Watched accounts" list (MI-1 v1 — one default list; explicit
 *  multi-list management lives on the Signals page). Membership is read from that list's members. */
export function useWatchAccount(accountId: string) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["companies", "watch", accountId],
    queryFn: async () => {
      const lists = await fetchWatchlists();
      const list = lists.find((w) => w.name === WATCH_LIST_NAME);
      if (!list) return { watchlistId: null as string | null, watched: false };
      const members = await fetchWatchlistMembers(list.id);
      return { watchlistId: list.id, watched: members.includes(accountId) };
    },
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["companies", "watch", accountId] });
    void qc.invalidateQueries({ queryKey: ["signals", "watchlists"] });
  };

  const toggle = useMutation({
    mutationFn: async () => {
      const current = state.data;
      let watchlistId = current?.watchlistId ?? null;
      if (!watchlistId) watchlistId = await createWatchlist(WATCH_LIST_NAME);
      if (current?.watched) await removeWatchlistMember(watchlistId, accountId);
      else await addWatchlistMember(watchlistId, accountId);
    },
    onSuccess: invalidate,
  });

  return {
    watched: state.data?.watched ?? false,
    loading: state.isPending,
    toggling: toggle.isPending,
    toggle: () => toggle.mutate(),
  };
}
