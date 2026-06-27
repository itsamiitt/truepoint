// useTemplates.ts — loads the message-template library for the Templates panel (M12 P2; 11 §4.3). Returns the
// standard { data, loading, error, reload } shape plus keyset pagination (`nextCursor` + `loadMore`) and a
// `status` filter (active library vs archived bin — so an archive is reversible from the UI). The backend is
// LIVE, so `available` defaults true and only flips false if the endpoint 404/501s (an older deploy). A failed
// `loadMore` surfaces on its OWN `loadMoreError` so it never tears down the already-loaded grid (the page-1
// `error` drives the full-panel StateSwitch). Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTemplates } from "../api";
import type { TemplateStatus, TemplateSummary } from "../types";

export function useTemplates() {
  const [data, setData] = useState<TemplateSummary[]>([]);
  const [status, setStatus] = useState<TemplateStatus>("active");
  const [available, setAvailable] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    try {
      const { items, available: ok, nextCursor: next } = await fetchTemplates({ status });
      setData(items);
      setAvailable(ok);
      setNextCursor(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [status]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const { items, nextCursor: next } = await fetchTemplates({ cursor: nextCursor, status });
      // Append — a failed page must never discard the pages already loaded (the catch leaves `data` intact).
      setData((prev) => [...prev, ...items]);
      setNextCursor(next);
    } catch (e) {
      setLoadMoreError(e instanceof Error ? e.message : "Failed to load more templates");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, status]);

  // Refetch page 1 whenever the status filter flips (reload's identity changes with `status`).
  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    data,
    status,
    setStatus,
    available,
    nextCursor,
    loading,
    loadingMore,
    error,
    loadMoreError,
    reload,
    loadMore,
  };
}
