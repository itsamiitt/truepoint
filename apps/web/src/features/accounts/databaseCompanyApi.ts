import { ApiError } from "@/features/prospect";
// databaseCompanyApi.ts — typed, authenticated calls to the GLOBAL company search (search-consolidation
// stage 2). Deliberately separate from the prospect slice's accountSearchApi.ts, which searches the
// workspace's own `accounts`: these return companies the workspace does NOT own, addressed by their
// registrable domain.
//
// The routes are behind DATABASE_COMPANY_SEARCH_ENABLED and 404 while it is off. That is not an error state
// — it is the honest "not enabled yet" the Accounts tab degrades to, so `isNotEnabled` lets the caller tell
// a dark backend apart from a real failure (the same distinction lib/maybeList draws for list endpoints).
import { fetchWithAuth } from "@/lib/authClient";
import { problemMessageFromBody } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type {
  DatabaseCompanyCountResult,
  DatabaseCompanyFacetCount,
  DatabaseCompanyQuery,
  DatabaseCompanySearchPage,
} from "@leadwolf/types";

async function toError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | ({ detail?: string; title?: string; code?: string } & Record<string, unknown>)
    | null;
  // problemMessage is the ONE RFC-9457 body→sentence reader (audit 32 · F4) — do not re-derive the
  // detail→title→fallback precedence here.
  return new ApiError(
    problemMessageFromBody(body, fallback, res.status),
    res.status,
    body?.code ?? "error",
    body ?? {},
  );
}

/** True when the failure is the feature gate being off rather than something going wrong. */
export function isCompanyDatabaseDisabled(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** POST /search/database/companies — one keyset page of the global company graph. */
export async function searchDatabaseCompanies(
  query: DatabaseCompanyQuery & { excludeOwned?: boolean },
  signal?: AbortSignal,
): Promise<DatabaseCompanySearchPage> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/database/companies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    signal,
  });
  if (!res.ok) throw await toError(res, "Could not search companies");
  return (await res.json()) as DatabaseCompanySearchPage;
}

/** POST /search/database/companies/count — the capped total for the same query. */
export async function countDatabaseCompanies(
  query: DatabaseCompanyQuery,
  signal?: AbortSignal,
): Promise<DatabaseCompanyCountResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/database/companies/count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    signal,
  });
  if (!res.ok) throw await toError(res, "Could not count companies");
  return (await res.json()) as DatabaseCompanyCountResult;
}

/** POST /search/database/companies/facets — live counts for the current query. */
export async function fetchDatabaseCompanyFacets(
  query: DatabaseCompanyQuery,
  fields: Array<"industry" | "hq_country" | "ownership_type">,
  signal?: AbortSignal,
): Promise<DatabaseCompanyFacetCount[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/database/companies/facets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, fields }),
    signal,
  });
  if (!res.ok) throw await toError(res, "Company facet counts failed");
  return ((await res.json()) as { facets: DatabaseCompanyFacetCount[] }).facets;
}
