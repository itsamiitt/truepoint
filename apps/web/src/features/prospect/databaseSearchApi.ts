// databaseSearchApi.ts — typed, authenticated calls to the GLOBAL database search (Layer-0-as-database
// slice 2) and the reveal-as-save verb (decisions.md 2026-08-25). The database surface is deliberately
// separate from searchApi.ts: it returns people the workspace does NOT own, addressed by their public
// LinkedIn slug. There is no "add to workspace" call here any more — the reveal IS the save gesture.
import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ContactRevealFromDatabaseResponse,
  DatabaseCountResult,
  DatabaseQuery,
  DatabaseSearchPage,
  RevealType,
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

/**
 * POST /contacts/from-database/reveal — reveal IS the save gesture: materialize the database person into the
 * workspace AND reveal one channel in ONE request [S-06][S-04]. A fresh Idempotency-Key per attempt means a
 * network retry replays the same charge instead of double-spending (07 §3), exactly like revealContact. On a
 * 402/403 the problem's `contactId` extension says the person was nevertheless saved.
 */
export async function revealFromDatabase(
  linkedinPublicId: string,
  revealType: RevealType,
): Promise<ContactRevealFromDatabaseResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/from-database/reveal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ linkedinPublicId, reveal_type: revealType }),
  });
  if (!res.ok) throw await toError(res, "Could not reveal this person");
  return (await res.json()) as ContactRevealFromDatabaseResponse;
}
