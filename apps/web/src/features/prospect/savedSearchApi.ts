// savedSearchApi.ts — typed, authenticated calls to the saved-searches API (24 §8). A saved search persists
// the active ContactQuery blob; "applying" one is just feeding its `filters` back into useContactSearch
// (setText/setFilters) so the grid re-runs POST /search/contacts. Reuses ApiError from ./api.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { ContactQuery, SavedSearch, SavedSearchVisibility } from "@leadwolf/types";
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

/** GET /saved-searches — the searches visible to the caller (own private + all workspace). */
export async function listSavedSearches(): Promise<SavedSearch[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/saved-searches`);
  if (!res.ok) throw await toError(res, "Could not load saved searches");
  return ((await res.json()) as { searches: SavedSearch[] }).searches;
}

/** POST /saved-searches — persist the current filter set. */
export async function createSavedSearch(input: {
  name: string;
  filters: ContactQuery;
  visibility: SavedSearchVisibility;
}): Promise<SavedSearch> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/saved-searches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toError(res, "Could not save search");
  return (await res.json()) as SavedSearch;
}

/** PATCH /saved-searches/:id — rename / re-scope (owner-only; the server enforces it). */
export async function updateSavedSearch(
  id: string,
  patch: { name?: string; visibility?: SavedSearchVisibility },
): Promise<SavedSearch> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/saved-searches/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toError(res, "Could not update saved search");
  return (await res.json()) as SavedSearch;
}

/** DELETE /saved-searches/:id — owner-only delete (204 No Content). */
export async function deleteSavedSearch(id: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/saved-searches/${id}`, { method: "DELETE" });
  if (!res.ok) throw await toError(res, "Could not delete saved search");
}
