// useProspectSearch.ts — the engine for the server-driven prospect grid (24 §5/§6, Done-When #1/#3/#5). The
// page URL is the single source of truth: the active ContactQuery is DERIVED from the URL (searchUrlState), so
// a search is shareable and restored on refresh / back. setQuery writes back through router.replace; the search
// re-runs whenever the (URL-derived) query changes. Exposes keyset "load more" and an optimistic markRevealed
// so a reveal flips the row without a refetch. Replaces the client-side useContacts path for the filtered grid.
//
// The keyset pages are a TanStack `useInfiniteQuery`, which is what this hook was hand-rolling: accumulate
// pages in useState, track the cursor, and cancel the previous request through an AbortController ref so a
// superseded search could not write stale rows. RQ does all three, and does the last one properly — results
// are keyed by the search, so an in-flight older search cannot land on a newer one's entry no matter what
// order the responses arrive in. It also means going back to a previous filter combination is instant rather
// than a fresh round trip, which the ref-based version could never offer because it kept exactly one result set.
"use client";

import type { ContactHit, ContactQuery, SearchPage } from "@leadwolf/types";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { prospectKeys } from "../keys";
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
  const qc = useQueryClient();

  // URL → query (the source of truth). Re-derives whenever the query string changes (refresh, back, share).
  const query = useMemo(
    () => paramsToQuery(new URLSearchParams(searchParams?.toString() ?? "")),
    [searchParams],
  );

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

  // Memoized because the factory returns a NEW array each call: without this `markRevealed` below would be
  // rebuilt on every render, and it is passed down to the grid rows.
  const queryKey = useMemo(() => prospectKeys.contactSearch(query), [query]);
  const search = useInfiniteQuery<SearchPage<ContactHit>>({
    queryKey,
    enabled,
    initialPageParam: null,
    // RQ owns the AbortSignal: it aborts on unmount and on cancellation, so an abandoned keystroke stops
    // costing the backend a full search without this hook tracking a controller itself.
    queryFn: ({ pageParam, signal }) =>
      searchContacts(
        { ...query, limit: PAGE_SIZE, cursor: (pageParam as string | null) ?? undefined },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const hits = useMemo(() => search.data?.pages.flatMap((page) => page.hits) ?? [], [search.data]);

  const markRevealed = useCallback(
    (id: string) => {
      // Written straight into the cache rather than into a parallel useState, so the optimistic flip survives
      // a remount and stays consistent with what a later refetch replaces it with.
      qc.setQueryData<{ pages: SearchPage<ContactHit>[]; pageParams: unknown[] }>(
        queryKey,
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              hits: page.hits.map((h) => (h.id === id ? { ...h, isRevealed: true } : h)),
            })),
          },
      );
    },
    [qc, queryKey],
  );

  return {
    query,
    setQuery,
    hits,
    // A filter edit is a NEW cache entry, so isPending covers exactly what the old cold-load flag did; a
    // "load more" is deliberately not a full-grid loading state.
    loading: search.isPending && enabled,
    error: search.error
      ? search.error instanceof Error
        ? search.error.message
        : "Search failed"
      : null,
    hasMore: search.hasNextPage,
    loadMore: () => {
      if (search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
    },
    reload: () => {
      void search.refetch();
    },
    markRevealed,
  };
}
