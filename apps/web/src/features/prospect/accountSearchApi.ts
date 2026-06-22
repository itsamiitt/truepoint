// accountSearchApi.ts — typed, authenticated calls to the COMPANY-level (accounts) advanced-search API
// (24/ADR-0035), the firmographic sibling of searchApi.ts. THE canonical account-search client: it is backed
// by the real contract in @leadwolf/types (`accountsSearch.ts`) and the real routes apps/api mounts at
// /api/v1/account-search. Reuses ApiError + toApiError from ./api. Reads the in-memory access token via
// fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. Accounts carry NO PII, so there
// is no reveal/mask seam here — just firmographic search + facets + suggest + count.
//
// Integration is complete: the local ./accountTypes stub has been removed and every account import now resolves
// to @leadwolf/types; the account hook reads page.accounts and uses the real sort enum
// (relevance | name_asc | headcount_desc | created_desc).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  AccountFacetCount,
  AccountFacetKey,
  AccountQuery,
  AccountSearchPage,
  AccountSuggestField,
} from "@leadwolf/types";
import { toApiError } from "./api";

/** One typeahead suggestion for an account field (value + display label + match count). */
export interface AccountSuggestion {
  value: string;
  displayLabel: string;
  count: number;
}

/** POST /account-search/search — filtered, keyset-paged firmographic results → { accounts, nextCursor }. */
export async function searchAccounts(query: AccountQuery): Promise<AccountSearchPage> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/account-search/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw await toApiError(res, "Account search failed");
  return (await res.json()) as AccountSearchPage;
}

/** POST /account-search/facets — live counts per firmographic facet for the current query (24 §5). */
export async function fetchAccountFacetCounts(
  query: AccountQuery,
  fields: AccountFacetKey[],
): Promise<AccountFacetCount[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/account-search/facets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, fields }),
  });
  if (!res.ok) throw await toApiError(res, "Account facet counts failed");
  return ((await res.json()) as { facets: AccountFacetCount[] }).facets;
}

/** GET /account-search/suggest — typeahead values drawn from the index (24 §3). `signal` cancels stale requests. */
export async function suggestAccountField(
  field: AccountSuggestField,
  prefix: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<AccountSuggestion[]> {
  const qs = new URLSearchParams({ field, prefix, limit: String(limit) });
  const res = await fetchWithAuth(`${API_BASE}/api/v1/account-search/suggest?${qs.toString()}`, {
    signal,
  });
  if (!res.ok) throw await toApiError(res, "Account suggest failed");
  return ((await res.json()) as { suggestions: AccountSuggestion[] }).suggestions;
}

/** POST /account-search/count — the TOTAL matching, workspace-visible accounts for the query (24 Phase-3). */
export async function countAccounts(query: AccountQuery): Promise<number> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/account-search/count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw await toApiError(res, "Account count failed");
  return ((await res.json()) as { total: number }).total;
}
