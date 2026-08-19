// useSignals.ts — the tenant signal feed + watchlist management for the Signals page. Presentation state
// only; the store is server-side (tenant_signals / watchlists under RLS). Mutations invalidate rather
// than patch — the lists are small and a refetch is the simpler correctness.
"use client";

import type { SignalFamily, TenantSignal, Watchlist } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  addWatchlistMember,
  createWatchlist,
  deleteWatchlist,
  fetchSignals,
  fetchWatchlists,
  removeWatchlistMember,
  setSubscription,
} from "../api";
import { signalKeys } from "../keys";

export function useSignalFeed(accountId?: string) {
  const [family, setFamily] = useState<SignalFamily | "all">("all");
  const query = useQuery<TenantSignal[]>({
    queryKey: signalKeys.feed(accountId),
    queryFn: () => fetchSignals({ accountId, limit: 100 }),
  });
  // Family filtering is client-side: the page holds at most 100 rows and the filter is a lens, not a query.
  const signals = useMemo(() => {
    const rows = query.data ?? [];
    return family === "all" ? rows : rows.filter((s) => s.family === family);
  }, [query.data, family]);
  return {
    signals,
    family,
    setFamily,
    loading: query.isPending,
    error: query.error ? (query.error as Error).message : null,
    reload: () => void query.refetch(),
  };
}

export function useWatchlists() {
  const qc = useQueryClient();
  const query = useQuery<Watchlist[]>({
    queryKey: signalKeys.watchlists(),
    queryFn: fetchWatchlists,
  });
  const invalidate = useCallback(
    () => void qc.invalidateQueries({ queryKey: signalKeys.watchlists() }),
    [qc],
  );

  const create = useMutation({ mutationFn: createWatchlist, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: deleteWatchlist, onSuccess: invalidate });
  const addMember = useMutation({
    mutationFn: (v: { watchlistId: string; accountId: string }) =>
      addWatchlistMember(v.watchlistId, v.accountId),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({
    mutationFn: (v: { watchlistId: string; accountId: string }) =>
      removeWatchlistMember(v.watchlistId, v.accountId),
    onSuccess: invalidate,
  });
  const subscribe = useMutation({
    mutationFn: (v: { watchlistId: string; families: SignalFamily[] }) =>
      setSubscription(v.watchlistId, v.families),
  });

  return {
    watchlists: query.data ?? [],
    loading: query.isPending,
    error: query.error ? (query.error as Error).message : null,
    reload: () => void query.refetch(),
    create,
    remove,
    addMember,
    removeMember,
    subscribe,
  };
}
