// searchApi.ts — typed, authenticated calls to the advanced-search API (24, ADR-0035): server-driven
// typeahead, filtered keyset search, and live facet counts. Reuses ApiError from ./api. This replaces the
// MVP "load list + filter client-side" path (see useContacts) with real server-side search.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ContactHit,
  ContactQuery,
  FacetCount,
  FacetKey,
  SearchPage,
  Suggestion,
} from "@leadwolf/types";
import { ApiError } from "./api";

async function toError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | ({ detail?: string; title?: string; code?: string } & Record<string, unknown>)
    | null;
  return new ApiError(
    body?.detail ?? body?.title ?? `${fallback} (${res.status})`,
    res.status,
    body?.code ?? "error",
    body ?? {},
  );
}

/** POST /search/contacts — filtered, keyset-paged masked results (24 §5/§6). */
export async function searchContacts(query: ContactQuery): Promise<SearchPage<ContactHit>> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/contacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw await toError(res, "Search failed");
  return (await res.json()) as SearchPage<ContactHit>;
}

/** GET /search/suggest — typeahead values drawn from the index (24 §3). `signal` cancels stale requests. */
export async function suggestField(
  field: FacetKey,
  prefix: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const qs = new URLSearchParams({ field, prefix, limit: String(limit) });
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/suggest?${qs.toString()}`, { signal });
  if (!res.ok) throw await toError(res, "Suggest failed");
  return ((await res.json()) as { suggestions: Suggestion[] }).suggestions;
}

/** POST /search/facets — live counts per facet for the current query (24 §5). */
export async function fetchFacetCounts(
  query: ContactQuery,
  fields: FacetKey[],
): Promise<FacetCount[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/facets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, fields }),
  });
  if (!res.ok) throw await toError(res, "Facet counts failed");
  return ((await res.json()) as { facets: FacetCount[] }).facets;
}
