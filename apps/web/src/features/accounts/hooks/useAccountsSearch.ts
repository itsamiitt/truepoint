// useAccountsSearch.ts — the Accounts tab's engine (search-consolidation stage 2): the workspace's own
// accounts AND the global company graph in one list, the company twin of useProspectSearch.
//
// The two halves are SEPARATE queries on purpose. A slow or failed global search must never stall or break
// the workspace results — it simply contributes nothing — and while DATABASE_COMPANY_SEARCH_ENABLED is off
// the global routes 404 and the tab degrades to exactly what it showed before the cutover.
//
// Query state is URL-driven by the underlying useAccountSearch (`aq`/`asort`/`af`), so this hook adds no
// state of its own beyond the derived database query.
"use client";

import { useAccountSearch } from "@/features/prospect";
import type { AccountQuery, DatabaseCompanyQuery } from "@leadwolf/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type AccountRow, mergeAccountRows, toDatabaseCompanyQuery } from "../accountRows";
import {
  countDatabaseCompanies,
  isCompanyDatabaseDisabled,
  searchDatabaseCompanies,
} from "../databaseCompanyApi";

const PAGE_SIZE = 50;

export interface AccountsSearch {
  query: AccountQuery;
  setQuery: (next: AccountQuery) => void;
  /** Workspace accounts FIRST, then companies from the platform database the workspace does not hold. */
  rows: AccountRow[];
  /** How many of `rows` come from the platform database (not yet in the workspace). */
  databaseCount: number;
  /** The global population matching this query — capped; `databaseCapped` says the number is a floor. */
  databaseTotal: number | undefined;
  databaseCapped: boolean;
  /** True when the global half is switched off server-side (the gate), as opposed to failing. */
  databaseDisabled: boolean;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

export function useAccountsSearch(): AccountsSearch {
  const owned = useAccountSearch();

  // Skipped entirely when the query is inherently workspace-only (ICP score, technology, funding…).
  const databaseQuery: DatabaseCompanyQuery | null = useMemo(
    () => toDatabaseCompanyQuery(owned.query, PAGE_SIZE),
    [owned.query],
  );

  const databaseSearch = useQuery({
    queryKey: ["search", "database", "companies", "results", databaseQuery],
    enabled: databaseQuery !== null,
    // Same no-blank treatment as the owned half: a filter edit keeps the previous database rows on screen
    // while the fresh search lands, instead of the merged grid losing its bottom half on every edit.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchDatabaseCompanies(databaseQuery as NonNullable<typeof databaseQuery>, signal),
    staleTime: 30_000,
    // The gate being off is a 404, which is an ANSWER, not a failure — retrying it is pure waste.
    retry: (count, err) => !isCompanyDatabaseDisabled(err) && count < 2,
  });

  const databaseCountQuery = useQuery({
    queryKey: ["search", "database", "companies", "count", databaseQuery],
    enabled: databaseQuery !== null && !databaseSearch.isError,
    queryFn: ({ signal }) =>
      countDatabaseCompanies(databaseQuery as NonNullable<typeof databaseQuery>, signal),
    staleTime: 120_000,
    retry: (count, err) => !isCompanyDatabaseDisabled(err) && count < 2,
  });

  const rows = useMemo(
    () => mergeAccountRows(owned.accounts, databaseSearch.data?.hits ?? []),
    [owned.accounts, databaseSearch.data],
  );

  return {
    query: owned.query,
    setQuery: owned.setQuery,
    rows,
    databaseCount: rows.length - owned.accounts.length,
    databaseTotal: databaseCountQuery.data?.total,
    databaseCapped: databaseCountQuery.data?.capped ?? false,
    databaseDisabled: isCompanyDatabaseDisabled(databaseSearch.error),
    loading: owned.loading,
    // Only the OWNED half's failure is surfaced as an error. The global half contributing nothing is a
    // degraded result, not a broken screen — the same posture the People tab takes.
    error: owned.error,
    hasMore: owned.hasMore,
    loadMore: owned.loadMore,
    reload: owned.reload,
  };
}
