// useDatabaseSearch.ts — the engine for the global Database grid (the platform-wide sibling of
// useProspectSearch / useAccountSearch). Same discipline: the URL is the source of truth (own params
// `dq`/`df` so all three scopes coexist), keyset pages accumulate in one useInfiniteQuery entry (so a late
// response can never overwrite a newer search), and the exact total comes from the count endpoint.
"use client";

import type { DatabaseFilter, DatabaseQuery, MaskedDatabasePerson } from "@leadwolf/types";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { countDatabase, searchDatabase } from "../databaseSearchApi";
import { prospectKeys } from "../keys";

const PAGE_SIZE = 25;

export function emptyDatabaseQuery(): DatabaseQuery {
  return { filters: [], limit: PAGE_SIZE };
}

function encodeFilters(filters: DatabaseFilter[]): string {
  return Buffer.from(JSON.stringify(filters), "utf8").toString("base64url");
}
function decodeFilters(raw: string | null): DatabaseFilter[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return Array.isArray(parsed) ? (parsed as DatabaseFilter[]) : [];
  } catch {
    return []; // a hand-mangled URL degrades to an empty query, never throws
  }
}

export function databaseQueryToParams(query: DatabaseQuery, into?: URLSearchParams) {
  const params = into ?? new URLSearchParams();
  if (query.text) params.set("dq", query.text);
  else params.delete("dq");
  if (query.filters.length > 0) params.set("df", encodeFilters(query.filters));
  else params.delete("df");
  return params;
}

export function paramsToDatabaseQuery(params: URLSearchParams): DatabaseQuery {
  return {
    text: params.get("dq") ?? undefined,
    filters: decodeFilters(params.get("df")),
    limit: PAGE_SIZE,
  };
}

export interface DatabaseSearch {
  query: DatabaseQuery;
  setQuery: (next: DatabaseQuery) => void;
  hits: MaskedDatabasePerson[];
  total: number | undefined;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

export function useDatabaseSearch({ enabled = true }: { enabled?: boolean } = {}): DatabaseSearch {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const query = useMemo(
    () => paramsToDatabaseQuery(new URLSearchParams(searchParams?.toString() ?? "")),
    [searchParams],
  );

  const setQuery = useCallback(
    (next: DatabaseQuery) => {
      const params = databaseQueryToParams(
        next,
        new URLSearchParams(searchParams?.toString() ?? ""),
      );
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const search = useInfiniteQuery({
    queryKey: prospectKeys.databaseSearch(query),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => searchDatabase({ ...query, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const count = useQuery({
    queryKey: prospectKeys.databaseCount(query),
    enabled,
    queryFn: () => countDatabase(query),
    staleTime: 30_000,
  });

  return {
    query,
    setQuery,
    hits: useMemo(() => search.data?.pages.flatMap((p) => p.hits) ?? [], [search.data]),
    total: count.data?.total,
    loading: search.isPending && enabled,
    error: search.error ? (search.error as Error).message : null,
    hasMore: search.hasNextPage,
    loadMore: () => void search.fetchNextPage(),
    reload: () => void search.refetch(),
  };
}
