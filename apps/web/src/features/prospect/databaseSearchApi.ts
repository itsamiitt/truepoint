// databaseSearchApi.ts — typed, authenticated calls to the GLOBAL database search (Layer-0-as-database
// slice 2) and the "Add to workspace" verb. The database surface is deliberately separate from
// searchApi.ts: it returns people the workspace does NOT own, addressed by their public LinkedIn slug.
import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ContactFromDatabaseResponse,
  DatabaseCountResult,
  DatabaseQuery,
  DatabaseSearchPage,
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

/** POST /search/database — one keyset page of the platform database. */
export async function searchDatabase(
  query: DatabaseQuery,
  signal?: AbortSignal,
): Promise<DatabaseSearchPage> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/database`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    signal,
  });
  if (!res.ok) throw await toError(res, "Could not search the database");
  return (await res.json()) as DatabaseSearchPage;
}

/** POST /search/database/count — the exact total for the same query. */
export async function countDatabase(query: DatabaseQuery): Promise<DatabaseCountResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/database/count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw await toError(res, "Could not count database results");
  return (await res.json()) as DatabaseCountResult;
}

/** POST /contacts/from-database — materialize a database person into the workspace. */
export async function addFromDatabase(
  linkedinPublicId: string,
): Promise<ContactFromDatabaseResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/from-database`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ linkedinPublicId }),
  });
  if (!res.ok) throw await toError(res, "Could not add this contact");
  return (await res.json()) as ContactFromDatabaseResponse;
}
