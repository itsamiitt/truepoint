// templates.ts — saved import mapping templates (G-IMP-3, 30 §8): the thin domain layer over the
// import_mapping_templates repository. A template is a NAMED, replayable ColumnMapping; saving one upserts
// by name, applying one loads the stored mapping so the wizard's column-mapper can pre-fill itself for a
// recurring source. Validation lives in @leadwolf/types (saveImportMappingTemplateSchema); persistence lives
// in @leadwolf/db; this module wires the two and maps the DB record (Date columns) to the serializable
// ImportMappingTemplate DTO (ISO strings). It does NOT touch the existing import pipeline (runImport et al.).

import { type ImportMappingTemplateRecord, importMappingTemplateRepository } from "@leadwolf/db";
import {
  type ColumnMapping,
  type ImportMappingTemplate,
  type SaveImportMappingTemplate,
  saveImportMappingTemplateSchema,
} from "@leadwolf/types";

export interface SaveMappingTemplateInput {
  scope: { tenantId: string; workspaceId: string };
  createdByUserId?: string | null;
  template: SaveImportMappingTemplate;
}

/** Map a repository record to the serializable DTO (Date → ISO-8601, jsonb mapping → ColumnMapping). */
function toTemplate(r: ImportMappingTemplateRecord): ImportMappingTemplate {
  return {
    id: r.id,
    name: r.name,
    mapping: r.mapping as ColumnMapping,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Save (UPSERT by case-insensitive name) a mapping template for the workspace and return it. Re-validates the
 * body here so core never trusts a caller's already-parsed shape; the repository enforces per-workspace
 * isolation under RLS.
 */
export async function saveMappingTemplate(
  input: SaveMappingTemplateInput,
): Promise<ImportMappingTemplate> {
  const parsed = saveImportMappingTemplateSchema.parse(input.template);
  const record = await importMappingTemplateRepository.save(input.scope, {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    name: parsed.name,
    mapping: parsed.mapping as Record<string, string>,
    createdByUserId: input.createdByUserId ?? null,
  });
  return toTemplate(record);
}

/** List the workspace's saved templates (newest-updated first) for the picker. */
export async function listMappingTemplates(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<ImportMappingTemplate[]> {
  const records = await importMappingTemplateRepository.listByWorkspace(scope);
  return records.map(toTemplate);
}

/** Load one full template by id. Null when it doesn't exist or isn't visible to this workspace (RLS). */
export async function getMappingTemplate(
  scope: { tenantId: string; workspaceId: string },
  templateId: string,
): Promise<ImportMappingTemplate | null> {
  const record = await importMappingTemplateRepository.findById(scope, templateId);
  return record ? toTemplate(record) : null;
}

/**
 * Apply a template: load it by id and return its stored ColumnMapping so the wizard can pre-fill the
 * column-mapper. Null when the template doesn't exist or isn't visible to this workspace (RLS).
 */
export async function applyMappingTemplate(
  scope: { tenantId: string; workspaceId: string },
  templateId: string,
): Promise<ColumnMapping | null> {
  const record = await importMappingTemplateRepository.findById(scope, templateId);
  return record ? (record.mapping as ColumnMapping) : null;
}

/** Delete a template by id. Returns true if a row was removed (false if not found / not visible). */
export async function deleteMappingTemplate(
  scope: { tenantId: string; workspaceId: string },
  templateId: string,
): Promise<boolean> {
  return importMappingTemplateRepository.deleteById(scope, templateId);
}
