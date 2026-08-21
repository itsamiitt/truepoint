// databaseProfileApi.ts — typed calls to the two GLOBAL profile routes (search-consolidation stage 3).
//
// Both are behind DATABASE_PROFILE_ENABLED and 404 while it is off, and a person/company that fails the
// visibility predicate ALSO 404s — deliberately indistinguishable, so the response shape is not an
// enumeration oracle. The client therefore cannot tell "gate off" from "no such profile" and must not try:
// both render the same "profile unavailable" state.
import { ApiError } from "@/features/prospect/entries/accounts";
import { fetchWithAuth } from "@/lib/authClient";
import { problemMessageFromBody } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { DatabaseCompanyProfile, DatabasePersonProfile } from "@leadwolf/types";

async function toError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | ({ detail?: string; title?: string; code?: string } & Record<string, unknown>)
    | null;
  return new ApiError(
    problemMessageFromBody(body, fallback, res.status),
    res.status,
    body?.code ?? "error",
    body ?? {},
  );
}

/** GET /search/database/people/:slug — the full masked Layer-0 person profile. */
export async function fetchDatabasePersonProfile(
  slug: string,
  signal?: AbortSignal,
): Promise<DatabasePersonProfile> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/search/database/people/${encodeURIComponent(slug)}`,
    { signal },
  );
  if (!res.ok) throw await toError(res, "Could not load this profile");
  return (await res.json()) as DatabasePersonProfile;
}

/** GET /search/database/companies/:domain — the company twin. */
export async function fetchDatabaseCompanyProfile(
  domain: string,
  signal?: AbortSignal,
): Promise<DatabaseCompanyProfile> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/search/database/companies/${encodeURIComponent(domain)}`,
    { signal },
  );
  if (!res.ok) throw await toError(res, "Could not load this company");
  return (await res.json()) as DatabaseCompanyProfile;
}
