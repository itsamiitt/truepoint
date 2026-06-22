// bulkActionsApi.ts — typed, authenticated calls to the Phase-3 bulk-action API (24): owner assign/reassign,
// bulk tags (add/remove), bulk status, bulk archive, bulk enroll, bulk enrich, role-gated CSV export, plus the
// select-all-across-search count. Reuses fetchWithAuth (in-memory access token, ADR-0016) + ApiError from ./api.
// The slice's only seam to the bulk backend — never touches the DB or auth origin directly.
//
// Selection contract: every mutation targets EITHER an explicit `contactIds` list OR a `criteria` ContactQuery
// (select-all-across-search). The shared `BulkSelection` type carries exactly one of them; the server resolves a
// `criteria` to workspace-visible ids and caps it. The export wrapper returns a Blob (text/csv), not JSON.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  BulkAffected,
  BulkEnrollResult,
  BulkSelection,
  ContactQuery,
  OutreachStatus,
  SearchCountResult,
} from "@leadwolf/types";
import { ApiError, toApiError } from "./api";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Merge the shared selection envelope with op-specific fields into one request body. */
function body<T extends object>(selection: BulkSelection, extra?: T): string {
  return JSON.stringify({ ...selection, ...(extra ?? {}) });
}

// ── 1. Assign / reassign owner ─────────────────────────────────────────────────────────────────────────
/** POST /contacts/bulk/assign-owner — set the soft owner (or null to clear). Returns { affected }. */
export async function bulkAssignOwner(
  selection: BulkSelection,
  ownerUserId: string | null,
): Promise<BulkAffected> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/bulk/assign-owner`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(selection, { ownerUserId }),
  });
  if (!res.ok) throw await toApiError(res, "Could not assign owner");
  return (await res.json()) as BulkAffected;
}

// ── 2. Add / remove tags ───────────────────────────────────────────────────────────────────────────────
/** POST /contacts/bulk/tags — add one or more tags to the selection. Returns { affected }. */
export async function bulkAddTags(
  selection: BulkSelection,
  tagIds: string[],
): Promise<BulkAffected> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/bulk/tags`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(selection, { tagIds }),
  });
  if (!res.ok) throw await toApiError(res, "Could not add tags");
  return (await res.json()) as BulkAffected;
}

/** DELETE /contacts/bulk/tags — remove one or more tags from the selection. Returns { affected }. */
export async function bulkRemoveTags(
  selection: BulkSelection,
  tagIds: string[],
): Promise<BulkAffected> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/bulk/tags`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: body(selection, { tagIds }),
  });
  if (!res.ok) throw await toApiError(res, "Could not remove tags");
  return (await res.json()) as BulkAffected;
}

// ── 3. Change status ────────────────────────────────────────────────────────────────────────────────────
/** POST /contacts/bulk/status — set outreach_status for the selection. Returns { affected }. */
export async function bulkChangeStatus(
  selection: BulkSelection,
  outreachStatus: OutreachStatus,
): Promise<BulkAffected> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/bulk/status`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(selection, { outreachStatus }),
  });
  if (!res.ok) throw await toApiError(res, "Could not change status");
  return (await res.json()) as BulkAffected;
}

// ── 4. Archive (soft hide) ─────────────────────────────────────────────────────────────────────────────
/** POST /contacts/bulk/archive — soft-archive (hide) the selection. Returns { affected }. */
export async function bulkArchive(selection: BulkSelection): Promise<BulkAffected> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/bulk/archive`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(selection),
  });
  if (!res.ok) throw await toApiError(res, "Could not archive contacts");
  return (await res.json()) as BulkAffected;
}

// ── 5. Add to list ──────────────────────────────────────────────────────────────────────────────────────
/**
 * POST /lists/:id/members — add the selected contacts to an existing list (idempotent server-side). The lists
 * endpoint takes an explicit { contactIds } body (no `criteria` branch), so this wrapper accepts the id list
 * directly. Returns { listId, affected }.
 */
export async function bulkAddToList(
  listId: string,
  contactIds: string[],
): Promise<{ listId: string; affected: number }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists/${listId}/members`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ contactIds }),
  });
  if (!res.ok) throw await toApiError(res, "Could not add to list");
  return (await res.json()) as { listId: string; affected: number };
}

// ── 6. Enroll into a sequence ──────────────────────────────────────────────────────────────────────────
/**
 * POST /outreach/sequences/:id/enroll-bulk — enroll the selection into a sequence (idempotent per contact).
 * Returns { affected, enrolled, alreadyEnrolled, skipped }.
 */
export async function bulkEnroll(
  sequenceId: string,
  selection: BulkSelection,
): Promise<BulkEnrollResult> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/outreach/sequences/${sequenceId}/enroll-bulk`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: body(selection),
    },
  );
  if (!res.ok) throw await toApiError(res, "Could not enroll contacts");
  return (await res.json()) as BulkEnrollResult;
}

// ── 7. Enrich / re-verify ──────────────────────────────────────────────────────────────────────────────
/**
 * POST /contacts/bulk/enrich — enqueue a re-enrich/re-verify job for the selection. Returns { affected, jobId };
 * poll the job via the enrichment job-status surface.
 */
export async function bulkEnrich(
  selection: BulkSelection,
): Promise<{ affected: number; jobId: string }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/bulk/enrich`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(selection),
  });
  if (!res.ok) throw await toApiError(res, "Could not start enrichment");
  return (await res.json()) as { affected: number; jobId: string };
}

// ── 8. CSV export (role-gated) ──────────────────────────────────────────────────────────────────────────
/** The CSV export result: the file Blob (text/csv) + the row count the server reports via x-affected-count. */
export interface BulkExportResult {
  blob: Blob;
  affected: number;
  filename: string;
}

/**
 * POST /contacts/bulk/export — download the MASKED (non-PII) columns for the selection as CSV. Role-gated
 * server-side: a viewer gets 403 (surfaced as an ApiError with code "insufficient_role"). Returns the Blob +
 * the affected count + a suggested filename, so the caller can trigger a browser download.
 */
export async function bulkExportCsv(selection: BulkSelection): Promise<BulkExportResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/bulk/export`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body(selection),
  });
  if (!res.ok) throw await toApiError(res, "Could not export contacts");
  const blob = await res.blob();
  const affected = Number(res.headers.get("x-affected-count") ?? "0") || 0;
  const filename =
    /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
    `contacts-export-${affected}.csv`;
  return { blob, affected, filename };
}

// ── 9. Select-all-across-search count ────────────────────────────────────────────────────────────────────
/**
 * POST /search/count — the TOTAL matching, workspace-visible contacts for a query (powers "Select all N
 * results"). Same filters/owner-scoping as the search grid.
 */
export async function searchCount(query: ContactQuery): Promise<SearchCountResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/search/count`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(query),
  });
  if (!res.ok) throw await toApiError(res, "Could not count results");
  return (await res.json()) as SearchCountResult;
}

export { ApiError };
