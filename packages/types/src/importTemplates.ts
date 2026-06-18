// importTemplates.ts — the Zod schemas + inferred types for saved import mapping templates (G-IMP-3,
// 30 §8). A template is a NAMED, workspace-scoped, replayable column mapping: it stores the exact
// `ColumnMapping` (canonical field → source header) the user confirmed for a recurring source, so a
// repeating drop maps itself. REUSES `columnMappingSchema` from contacts.ts as a read-only reference (the
// mapping model is owned there; this unit never redefines it). Single source of truth shared by apps/api
// (the templates CRUD), packages/core (apply/save), and apps/web (the picker). Validation lives here.

import { z } from "zod";
import { columnMappingSchema } from "./contacts.ts";

// ── Constraints (mirror the import_mapping_templates schema in packages/db) ───────────────────────────────
/** A template name is the workspace-unique handle (case-insensitive — the DB unique index lowers it). */
export const importTemplateName = z.string().trim().min(1).max(120);

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
});
export type SaveImportMappingTemplate = z.infer<typeof saveImportMappingTemplateSchema>;

// ── Record DTO (what the picker / GET return) ────────────────────────────────────────────────────────────
/** A saved mapping template as returned to the client. Non-PII; safe to serialize. */
export const importMappingTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mapping: columnMappingSchema,
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ImportMappingTemplate = z.infer<typeof importMappingTemplateSchema>;

/** The list payload for GET /imports/mapping-templates. */
export const importMappingTemplateListSchema = z.object({
  templates: z.array(importMappingTemplateSchema),
});
export type ImportMappingTemplateList = z.infer<typeof importMappingTemplateListSchema>;
