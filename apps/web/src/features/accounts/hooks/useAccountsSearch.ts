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

import { accountWorkspaceOnlyFields, useAccountSearch } from "@/features/prospect/entries/accounts";
import type { AccountQuery, DatabaseCompanyQuery, MaskedAccount } from "@leadwolf/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type AccountRow, mergeAccountRows, toDatabaseCompanyQuery } from "../accountRows";
import {
  countDatabaseCompanies,
  isCompanyDatabaseDisabled,
  searchDatabaseCompanies,
} from "../databaseCompanyApi";

const PAGE_SIZE = 50;

/** Stable identity so the merge memo does not re-run every render in "New to me" mode. */
const EMPTY_ACCOUNTS: MaskedAccount[] = [];

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
  /** The active workspace-only filter fields that caused the database half to be skipped (empty when it
   *  ran). The pane renders these as an explicit notice — the global half used to vanish in silence. */
  databaseDroppedFields: string[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

export interface UseAccountsSearchOptions {
  /** From the shell's workspace-scope control. "In workspace" turns the global half off entirely. */
  includeDatabase?: boolean;
  /** "New to me" turns the OWNED half off and asks the server to drop rows the workspace already holds. */
  excludeOwned?: boolean;
}

export function useAccountsSearch(options: UseAccountsSearchOptions = {}): AccountsSearch {
  const includeDatabase = options.includeDatabase ?? true;
  const excludeOwned = options.excludeOwned ?? false;
  const owned = useAccountSearch();

  // Skipped entirely when the query is inherently workspace-only (ICP score, technology, funding…) — and
  // the fields responsible come back with it, so the pane can say the global half was skipped instead of it
  // silently vanishing.
  const narrowing = useMemo(
    () => toDatabaseCompanyQuery(owned.query, PAGE_SIZE, accountWorkspaceOnlyFields(owned.query)),
    [owned.query],
  );
  const databaseQuery: DatabaseCompanyQuery | null = narrowing.query;

  const databaseSearch = useQuery({
    // excludeOwned is part of the KEY, not just the body: it changes which rows come back, so sharing a
    // cache entry between the two modes would serve one mode's page to the other.
    queryKey: ["search", "database", "companies", "results", databaseQuery, excludeOwned],
    enabled: includeDatabase && databaseQuery !== null,
    // Same no-blank treatment as the owned half: a filter edit keeps the previous database rows on screen
    // while the fresh search lands, instead of the merged grid losing its bottom half on every edit.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchDatabaseCompanies(
        { ...(databaseQuery as NonNullable<typeof databaseQuery>), excludeOwned },
        signal,
      ),
    staleTime: 30_000,
    // The gate being off is a 404, which is an ANSWER, not a failure — retrying it is pure waste.
    retry: (count, err) => !isCompanyDatabaseDisabled(err) && count < 2,
  });

  const databaseCountQuery = useQuery({
    queryKey: ["search", "database", "companies", "count", databaseQuery],
    enabled: includeDatabase && databaseQuery !== null && !databaseSearch.isError,
    queryFn: ({ signal }) =>
      countDatabaseCompanies(databaseQuery as NonNullable<typeof databaseQuery>, signal),
    staleTime: 120_000,
    retry: (count, err) => !isCompanyDatabaseDisabled(err) && count < 2,
  });

  // "New to me" drops the owned half entirely rather than filtering it out client-side: the server already
  // excluded owned rows from the global half, so keeping the owned engine running would contradict the
  // control the user just used AND pay for a search whose every row is about to be discarded.
  const ownedRows = excludeOwned ? EMPTY_ACCOUNTS : owned.accounts;

  const rows = useMemo(
    // The `databaseQuery !== null` guard is load-bearing — see the twin in useProspectSearch.
    // `keepPreviousData` keeps the last successful page on a query that is now DISABLED, so without it the
    // grid went on showing database companies from before a workspace-only filter was applied, under a
    // notice saying the database is not being searched.
    () =>
      mergeAccountRows(ownedRows, databaseQuery === null ? [] : (databaseSearch.data?.hits ?? [])),
    [ownedRows, databaseSearch.data, databaseQuery],
  );

  return {
    query: owned.query,
    setQuery: owned.setQuery,
    rows,
    databaseCount: rows.length - ownedRows.length,
    databaseTotal: databaseCountQuery.data?.total,
    databaseCapped: databaseCountQuery.data?.capped ?? false,
    databaseDisabled: isCompanyDatabaseDisabled(databaseSearch.error),
    databaseDroppedFields: narrowing.droppedFields,
    loading: owned.loading,
    // Only the OWNED half's failure is surfaced as an error. The global half contributing nothing is a
    // degraded result, not a broken screen — the same posture the People tab takes.
    error: owned.error,
    hasMore: owned.hasMore,
    loadMore: owned.loadMore,
    reload: owned.reload,
  };
}
