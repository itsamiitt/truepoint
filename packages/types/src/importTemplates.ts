// importTemplates.ts — the Zod schemas + inferred types for saved import mapping templates (G-IMP-3,
// 30 §8). A template is a NAMED, workspace-scoped, replayable column mapping: it stores the exact
// `ColumnMapping` (canonical field → source header) the user confirmed for a recurring source, so a
// repeating drop maps itself. REUSES `columnMappingSchema` from contacts.ts as a read-only reference (the
// mapping model is owned there; this unit never redefines it). Single source of truth shared by apps/api
// (the templates CRUD), packages/core (apply/save), and apps/web (the picker). Validation lives here.

import { z } from "zod";
import { columnMappingSchema } from "./contacts.ts";
import { importMergeMode } from "./importPolicy.ts";

// ── Constraints (mirror the import_mapping_templates schema in packages/db) ───────────────────────────────
/** A template name is the workspace-unique handle (case-insensitive — the DB unique index lowers it). */
export const importTemplateName = z.string().trim().min(1).max(120);

/** Who sees a saved template (S-I2, import-redesign 08 §3.1): 'workspace' (default — the shipped semantics,
 *  the named shared template no vendor ships) or 'private' (creator-only; the Data Loader .sdl analog). */
export const importTemplateVisibility = z.enum(["private", "workspace"]);
export type ImportTemplateVisibility = z.infer<typeof importTemplateVisibility>;

// ── Save / upsert request DTO ────────────────────────────────────────────────────────────────────────────
/**
 * The body the "Save as template" action sends. `name` is the workspace-unique handle (re-saving the same
 * name UPSERTs the mapping in place — never a duplicate). `mapping` is the confirmed `ColumnMapping`; at
 * least one mapped field is required so an empty template can never be persisted.
 */
export const saveImportMappingTemplateSchema = z.object({
  name: importTemplateName,
  mapping: columnMappingSchema.refine((m) => Object.keys(m).length > 0, {
    message: "A template needs at least one mapped field.",
  }),
  // ── S-I2 sharing + strategy block (import-redesign 08 §3.1) — ALL OPTIONAL: dark while the
  // IMPORT_V2_ENABLED dual gate is off (the shipped route strips/ignores them until its S-I2 slice ships).
  /** Omitted → server default 'workspace' (the shipped semantics). */
  visibility: importTemplateVisibility.optional(),
  /** The template-carried strategy pair. null/omitted = don't pin — inherit the workspace policy default. */
  mergeMode: importMergeMode.nullable().optional(),
  preservePopulated: z.boolean().nullable().optional(),
  /** Parse/import options copied with the template (countryHint, delimiter…; shape owned by S-I5/S-I8). */
  options: z.record(z.string(), z.unknown()).optional(),
});
export type SaveImportMappingTemplate = z.infer<typeof saveImportMappingTemplateSchema>;

// ── Record DTO (what the picker / GET return) ────────────────────────────────────────────────────────────
/** A saved mapping template as returned to the client. Non-PII; safe to serialize. */
export const importMappingTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mapping: columnMappingSchema,
  createdByUserId: z.string().uuid().nullable(),
  // ── S-I2 fields — OPTIONAL on the DTO: absent from the shipped responses until the template read path's
  // S-I2 slice ships, so flag-off responses (and the current core/api return shape) stay byte-identical.
  visibility: importTemplateVisibility.optional(),
  mergeMode: importMergeMode.nullable().optional(),
  preservePopulated: z.boolean().nullable().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ImportMappingTemplate = z.infer<typeof importMappingTemplateSchema>;

/** The list payload for GET /imports/mapping-templates. */
export const importMappingTemplateListSchema = z.object({
  templates: z.array(importMappingTemplateSchema),
});
export type ImportMappingTemplateList = z.infer<typeof importMappingTemplateListSchema>;
