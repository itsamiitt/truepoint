// api.ts — the lists slice's data access: typed, authenticated calls to apps/api for the workspace's static
// lists (list/create/rename/delete) and a list's MASKED members (keyset-paged). Reads the in-memory access
// token via fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. The slice's only seam
// to the backend. Reuses the prospect slice's ApiError/toApiError (RFC-9457 Problem Details) so failures carry
// the stable machine `code` + status. Membership writes (add/remove) reuse the prospect bulk client, not this
// file — this file is the lists-domain reads + the list CRUD the lists surface owns.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { List, ListMembersPage } from "@leadwolf/types";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * A backend error mapped to its RFC-9457 Problem Details (09 §6): the stable machine `code` + status, so a
 * caller can branch on the failure mode (e.g. 409 name-taken). Self-contained in the slice — a cross-feature
 * deep import into the prospect slice's ApiError would violate the import-boundary rules (no-cross-feature-import).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extensions: Record<string, unknown>;

  constructor(message: string, status: number, code: string, extensions: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extensions = extensions;
  }
}

/** Parse a non-OK response's Problem Details into an ApiError (mirrors the prospect/import slice helpers). */
async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | ({ detail?: string; title?: string; code?: string } & Record<string, unknown>)
    | null;
  const message = body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
  return new ApiError(message, res.status, body?.code ?? "error", body ?? {});
}

/** GET /lists — every list in the active workspace (workspace-shared), with live member counts + isOwner. */
export async function fetchLists(): Promise<List[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists`);
  if (!res.ok) throw await toApiError(res, "Could not load lists");
  return ((await res.json()) as { lists: List[] }).lists;
}

/** POST /lists — create an (empty) list. 409 (name taken in the workspace) surfaces as an ApiError. */
export async function createList(name: string, description?: string): Promise<List> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(description ? { name, description } : { name }),
  });
  if (!res.ok) throw await toApiError(res, "Could not create list");
  return (await res.json()) as List;
}

/** PATCH /lists/:id — rename / re-describe a list (owner-only server-side; a non-owned id 404s). */
export async function updateList(
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<List> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toApiError(res, "Could not update list");
  return (await res.json()) as List;
}

/** DELETE /lists/:id — delete a list (owner-only server-side; members cascade). 204 → no body. */
export async function deleteList(id: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists/${id}`, { method: "DELETE" });
  if (!res.ok) throw await toApiError(res, "Could not delete list");
}

/**
 * GET /lists/:id/members — one keyset page of a list's MASKED members (no PII; email domain only, phone
 * locked), newest-added-first. A foreign/absent list id 404s server-side. Pass the prior page's `nextCursor`
 * to advance. Reveal is the only de-masking path; this read never returns raw PII.
 */
export async function fetchListMembers(
  id: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ListMembersPage> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists/${id}/members${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw await toApiError(res, "Could not load list members");
  return (await res.json()) as ListMembersPage;
}

/**
 * DELETE /lists/:id/members — remove the given contacts from a list (bulk). Workspace-scoped server-side;
 * returns the affected (removed) count. The membership ADD path reuses the prospect bulk client; remove is
 * lists-owned because only the list surface offers it.
 */
export async function removeContactsFromList(
  listId: string,
  contactIds: string[],
): Promise<{ listId: string; affected: number }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists/${listId}/members`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ contactIds }),
  });
  if (!res.ok) throw await toApiError(res, "Could not remove from list");
  return (await res.json()) as { listId: string; affected: number };
}

/** Find a single list by id from the workspace list (the detail header reads its metadata). null if absent. */
export async function fetchList(id: string): Promise<List | null> {
  const lists = await fetchLists();
  return lists.find((l) => l.id === id) ?? null;
}
