// lists.ts — Zod schemas + inferred types for static prospect lists (24, bulk "add to list"). A list is a
// named, manual collection of contacts — distinct from a saved search (a dynamic, re-runnable filter set).
// Workspace-scoped; rename/delete are owner-gated in @leadwolf/core. Leaf package (validation only).

import { z } from "zod";

/** Create a list. `description` is optional free text. */
export const createListSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});
export type CreateListRequest = z.infer<typeof createListSchema>;

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

/** A list as returned by the API. `memberCount` is the live membership size; `isOwner` drives rename/delete UI. */
export const list = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: z.string().uuid(),
  isOwner: z.boolean(),
  memberCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type List = z.infer<typeof list>;
