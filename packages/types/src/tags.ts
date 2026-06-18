// tags.ts — the Zod schemas + inferred types for the record-customization tag layer (ADR-0028, G-REV-6).
// Workspace-scoped, lightweight, cross-list labels orthogonal to lists. Single source of truth shared by
// apps/api, apps/web, and packages/core. Enums mirror the 03 §5 / rls/tags.sql CHECK constraints exactly.
// Validation lives here; logic does not.

import { z } from "zod";

// ── Enums (mirror the tags / record_tags CHECK constraints) ────────────────────────────────────────────
/**
 * A tag's color is a BRAND PALETTE KEY — never a raw hex. apps/web maps the key to a `--tp-*` token
 * (tagColors.ts), so the monochrome system + dark-mode-safe theming stay authoritative (04 §2/§3, brand
 * identity). Keep this in lockstep with the tags_color_enum CHECK and apps/web's TAG_COLORS map.
 */
export const tagColor = z.enum(["neutral", "accent", "success", "warning", "danger", "info"]);
export type TagColor = z.infer<typeof tagColor>;

/** The record kinds a tag can label. Mirrors the record_tags entity CHECK; `account` lands with the M8 view. */
export const taggableEntity = z.enum(["contact", "account"]);
export type TaggableEntity = z.infer<typeof taggableEntity>;

// ── Tag DTOs ───────────────────────────────────────────────────────────────────────────────────────────
/** A workspace tag as returned to the client, with its live assignment `usageCount` for governance/UX. */
export const tagSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(60),
  color: tagColor,
  usageCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
});
export type Tag = z.infer<typeof tagSchema>;

/** POST /tags — create a workspace tag. Name is trimmed + length-bounded; color defaults to neutral. */
export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: tagColor.default("neutral"),
});
export type CreateTagRequest = z.infer<typeof createTagSchema>;

/** PATCH /tags/:id — rename and/or recolor an existing tag (both optional; at least one is enforced in core). */
export const updateTagSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: tagColor.optional(),
});
export type UpdateTagRequest = z.infer<typeof updateTagSchema>;

/** POST /tags/:id/assign — attach the tag to one record (entity + record_id). Idempotent server-side. */
export const assignTagSchema = z.object({
  entity: taggableEntity,
  record_id: z.string().uuid(),
});
export type AssignTagRequest = z.infer<typeof assignTagSchema>;
