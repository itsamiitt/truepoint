// useAccountSearch.ts — the engine for the server-driven Accounts grid (the company-level sibling of
// useProspectSearch). The page URL is the single source of truth: the active AccountQuery is DERIVED from the
// URL, so an accounts view is shareable and restored on refresh / back. setQuery writes back through
// router.replace; the search re-runs whenever the (URL-derived) query changes. Exposes keyset "load more".
//
// It is deliberately INDEPENDENT of useProspectSearch and does NOT touch searchUrlState (the Contacts codec).
// The keyset pages are a TanStack `useInfiniteQuery` for the same reasons as its Contacts sibling — page
// accumulation, cursor tracking and supersede-cancellation were all hand-rolled here, and RQ keys results by
// the search so a late response cannot overwrite a newer one.
//
// Its codec uses its own URL params (`aq`/`asort`/`af`) so the Accounts query can coexist with the Contacts
// query in one URL without either clobbering the other. The filter blob is the SAME base64url-of-JSON shape as
// the Contacts codec, re-validated defensively on read (a hand-mangled URL degrades to an empty query, never
// throws). INTEGRATOR: if the backend exposes a shared account-URL codec, swap the local codec for it.
"use client";

import type { AccountQuery, AccountSearchPage, MaskedAccount } from "@leadwolf/types";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { searchAccounts } from "../accountSearchApi";
import { prospectKeys } from "../keys";

const PAGE_SIZE = 50;

const SORTS: AccountQuery["sort"][] = ["relevance", "name_asc", "headcount_desc", "created_desc"];

export interface AccountSearch {
  query: AccountQuery;
  setQuery: (next: AccountQuery) => void;
  accounts: MaskedAccount[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/** An empty, valid account query — the safe fallback for an absent/invalid URL. */
export function emptyAccountQuery(): AccountQuery {
  return { filters: [], sort: "relevance", limit: PAGE_SIZE };
}

// ── URL codec (self-contained; mirrors searchUrlState's base64url-of-JSON filter blob) ───────────────────
/** Serialise an AccountQuery to its own URL params (defaults omitted → a pristine view yields a clean URL). */
export function accountQueryToParams(query: AccountQuery, into?: URLSearchParams): URLSearchParams {
  const params = into ?? new URLSearchParams();
  if (query.text) params.set("aq", query.text);
  else params.delete("aq");
  if (query.sort && query.sort !== "relevance") params.set("asort", query.sort);
  else params.delete("asort");
  if (query.filters.length > 0) params.set("af", encodeFilters(query.filters));
  else params.delete("af");
  return params;
}

/** Parse an AccountQuery back from URL params; anything invalid degrades to an empty query (never throws). */
export function paramsToAccountQuery(params: URLSearchParams): AccountQuery {
  const text = params.get("aq") ?? undefined;
  const rawSort = params.get("asort");
  const sort = (SORTS as string[]).includes(rawSort ?? "")
    ? (rawSort as AccountQuery["sort"])
    : "relevance";
  return {
    text: text || undefined,
    filters: decodeFilters(params.get("af")) as AccountQuery["filters"],
    sort,
    limit: PAGE_SIZE,
  };
}

/** `enabled: false` derives the query from the URL but issues NO request — the Prospect page mounts this engine
 *  even while the Contacts scope is showing (hooks cannot be conditional), and it used to search anyway. */
export function useAccountSearch(options?: { enabled?: boolean }): AccountSearch {
  const enabled = options?.enabled ?? true;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL → state (the source of truth). Re-derives whenever the query string changes (refresh, back, share).
  const query = useMemo(
    () => paramsToAccountQuery(new URLSearchParams(searchParams?.toString() ?? "")),
    [searchParams],
  );

  // Write a new query to the URL. replace (not push) so per-edit changes don't flood history; merges into the
  // existing params (so a coexisting Contacts query is preserved), pathname-relative.
  const setQuery = useCallback(
    (next: AccountQuery) => {
      const params = accountQueryToParams(
        next,
        new URLSearchParams(searchParams?.toString() ?? ""),
      );
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const search = useInfiniteQuery<AccountSearchPage>({
    queryKey: prospectKeys.accountSearch(query),
    enabled,
    initialPageParam: null,
    // A filter edit is a NEW cache key; hold the previous rows while the fresh search lands instead of
    // unmounting the grid to a skeleton per edit (same treatment as the contacts grid + facet counts).
    placeholderData: keepPreviousData,
    // RQ owns the AbortSignal and keys results by the search, so a superseded request can neither cost the
    // backend a full search nor land its rows on the newer query's entry.
    queryFn: ({ pageParam, signal }) =>
      searchAccounts(
        { ...query, limit: PAGE_SIZE, cursor: (pageParam as string | null) ?? undefined },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const accounts = useMemo<MaskedAccount[]>(
    () => search.data?.pages.flatMap((page) => page.accounts) ?? [],
    [search.data],
  );

  return {
    query,
    setQuery,
    accounts,
    loading: search.isPending && enabled,
    error: search.error
      ? search.error instanceof Error
        ? search.error.message
        : "Account search failed"
      : null,
    hasMore: search.hasNextPage,
    loadMore: () => {
      if (search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
    },
    reload: () => {
      void search.refetch();
    },
  };
}

// ── filter blob codec (unicode-safe base64url of the filters JSON; mirrors searchUrlState) ───────────────
function encodeFilters(filters: AccountQuery["filters"]): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(filters)));
}

function decodeFilters(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const json = new TextDecoder().decode(fromBase64Url(raw));
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
