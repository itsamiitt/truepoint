// useLists.ts — the engine for the Lists index grid: loads the workspace's lists once on mount, exposes the
// four-state signals (loading/error + the rows), and a reload the CRUD actions call after a mutation so the
// list (and its member counts) re-reads from the server. Mirrors the prospect slice's custom-hook pattern
// (api client + local state, not a global cache). Lists are workspace-shared; ownership is a per-row flag.
"use client";

import type { List } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchLists } from "../api";

export interface ListsState {
  lists: List[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useLists(): ListsState {
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLists(await fetchLists());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load lists");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return { lists, loading, error, reload: run };
}
