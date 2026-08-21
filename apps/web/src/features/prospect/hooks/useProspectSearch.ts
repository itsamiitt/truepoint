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
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { type ProspectRow, mergeRows, toDatabaseQuery } from "../databaseRows";
import { searchDatabase } from "../databaseSearchApi";
import { prospectKeys } from "../keys";
import { searchContacts } from "../searchApi";
import { paramsToQuery, queryToSearchString } from "../searchUrlState";

const PAGE_SIZE = 50;

export interface ProspectSearch {
  query: ContactQuery;
  setQuery: (next: ContactQuery) => void;
  /** Workspace contacts FIRST, then people from the platform database the workspace does not hold. */
  hits: ProspectRow[];
  /** How many of `hits` come from the platform database (not yet in the workspace). */
  databaseCount: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Optimistically flip a row to revealed after a successful reveal (no refetch). */
  markRevealed: (id: string) => void;
  /** Patch the cached owned rows in place after a bulk mutation whose outcome is known (P3.3b — no refetch). */
  patchRows: (ids: string[], patch: (row: ContactHit) => ContactHit) => void;
  /** Drop rows from the cached owned pages (e.g. archived out of the workspace) without a refetch. */
  removeRows: (ids: string[]) => void;
}

export interface UseProspectSearchOptions {
  /** When false the query is still derived from the URL, but NO request is issued. Defaults to true.
   *  (Historically this existed because the Prospect page mounted both scopes at once — React forbids
   *  conditional hooks — and the inactive scope's search AND facet POSTs fired on every visit for a grid
   *  nobody saw. The Search composer mounts ONE pane, so that reason is gone; the option stays for callers
   *  that genuinely want a URL-derived query without a request.) */
  enabled?: boolean;
  /** From the shell's workspace-scope control: "In workspace" turns the GLOBAL half off entirely. */
  includeDatabase?: boolean;
  /** "New to me": drop the OWNED half so only people the workspace does not hold are listed. */
  excludeOwned?: boolean;
}

export function useProspectSearch(options?: UseProspectSearchOptions): ProspectSearch {
  const enabled = options?.enabled ?? true;
  const includeDatabase = options?.includeDatabase ?? true;
  const excludeOwned = options?.excludeOwned ?? false;
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
  // fully captures the search for refresh/share. pathname-relative so it stays on the Search route. Only the
  // contacts keys (q/sort/f) are written, so the Accounts codec (aq/asort/af), the ?tab switch, the ?ws
  // scope and any open ?person/?company profile all survive untouched — that is what lets one URL carry the
  // whole surface.
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
    // "New to me" turns the owned half OFF at the source rather than filtering its rows out afterwards:
    // paying for a search whose every row is about to be discarded is the wrong kind of thorough.
    enabled: enabled && !excludeOwned,
    initialPageParam: null,
    // A filter edit is a NEW cache key; without this the grid unmounted to a skeleton on every edit and
    // repopulated ("strobing"). Holding the previous key's rows while the fresh search lands is the same
    // treatment the facet sidebar already had — the grid, the thing the user is looking at, deserves it most.
    placeholderData: keepPreviousData,
    // Search pages are big and re-entered constantly (grid → drawer → back, route away → back): keep them
    // 10 minutes instead of the 5-minute default so re-entry is instant, not a refetch (perf-checklist PA-8).
    gcTime: 10 * 60_000,
    // RQ owns the AbortSignal: it aborts on unmount and on cancellation, so an abandoned keystroke stops
    // costing the backend a full search without this hook tracking a controller itself.
    queryFn: ({ pageParam, signal }) =>
      searchContacts(
        { ...query, limit: PAGE_SIZE, cursor: (pageParam as string | null) ?? undefined },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // In "New to me" the owned engine is disabled above, so its cache may still hold a previous page — read
  // through excludeOwned rather than off search.data, or stale owned rows would linger in a mode whose whole
  // point is that there are none.
  const owned = useMemo(
    () => (excludeOwned ? [] : (search.data?.pages.flatMap((page) => page.hits) ?? [])),
    [search.data, excludeOwned],
  );

  // THE PLATFORM DATABASE, in the SAME list (Layer-0-as-database). A sales-intelligence search is one
  // filtered list of people; whether a row is already in the workspace is a property of the row, not a
  // different screen. The database half runs as its own query so a slow/failed global search can never
  // stall or break the workspace results — it simply contributes nothing.
  const databaseQuery = useMemo(() => toDatabaseQuery(query, PAGE_SIZE), [query]);
  const databaseSearch = useQuery({
    queryKey: prospectKeys.databaseSearch(databaseQuery ?? { filters: [], limit: PAGE_SIZE }),
    // Skipped when the query is inherently workspace-only (owner, status, tags, ranges…).
    enabled: enabled && includeDatabase && databaseQuery !== null,
    // Same no-blank treatment as the owned half above: a filter edit keeps the previous database rows on
    // screen while the fresh search lands, instead of the merged grid losing its bottom half per edit.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchDatabase(databaseQuery as NonNullable<typeof databaseQuery>, signal),
    staleTime: 30_000,
  });

  const hits = useMemo(
    () => mergeRows(owned, databaseSearch.data?.hits ?? []),
    [owned, databaseSearch.data],
  );
  const databaseCount = hits.length - owned.length;

  // Written straight into the cache rather than into a parallel useState, so a patched row survives a
  // remount and stays consistent with what a later refetch replaces it with. patchRows/removeRows are the
  // bulk-mutation counterparts (perf-audit P3.3b): a bulk action whose outcome is known client-side edits
  // the cached pages in place instead of refetching every loaded page.
  const patchRows = useCallback(
    (ids: string[], patch: (row: ContactHit) => ContactHit) => {
      const idSet = new Set(ids);
      qc.setQueryData<{ pages: SearchPage<ContactHit>[]; pageParams: unknown[] }>(
        queryKey,
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              hits: page.hits.map((h) => (idSet.has(h.id) ? patch(h) : h)),
            })),
          },
      );
    },
    [qc, queryKey],
  );

  const removeRows = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      qc.setQueryData<{ pages: SearchPage<ContactHit>[]; pageParams: unknown[] }>(
        queryKey,
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              hits: page.hits.filter((h) => !idSet.has(h.id)),
            })),
          },
      );
    },
    [qc, queryKey],
  );

  const markRevealed = useCallback(
    (id: string) => {
      patchRows([id], (h) => ({ ...h, isRevealed: true }));
    },
    [patchRows],
  );

  return {
    query,
    setQuery,
    hits,
    databaseCount,
    // With keepPreviousData above, isPending is true only on the genuine cold load (no previous rows to
    // show) — a filter edit keeps the old rows on screen while fetching, and a "load more" is deliberately
    // not a full-grid loading state either.
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
    patchRows,
    removeRows,
  };
}
