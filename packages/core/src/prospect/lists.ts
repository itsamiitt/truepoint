// lists.ts — business logic for static prospect lists (24, bulk "add to list"). Lists are workspace-shared:
// every member can see them and add/remove members; rename/delete are OWNER-gated (only the creator), exactly
// like saved searches. Membership writes are cross-workspace-safe: contact ids are filtered to the subset the
// caller can actually see (RLS) before any link is written, so a member can never point at a foreign contact.
// Every operation composes a single withTenantTx so RLS scopes to the workspace; affected counts are returned
// so the UI can confirm "N added / N removed".

import { type ListRow, type TenantScope, listRepository, withTenantTx } from "@leadwolf/db";
import { type List, NotFoundError } from "@leadwolf/types";

/** The workspace-scoped caller context shared by every operation (scope + the verified user id). */
interface ListActor {
  scope: TenantScope & { workspaceId: string };
  callerUserId: string;
}

function toDto(row: ListRow, callerUserId: string): List {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerUserId: row.ownerUserId,
    isOwner: row.ownerUserId === callerUserId,
    memberCount: row.memberCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateListInput extends ListActor {
  name: string;
  description?: string;
}

/** Create a new (empty) list owned by the caller. */
export async function createList(input: CreateListInput): Promise<List> {
  return withTenantTx(input.scope, async (tx) => {
    const row = await listRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ownerUserId: input.callerUserId,
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
    });
    return toDto(row, input.callerUserId);
  });
}

/** List every list in the workspace (workspace-shared), newest-name-first, with live member counts. */
export async function listLists(actor: ListActor): Promise<List[]> {
  const rows = await listRepository.listByWorkspace(actor.scope);
  return rows.map((r) => toDto(r, actor.callerUserId));
}

export interface UpdateListInput extends ListActor {
  id: string;
  name?: string;
  description?: string | null;
}

/** Rename / re-describe a list. Owner-gated: a non-owned/absent id yields 404 (no existence leak). */
export async function updateList(input: UpdateListInput): Promise<List> {
  const patch: { name?: string; description?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined)
    patch.description = input.description === null ? null : input.description.trim();
  return withTenantTx(input.scope, async (tx) => {
    const row = await listRepository.updateOwned(tx, input.id, input.callerUserId, patch);
    if (!row) throw new NotFoundError("List not found.");
    return toDto(row, input.callerUserId);
  });
}

export interface DeleteListInput extends ListActor {
  id: string;
}

/** Delete a list (members cascade). Owner-gated like update; a non-owned/absent id yields 404. */
export async function deleteList(input: DeleteListInput): Promise<void> {
  return withTenantTx(input.scope, async (tx) => {
    const deleted = await listRepository.deleteOwned(tx, input.id, input.callerUserId);
    if (!deleted) throw new NotFoundError("List not found.");
  });
}

export interface AddToListInput extends ListActor {
  listId: string;
  contactIds: string[];
}

/** Result of a membership mutation — the affected count the UI confirms ("N added to <list>"). */
export interface ListMembershipResult {
  listId: string;
  affected: number;
}

/**
 * Add contacts to an existing list. The list must exist in the caller's workspace (else 404). Contact ids are
 * filtered to the workspace-visible subset before any link is written (cross-workspace safety), then inserted
 * idempotently — so re-adding members is a no-op and `affected` is the count of NEW members.
 */
export async function addContactsToList(input: AddToListInput): Promise<ListMembershipResult> {
  return withTenantTx(input.scope, async (tx) => {
    const found = await listRepository.findById(tx, input.listId);
    if (!found) throw new NotFoundError("List not found.");
    const visible = await listRepository.visibleContactIds(tx, input.contactIds);
    const affected = await listRepository.addMembers(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      listId: input.listId,
      addedByUserId: input.callerUserId,
      contactIds: visible,
    });
    return { listId: input.listId, affected };
  });
}

export interface AddToNewListInput extends ListActor {
  name: string;
  description?: string;
  contactIds: string[];
}

/** Create a list on the spot and add the selection to it in one transaction (the "add to new list" action). */
export async function addContactsToNewList(
  input: AddToNewListInput,
): Promise<{ list: List; affected: number }> {
  return withTenantTx(input.scope, async (tx) => {
    const row = await listRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ownerUserId: input.callerUserId,
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
    });
    const visible = await listRepository.visibleContactIds(tx, input.contactIds);
    const affected = await listRepository.addMembers(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      listId: row.id,
      addedByUserId: input.callerUserId,
      contactIds: visible,
    });
    return { list: toDto({ ...row, memberCount: affected }, input.callerUserId), affected };
  });
}

export interface RemoveFromListInput extends ListActor {
  listId: string;
  contactIds: string[];
}

/** Remove contacts from a list. Returns the removed count. Workspace-scoped via RLS. */
export async function removeContactsFromList(
  input: RemoveFromListInput,
): Promise<ListMembershipResult> {
  return withTenantTx(input.scope, async (tx) => {
    const found = await listRepository.findById(tx, input.listId);
    if (!found) throw new NotFoundError("List not found.");
    const affected = await listRepository.removeMembers(tx, input.listId, input.contactIds);
    return { listId: input.listId, affected };
  });
}
