// savedSearch.ts — Zod schemas + inferred types for saved searches / segments (M8, 24 §8). A saved search
// persists the exact `contactQuery` blob (search.ts) so applying it = re-running POST /search/contacts; the
// filter shape is NEVER re-modelled here, it is REUSED from search.ts (24 §2/§7.6, ADR-0035). Leaf package —
// validation lives here; logic lives in @leadwolf/core/savedSearches.

import { z } from "zod";
import { contactQuery } from "./search.ts";

// ── Visibility ───────────────────────────────────────────────────────────────────────────────────────
/**
 * Who can see a saved search (24 §8). `private` = the owner only; `workspace` = every member of the
 * workspace. Mutations (rename/delete) always gate on the owner regardless of visibility (core logic).
 */
export const savedSearchVisibility = z.enum(["private", "workspace"]);
export type SavedSearchVisibility = z.infer<typeof savedSearchVisibility>;

// ── Request schemas (09 §3 body naming: snake_case) ──────────────────────────────────────────────────
/**
 * Create a saved search. `filters` is the validated `contactQuery` blob the prospect rail produced — it is
 * re-validated here on save so a malformed filter set can never be persisted (the M8 acceptance criterion).
 */
export const createSavedSearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  filters: contactQuery,
  visibility: savedSearchVisibility.default("private"),
});
export type CreateSavedSearchRequest = z.infer<typeof createSavedSearchSchema>;

/** Update a saved search — rename and/or change visibility. At least one field must be present. */
export const updateSavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    visibility: savedSearchVisibility.optional(),
  })
  .refine((u) => u.name !== undefined || u.visibility !== undefined, {
    message: "Provide name or visibility to update.",
  });
export type UpdateSavedSearchRequest = z.infer<typeof updateSavedSearchSchema>;

// ── DTO (the list/detail shape the web client renders) ───────────────────────────────────────────────
/** A saved search as returned by the API. `filters` is the persisted `contactQuery` re-applied on click. */
export const savedSearch = z.object({
  id: z.string().uuid(),
  name: z.string(),
  filters: contactQuery,
  visibility: savedSearchVisibility,
  ownerUserId: z.string().uuid(),
  /** True when the requesting caller owns this row (the UI shows rename/delete only when so). */
  isOwner: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedSearch = z.infer<typeof savedSearch>;
