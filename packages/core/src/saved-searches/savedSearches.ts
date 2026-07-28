// savedSearches.ts — business logic for saved searches / segments (M8, 24 §8). Validates the persisted
// filter blob against the `contactQuery` Zod schema ON SAVE (a malformed filter set can never be stored),
// enforces owner-gated mutations (rename/delete), and honours private-vs-workspace visibility on list. The
// blob is re-applied by the client re-running POST /search/contacts — this layer never runs raw SQL and never
// re-models the filter shape. All four operations compose a single withTenantTx so RLS scopes to the
// workspace. Audit-free by design (saved searches aren't on the closed 08 §5 audit-action enum).

import {
  type SavedSearchRow,
  type TenantScope,
  savedSearchRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type ContactQuery,
  NotFoundError,
  type SavedSearch,
  type SavedSearchVisibility,
  ValidationError,
  contactQuery,
} from "@leadwolf/types";

/** The workspace-scoped caller context shared by every operation (scope + the verified user id). */
interface SavedSearchActor {
  scope: TenantScope & { workspaceId: string };
  callerUserId: string;
}

/** Map a stored row to the API DTO, stamping `isOwner` for the requesting caller (drives rename/delete UI). */
function toDto(row: SavedSearchRow, callerUserId: string): SavedSearch {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    isOwner: row.ownerUserId === callerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateSavedSearchInput extends SavedSearchActor {
  name: string;
  /** The filter set from the prospect rail — RE-VALIDATED here against contactQuery before it is stored. */
  filters: unknown;
  visibility: SavedSearchVisibility;
}

/**
 * Persist a saved search. The filter blob is validated against `contactQuery` (search.ts) first: an invalid
 * filter set is rejected with a 422 ValidationError and never written. The stored, normalized query is what
 * gets re-applied later.
 */
export async function createSavedSearch(input: CreateSavedSearchInput): Promise<SavedSearch> {
  const parsed = contactQuery.safeParse(input.filters);
  if (!parsed.success) {
    throw new ValidationError("Saved-search filters are not a valid search query.");
  }
  const filters: ContactQuery = parsed.data;

  return withTenantTx(input.scope, async (tx) => {
    const row = await savedSearchRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ownerUserId: input.callerUserId,
      name: input.name.trim(),
      filters,
      visibility: input.visibility,
    });
    return toDto(row, input.callerUserId);
  });
}

/** List the saved searches the caller may see in the workspace: all workspace-visible + the caller's private. */
export async function listSavedSearches(actor: SavedSearchActor): Promise<SavedSearch[]> {
  return withTenantTx(actor.scope, async (tx) => {
    const rows = await savedSearchRepository.listVisible(tx, actor.callerUserId);
    return rows.map((r) => toDto(r, actor.callerUserId));
  });
}

export interface UpdateSavedSearchInput extends SavedSearchActor {
  id: string;
  name?: string;
  visibility?: SavedSearchVisibility;
}

/**
 * Rename / re-scope a saved search. Owner-gated: only the creator can mutate it, even when it is workspace-
 * visible. A row that isn't found in the workspace (RLS) OR isn't owned by the caller yields 404 — we don't
 * distinguish "not yours" from "doesn't exist" to avoid leaking the existence of others' private rows.
 */
export async function updateSavedSearch(input: UpdateSavedSearchInput): Promise<SavedSearch> {
  const patch: { name?: string; visibility?: SavedSearchVisibility } = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.visibility !== undefined) patch.visibility = input.visibility;

  return withTenantTx(input.scope, async (tx) => {
    const row = await savedSearchRepository.updateOwned(tx, input.id, input.callerUserId, patch);
    if (!row) throw new NotFoundError("Saved search not found.");
    return toDto(row, input.callerUserId);
  });
}

export interface DeleteSavedSearchInput extends SavedSearchActor {
  id: string;
}

/** Delete a saved search. Owner-gated like update; a non-owned/absent id yields 404 (no existence leak). */
export async function deleteSavedSearch(input: DeleteSavedSearchInput): Promise<void> {
  return withTenantTx(input.scope, async (tx) => {
    const deleted = await savedSearchRepository.deleteOwned(tx, input.id, input.callerUserId);
    if (!deleted) throw new NotFoundError("Saved search not found.");
  });
}
