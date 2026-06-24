// lists.ts — business logic for prospect lists (24, bulk "add to list"). Lists are workspace-shared: every
// member can see them and add/remove members; rename/delete are OWNER-gated (only the creator), exactly like
// saved searches. Membership writes are cross-workspace-safe: contact ids are filtered to the subset the caller
// can actually see (RLS) before any link is written, so a member can never point at a foreign contact. Every
// operation composes a single withTenantTx so RLS scopes to the workspace; affected counts are returned so the
// UI can confirm "N added / N removed".
//
// A list is STATIC (explicit `list_members` rows — the curated snapshot) or DYNAMIC (Phase 4 — membership is
// derived on read by running the list's saved ContactQuery through the search path; nothing is materialized).
// Two invariants make dynamic lists safe: (1) at create time the client-supplied savedSearchId is RE-VALIDATED
// under the caller's RLS tx (a foreign/absent id is rejected — the FK is NOT a workspace guard); (2) every
// dynamic read runs the query under withTenantTx so RLS bounds it to the workspace and the masked projection
// guarantees no PII (reveal stays the only de-masking path). Explicit member mutations on a dynamic list are
// rejected — its membership is query-derived, not curated.

import {
  type ListMembersResultPage,
  type ListRow,
  type TenantScope,
  type Tx,
  listRepository,
  savedSearchRepository,
  searchRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type ContactQuery,
  type List,
  type MaskedContact,
  NotFoundError,
  ValidationError,
  contactQuery,
} from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { expandTitleFilters } from "../search/expandTitleFilters.ts";

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
    kind: row.kind,
    savedSearchId: row.savedSearchId,
    memberCount: row.memberCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Cap on a dynamic list's read page — mirrors the search/members page bound (search ContactQuery.limit max). */
const DYNAMIC_PAGE_MAX = 200;

/**
 * Resolve ONE keyset page of a dynamic list's members by running its saved ContactQuery through the search path,
 * INSIDE the caller's existing withTenantTx (so RLS is the boundary and there's no cross-tx visibility gap). The
 * saved blob is re-parsed against `contactQuery` defensively (a saved search is validated on save, but a dynamic
 * list could outlive a schema change), title clauses are canon-expanded to match the grid, and `limit`/`cursor`
 * are forced from the members-read paging contract (the stored blob's own paging is ignored). Same MASKED shape
 * + opaque cursor as the static path. A missing/empty backing query yields an empty page (graceful — see the
 * coherence note in createDynamicList). */
async function resolveDynamicMembers(
  tx: Tx,
  filters: unknown,
  limit: number,
  cursor: string | null,
): Promise<ListMembersResultPage> {
  const parsed = contactQuery.safeParse(filters);
  if (!parsed.success) return { members: [], nextCursor: null };
  const query: ContactQuery = expandTitleFilters({
    ...parsed.data,
    limit: Math.min(limit, DYNAMIC_PAGE_MAX),
    cursor: cursor ?? undefined,
  });
  const page = await searchRepository.searchContactsTx(tx, query);
  return { members: page.hits, nextCursor: page.nextCursor };
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
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.callerUserId,
      action: "list.create",
      entityType: "list",
      entityId: row.id,
      metadata: { name: row.name },
    });
    return toDto(row, input.callerUserId);
  });
}

export interface CreateDynamicListInput extends ListActor {
  name: string;
  description?: string;
  /** The CLIENT-supplied saved-search id. NEVER trusted — re-validated under the caller's RLS tx below. */
  savedSearchId: string;
}

/**
 * Create a DYNAMIC list backed by a saved search (Phase 4). SECURITY (mandatory, list-plan/02 §2.1 + the
 * schema/lists.ts comment): the `savedSearchId` is resolved under the caller's withTenantTx via the RLS-scoped
 * savedSearchRepository.findById BEFORE the link is persisted — a foreign/absent/not-visible id resolves to
 * null and is REJECTED (NotFoundError → 404, no existence leak). The FK on lists.saved_search_id only proves
 * the row exists, not that it is co-tenant (FK checks bypass RLS), so this app-layer check IS the workspace
 * boundary — exactly as visibleContactIds is for static members. The validate + insert share one tx so the
 * link can never reference a search the caller couldn't see at create time. `source='search'` records the
 * provenance; the DB coherence check backstops dynamic ⇔ savedSearchId IS NOT NULL.
 */
export async function createDynamicList(input: CreateDynamicListInput): Promise<List> {
  return withTenantTx(input.scope, async (tx) => {
    const saved = await savedSearchRepository.findById(tx, input.savedSearchId, input.callerUserId);
    if (!saved) throw new NotFoundError("Saved search not found.");
    const row = await listRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ownerUserId: input.callerUserId,
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
      kind: "dynamic",
      savedSearchId: saved.id,
      source: "search",
    });
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.callerUserId,
      action: "list.create",
      entityType: "list",
      entityId: row.id,
      metadata: { name: row.name, listKind: "dynamic", source: "search" },
    });
    // The freshly-created dynamic list's count = its query's live match total (resolved in the same tx).
    const count = await searchRepository.countContactsTx(
      tx,
      expandTitleFilters(contactQuery.parse(saved.filters)),
    );
    return toDto({ ...row, memberCount: count }, input.callerUserId);
  });
}

/**
 * List every list in the workspace (workspace-shared), newest-name-first, with live member counts. Static lists
 * carry their stored `list_members` count; a DYNAMIC list's count is its saved query's live match total, so we
 * resolve those in the SAME tx (the dynamic subset is small per workspace — Phase 4 ships resolve-on-open;
 * materialization + a refresh worker are the documented follow-up, list-plan/09 Phase 4). A dynamic list with a
 * missing/invalid backing query degrades to a 0 count rather than failing the whole index.
 */
export async function listLists(actor: ListActor): Promise<List[]> {
  return withTenantTx(actor.scope, async (tx) => {
    const rows = await listRepository.listByWorkspaceTx(tx);
    const out: List[] = [];
    for (const r of rows) {
      if (r.kind !== "dynamic" || !r.savedSearchId) {
        out.push(toDto(r, actor.callerUserId));
        continue;
      }
      const saved = await savedSearchRepository.findById(tx, r.savedSearchId, actor.callerUserId);
      const parsed = saved ? contactQuery.safeParse(saved.filters) : null;
      const count =
        parsed?.success === true
          ? await searchRepository.countContactsTx(tx, expandTitleFilters(parsed.data))
          : 0;
      out.push(toDto({ ...r, memberCount: count }, actor.callerUserId));
    }
    return out;
  });
}

export interface ListMembersInput extends ListActor {
  listId: string;
  limit: number;
  cursor?: string;
}

/** One keyset page of a list's MASKED members (no PII). The masked, paginated read-path member type. */
export type ListMember = MaskedContact;

/**
 * Read a list's members — masked (email domain only, phone locked), keyset-paged, newest-added-first. The list
 * must exist in the caller's workspace (else 404, no existence leak — exactly like updateList/addContactsToList);
 * the client-supplied list id is never trusted, it is re-scoped to the workspace under RLS. Both the existence
 * check and the member read run inside ONE withTenantTx so RLS is the hard boundary for both. Reveal stays the
 * only de-masking path — this read NEVER returns raw PII.
 *
 * STATIC list → read the explicit `list_members` join (unchanged). DYNAMIC list → resolve membership by running
 * the list's saved ContactQuery through the search path in the SAME tx (workspace-scoped via RLS, masked,
 * keyset-paged). Both branches return the identical masked shape + opaque cursor, so the members table reuses
 * the prospect grid verbatim either way. A dynamic list whose saved search is gone/invalid yields an empty page.
 */
export async function listListMembers(
  input: ListMembersInput,
): Promise<{ members: ListMember[]; nextCursor: string | null }> {
  return withTenantTx(input.scope, async (tx): Promise<ListMembersResultPage> => {
    const found = await listRepository.findById(tx, input.listId);
    if (!found) throw new NotFoundError("List not found.");
    if (found.kind === "dynamic") {
      if (!found.savedSearchId) return { members: [], nextCursor: null };
      const saved = await savedSearchRepository.findById(
        tx,
        found.savedSearchId,
        input.callerUserId,
      );
      if (!saved) return { members: [], nextCursor: null };
      return resolveDynamicMembers(tx, saved.filters, input.limit, input.cursor ?? null);
    }
    return listRepository.listMembers(tx, input.listId, input.limit, input.cursor ?? null);
  });
}

export interface AssertListInput {
  scope: TenantScope & { workspaceId: string };
  listId: string;
}

/**
 * Assert a list exists in the caller's workspace — the trust-boundary guard for the "import into list" path
 * (list-plan/03 §2.2). The client-supplied list id is never trusted (list-plan D4): findById is RLS-scoped to
 * the workspace, so a foreign/absent id throws NotFoundError (→ a clean 404 at the API edge, before an import
 * is enqueued, rather than a dead-lettered job later). Read-only; same guard `addContactsToList` uses.
 */
export async function assertListInWorkspace(input: AssertListInput): Promise<void> {
  const found = await withTenantTx(input.scope, (tx) => listRepository.findById(tx, input.listId));
  if (!found) throw new NotFoundError("List not found.");
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
    // Audit only a real change. An empty patch (no name/description) is a no-op — the API's zod refine already
    // requires a field, so this just guards a direct core caller from a spurious `list.update` row. Mirrors the
    // `affected > 0` guard on the membership paths. (updateOwned ran first so ownership is still enforced.)
    if (Object.keys(patch).length > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "list.update",
        entityType: "list",
        entityId: row.id,
        metadata: { fields: Object.keys(patch) },
      });
    }
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
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.callerUserId,
      action: "list.delete",
      entityType: "list",
      entityId: input.id,
    });
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
    if (found.kind === "dynamic")
      throw new ValidationError(
        "Cannot add members to a dynamic list — its membership is defined by its saved search.",
      );
    const visible = await listRepository.visibleContactIds(tx, input.contactIds);
    const affected = await listRepository.addMembers(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      listId: input.listId,
      addedByUserId: input.callerUserId,
      contactIds: visible,
    });
    if (affected > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "member.add",
        entityType: "list",
        entityId: input.listId,
        metadata: { affected },
      });
    }
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
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.callerUserId,
      action: "list.create",
      entityType: "list",
      entityId: row.id,
      metadata: { name: row.name },
    });
    const visible = await listRepository.visibleContactIds(tx, input.contactIds);
    const affected = await listRepository.addMembers(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      listId: row.id,
      addedByUserId: input.callerUserId,
      contactIds: visible,
    });
    if (affected > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "member.add",
        entityType: "list",
        entityId: row.id,
        metadata: { affected },
      });
    }
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
    if (found.kind === "dynamic")
      throw new ValidationError(
        "Cannot remove members from a dynamic list — its membership is defined by its saved search.",
      );
    const affected = await listRepository.removeMembers(tx, input.listId, input.contactIds);
    if (affected > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "member.remove",
        entityType: "list",
        entityId: input.listId,
        metadata: { affected },
      });
    }
    return { listId: input.listId, affected };
  });
}
