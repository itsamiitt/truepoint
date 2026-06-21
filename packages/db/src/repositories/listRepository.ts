// listRepository.ts — data access for static prospect lists (`lists` + `list_members`, 24 bulk add-to-list).
// The ONLY data layer for lists: every method is tx-aware (composed inside one withTenantTx by the core
// layer) so RLS scopes the rows to the active workspace. Two guarantees live here:
//   • visibility — lists are workspace-shared (every member sees them); mutations gate on owner in core.
//   • cross-workspace safety — addMembers only ever links contacts the caller can actually see (RLS),
//     so a member can never point at another workspace's contact even though FK checks bypass RLS.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contacts } from "../schema/contacts.ts";
import { listMembers, lists } from "../schema/lists.ts";

/** A list row with its live membership count — the list/governance view-model. */
export interface ListRow {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The values a create needs (workspace + owner come from the verified caller context). */
export interface ListInsert {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  description?: string | null;
}

export interface AddMembersInput {
  tenantId: string;
  workspaceId: string;
  listId: string;
  addedByUserId: string | null;
  contactIds: string[];
}

function toRow(r: typeof lists.$inferSelect, memberCount: number): ListRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ownerUserId: r.ownerUserId,
    memberCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const listRepository = {
  /** Insert a new (empty) list; returns the persisted row. RLS pins it to the active workspace. */
  async insert(tx: Tx, values: ListInsert): Promise<ListRow> {
    const rows = await tx.insert(lists).values(values).returning();
    return toRow(rows[0]!, 0);
  },

  /** All lists in the workspace, alphabetical, each with its live member count. Workspace-scoped via RLS. */
  async listByWorkspace(scope: TenantScope): Promise<ListRow[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: lists.id,
          name: lists.name,
          description: lists.description,
          ownerUserId: lists.ownerUserId,
          createdAt: lists.createdAt,
          updatedAt: lists.updatedAt,
          memberCount: sql<number>`count(${listMembers.id})::int`,
        })
        .from(lists)
        .leftJoin(listMembers, eq(listMembers.listId, lists.id))
        .groupBy(lists.id)
        .orderBy(asc(lists.name));
      return rows.map((r) => ({ ...r, memberCount: r.memberCount ?? 0 }));
    });
  },

  /** Find one list by id within the caller's workspace (RLS scopes it); null if absent. */
  async findById(tx: Tx, id: string): Promise<{ id: string; ownerUserId: string } | null> {
    const rows = await tx
      .select({ id: lists.id, ownerUserId: lists.ownerUserId })
      .from(lists)
      .where(eq(lists.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Apply a rename / description change to a list OWNED by `ownerUserId`. Null when no owned row matched
   *  (wrong id, other workspace via RLS, or not the owner). */
  async updateOwned(
    tx: Tx,
    id: string,
    ownerUserId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<ListRow | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    const rows = await tx
      .update(lists)
      .set(set)
      .where(and(eq(lists.id, id), eq(lists.ownerUserId, ownerUserId)))
      .returning();
    if (!rows[0]) return null;
    const countRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(listMembers)
      .where(eq(listMembers.listId, id));
    return toRow(rows[0], countRows[0]?.n ?? 0);
  },

  /** Delete a list OWNED by `ownerUserId` (members cascade via FK). True when a row was removed. */
  async deleteOwned(tx: Tx, id: string, ownerUserId: string): Promise<boolean> {
    const rows = await tx
      .delete(lists)
      .where(and(eq(lists.id, id), eq(lists.ownerUserId, ownerUserId)))
      .returning({ id: lists.id });
    return rows.length > 0;
  },

  /** The subset of `ids` that are live (non-deleted) contacts visible in the caller's workspace (RLS). This
   *  is the cross-workspace guard for membership writes — only these ids may ever be linked. */
  async visibleContactIds(tx: Tx, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(inArray(contacts.id, ids), isNull(contacts.deletedAt)));
    return rows.map((r) => r.id);
  },

  /** Add contacts to a list. Idempotent: an existing (list, contact) link is ignored. Returns how many rows
   *  were ACTUALLY inserted (the affected count the UI confirms). Callers must pass workspace-visible ids. */
  async addMembers(tx: Tx, input: AddMembersInput): Promise<number> {
    if (input.contactIds.length === 0) return 0;
    const rows = await tx
      .insert(listMembers)
      .values(
        input.contactIds.map((contactId) => ({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          listId: input.listId,
          contactId,
          addedByUserId: input.addedByUserId,
        })),
      )
      .onConflictDoNothing({ target: [listMembers.listId, listMembers.contactId] })
      .returning({ id: listMembers.id });
    return rows.length;
  },

  /** Remove contacts from a list. Returns how many membership rows were removed. Workspace-scoped via RLS. */
  async removeMembers(tx: Tx, listId: string, contactIds: string[]): Promise<number> {
    if (contactIds.length === 0) return 0;
    const rows = await tx
      .delete(listMembers)
      .where(and(eq(listMembers.listId, listId), inArray(listMembers.contactId, contactIds)))
      .returning({ id: listMembers.id });
    return rows.length;
  },
};
