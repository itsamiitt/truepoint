// useProspectSearch.ts — the engine for the server-driven prospect grid (24 §5/§6, Done-When #1/#3/#5). The
// page URL is the single source of truth: the active ContactQuery is DERIVED from the URL (searchUrlState), so
// a search is shareable and restored on refresh / back. setQuery writes back through router.replace; the search
// re-runs whenever the (URL-derived) query changes. Exposes keyset "load more" and an optimistic markRevealed
// so a reveal flips the row without a refetch. Replaces the client-side useContacts path for the filtered grid.
"use client";

import type { ContactHit, ContactQuery } from "@leadwolf/types";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { searchContacts } from "../searchApi";
import { paramsToQuery, queryToSearchString } from "../searchUrlState";

const PAGE_SIZE = 50;

export interface ProspectSearch {
  query: ContactQuery;
  setQuery: (next: ContactQuery) => void;
  hits: ContactHit[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Optimistically flip a row to revealed after a successful reveal (no refetch). */
  markRevealed: (id: string) => void;
}

export interface UseProspectSearchOptions {
  /** When false the query is still derived from the URL, but NO request is issued. The Prospect page renders one
   *  scope at a time (contacts vs accounts) while both engines are mounted — React forbids conditional hooks —
   *  so without this the inactive scope's search AND facet-count POSTs fired on every visit to the app's busiest
   *  surface, for a grid that was never shown. Defaults to true so every other caller is unaffected. */
  enabled?: boolean;
}

export function useProspectSearch(options?: UseProspectSearchOptions): ProspectSearch {
  const enabled = options?.enabled ?? true;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL → query (the source of truth). Re-derives whenever the query string changes (refresh, back, share).
  const query = useMemo(
    () => paramsToQuery(new URLSearchParams(searchParams?.toString() ?? "")),
    [searchParams],
  );

  const [hits, setHits] = useState<ContactHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Write a new query to the URL. replace (not push) so per-edit changes don't flood history; the URL still
  // fully captures the search for refresh/share. pathname-relative so it stays on the prospect route. The
  // scope param (?scope=accounts) is preserved by writing only the contacts keys.
  const setQuery = useCallback(
    (next: ContactQuery) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      const qs = queryToSearchString(next, params);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // The request in flight, so a newer search can cancel it. Two searches used to race with no cancellation and
  // the LAST to resolve won — which is not necessarily the newest, so a fast filter edit could leave the
  // previous query's results on screen. Every abandoned keystroke also cost the backend a full search.
  const inFlight = useRef<AbortController | null>(null);

  const run = useCallback(
    async (fromCursor: string | null) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      setError(null);
      try {
        const page = await searchContacts(
          { ...query, limit: PAGE_SIZE, cursor: fromCursor ?? undefined },
          controller.signal,
        );
        // Superseded while awaiting — a newer run owns the state now; do not write stale results.
        if (controller.signal.aborted) return;
        setHits((prev) => (fromCursor ? [...prev, ...page.hits] : page.hits));
        setCursor(page.nextCursor);
      } catch (e) {
        // Our own cancellation is not a failure and must not surface as an error to the user.
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        // Leave `loading` true when superseded: the newer run already set it and owns clearing it.
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [query],
  );

  // Re-run from the first page whenever the URL-derived query changes (keyed on its serialization).
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run is intentionally keyed on queryKey only.
  useEffect(() => {
    if (!enabled) return;
    void run(null);
  }, [queryKey, enabled]);

  // Cancel whatever is in flight when the consumer unmounts, so a late response cannot set state on a dead tree.
  useEffect(() => () => inFlight.current?.abort(), []);

  const loadMore = useCallback(() => {
    if (cursor) void run(cursor);
  }, [cursor, run]);

  const reload = useCallback(() => {
    void run(null);
  }, [run]);

  const markRevealed = useCallback((id: string) => {
    setHits((prev) => prev.map((h) => (h.id === id ? { ...h, isRevealed: true } : h)));
  }, []);

  return {
    query,
    setQuery,
    hits,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore,
    reload,
    markRevealed,
  };
}
