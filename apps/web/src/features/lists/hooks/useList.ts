// useList.ts — loads one list's metadata (name, description, member count, owner) for the detail header. The
// lists API has no per-id GET, so this derives the row from the workspace list (the same source the index
// uses); a missing id resolves to `notFound` so the detail surface can render an honest not-found state rather
// than an error. Re-reads on reload (e.g. after a rename, so the header reflects the new name).
"use client";

import type { List } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchList } from "../api";

export interface ListState {
  list: List | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  reload: () => void;
}

export function useList(id: string): ListState {
  const [list, setList] = useState<List | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const found = await fetchList(id);
      if (found) setList(found);
      else setNotFound(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load list");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void run();
  }, [run]);

  return { list, loading, error, notFound, reload: run };
}
