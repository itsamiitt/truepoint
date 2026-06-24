// lists.ts — Zod schemas + inferred types for static prospect lists (24, bulk "add to list"). A list is a
// named, manual collection of contacts — distinct from a saved search (a dynamic, re-runnable filter set).
// Workspace-scoped; rename/delete are owner-gated in @leadwolf/core. Leaf package (validation only).

import { z } from "zod";
import { maskedContactSchema } from "./contacts.ts";

/** The two kinds of list (00 §4 vocabulary). `static` = explicit `list_members` rows (a curated snapshot);
 *  `dynamic` = membership derived from a saved `ContactQuery` (auto-resolves on read; Phase 4). */
export const listKind = z.enum(["static", "dynamic"]);
export type ListKind = z.infer<typeof listKind>;

/** Create a (static) list. `description` is optional free text. */
export const createListSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});
export type CreateListRequest = z.infer<typeof createListSchema>;

/**
 * Create a DYNAMIC list backed by a saved search (Phase 4). `savedSearchId` is the saved `ContactQuery` whose
 * matches define membership — it is RE-VALIDATED server-side under the caller's workspace (RLS): a foreign or
 * absent id is rejected (404), so the client-supplied id is never trusted as a workspace grant. The FK on
 * `lists.saved_search_id` only proves the row exists, NOT that it is co-tenant — the core write path is the
 * boundary (mirrors `visibleContactIds` for static members).
 */
export const createDynamicListSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  savedSearchId: z.string().uuid(),
});
export type CreateDynamicListRequest = z.infer<typeof createDynamicListSchema>;

/** Rename / re-describe a list. At least one field required. `description: null` clears it. */
export const updateListSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((u) => u.name !== undefined || u.description !== undefined, {
    message: "Provide name or description to update.",
  });
export type UpdateListRequest = z.infer<typeof updateListSchema>;

/**
 * Bulk membership mutation — the contact ids to add or remove. Ids outside the caller's workspace are
 * silently dropped server-side (the membership write only ever touches workspace-visible contacts), so a
 * cross-workspace id can never become a member. Bounded to keep a single bulk op sane.
 */
export const listMembersSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(10000),
});
export type ListMembersRequest = z.infer<typeof listMembersSchema>;

/**
 * Query params for the list-members read (GET /lists/:id/members) — masked, keyset-paged. `limit` is bounded
 * so a single page can never pull the whole membership; `cursor` is the opaque keyset token from the prior
 * page (base64url of the last row's added_at + id). Both optional → first page at the default size.
 */
export const listMembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

/**
 * One keyset page of a list's members — the MASKED contact rows (no PII; email domain only, phone locked)
 * plus the opaque cursor for the next page (null at the end). Mirrors the search surface's SearchPage shape
 * so the members table can reuse the prospect grid + "Load more" verbatim. Reveal is the only de-masking path.
 */
export const listMembersPageSchema = z.object({
  members: z.array(maskedContactSchema),
  nextCursor: z.string().nullable(),
});
export type ListMembersPage = z.infer<typeof listMembersPageSchema>;

/** A list as returned by the API. `memberCount` is the live membership size; `isOwner` drives rename/delete UI.
 *  `kind` distinguishes a curated static list from a saved-search-backed dynamic one (the index badge reads it);
 *  `savedSearchId` is the backing saved search for a dynamic list (null for static). For a dynamic list
 *  `memberCount` is the live size of its query's matching set, not a stored `list_members` count. */
export const list = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: z.string().uuid(),
  isOwner: z.boolean(),
  kind: listKind,
  savedSearchId: z.string().uuid().nullable(),
  memberCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type List = z.infer<typeof list>;
