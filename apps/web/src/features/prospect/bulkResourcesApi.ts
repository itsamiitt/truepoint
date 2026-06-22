// bulkResourcesApi.ts — the read-side resource lookups the bulk-action menus need: the workspace's static
// lists (for "Add to list"), creating a new list inline ("Add to new list…"), and the workspace's sequences
// (for "Add to sequence"). These are NOT the bulk mutations themselves (those live in bulkActionsApi.ts, the
// backend's client) — they only fetch the option lists + create a list shell, so the bar can offer a real
// picker instead of a hard-coded id. Reuses fetchWithAuth (ADR-0016) + toApiError/ApiError from ./api; never
// touches the DB or auth origin directly.

import { fetchWithAuth, getAccessToken } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { List } from "@leadwolf/types";
import { toApiError } from "./api";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * The current caller's user id, decoded from the JWT access token's `sub` claim (the same id the API derives
 * server-side). Used only for the self-targeting "Assign to me" action; returns null if no/unparseable token
 * (the action is then hidden). Reads, never mutates — the authoritative owner-assignment policy is server-side.
 */
export function currentUserId(): string | null {
  const token = getAccessToken();
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub?: string;
    };
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

/** GET /lists — the workspace's static lists (id + name + memberCount) for the "Add to list" picker. */
export async function fetchLists(): Promise<List[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists`);
  if (!res.ok) throw await toApiError(res, "Could not load lists");
  const data = (await res.json()) as { lists: List[] };
  return data.lists;
}

/** POST /lists — create a list shell (201 → the new List). Powers "Add to new list…". */
export async function createList(name: string, description?: string): Promise<List> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(description ? { name, description } : { name }),
  });
  if (!res.ok) throw await toApiError(res, "Could not create list");
  return (await res.json()) as List;
}

/** A sequence option for the "Add to sequence" picker — id + name only (the bulk-enroll body needs the id). */
export interface SequenceOption {
  id: string;
  name: string;
}

/**
 * GET /outreach/sequences — the workspace's sequences for the "Add to sequence" picker. The full sequences
 * slice owns the rich SequenceSummary shape; the bulk bar only needs id + name, so this narrows the payload
 * here rather than importing across slices.
 */
export async function fetchSequenceOptions(): Promise<SequenceOption[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/outreach/sequences`);
  if (!res.ok) throw await toApiError(res, "Could not load sequences");
  const data = (await res.json()) as { sequences: { id: string; name: string }[] };
  return data.sequences.map((s) => ({ id: s.id, name: s.name }));
}
