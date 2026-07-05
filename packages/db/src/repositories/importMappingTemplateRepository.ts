// importMappingTemplateRepository.ts — data access for saved import column-mapping templates (G-IMP-3,
// 30 §8). CRUD over `import_mapping_templates`: save (UPSERT by case-insensitive name), listByWorkspace,
// findById, deleteById. Every path runs through withTenantTx so RLS enforces per-workspace isolation under
// the non-BYPASSRLS leadwolf_app role; queries also carry an explicit workspace/tenant predicate so a write
// can never target a foreign workspace's row. The `mapping` jsonb is stored verbatim (validated as a
// ColumnMapping at the API edge — this layer holds no business logic). Non-PII throughout.

import { and, desc, eq, sql } from "drizzle-orm";
import { type TenantScope, withTenantTx } from "../client.ts";
import { importMappingTemplates } from "../schema/importMappingTemplates.ts";

/** The writable columns the save path computes. `mapping` is a ColumnMapping (canonical field → header). */
export interface ImportMappingTemplateSaveValues {
  tenantId: string;
  workspaceId: string;
  name: string;
  mapping: Record<string, string>;
  createdByUserId?: string | null;
}

/** A saved template read back for the picker / GET (non-PII; serializable). */
export interface ImportMappingTemplateRecord {
  id: string;
  name: string;
  mapping: Record<string, string>;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const RECORD_COLUMNS = {
  id: importMappingTemplates.id,
  name: importMappingTemplates.name,
  mapping: importMappingTemplates.mapping,
  createdByUserId: importMappingTemplates.createdByUserId,
  createdAt: importMappingTemplates.createdAt,
  updatedAt: importMappingTemplates.updatedAt,
} as const;

/** The DB returns `mapping` as untyped jsonb; narrow it to the stored ColumnMapping shape for callers. */
function toRecord(row: {
  id: string;
  name: string;
  mapping: unknown;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ImportMappingTemplateRecord {
  return { ...row, mapping: (row.mapping ?? {}) as Record<string, string> };
}

export const importMappingTemplateRepository = {
  /**
   * Save a template, UPSERTing by case-insensitive name: a re-save under the same name (any case) overwrites
   * the existing mapping (and bumps updated_at) instead of creating a duplicate. The (workspace_id,
   * lower(name)) unique index is an EXPRESSION index, which Drizzle's `onConflict` target can't NAME, so the
   * upsert is INSERT … ON CONFLICT DO NOTHING (fires on the expression index without naming it) → if the
   * insert was a no-op (a row with that name already existed, including a concurrent same-name writer), fall
   * back to an UPDATE matched by lower(name). This is race-safe: concurrent same-name saves never raise a
   * unique violation and never create a duplicate — the loser updates the winner's row. Workspace-scoped via
   * RLS + the explicit workspace predicate (the WITH CHECK gate on write).
   */
  async save(
    scope: TenantScope,
    values: ImportMappingTemplateSaveValues,
  ): Promise<ImportMappingTemplateRecord> {
    return withTenantTx(scope, async (tx) => {
      const inserted = await tx
        .insert(importMappingTemplates)
        .values(values)
        .onConflictDoNothing()
        .returning(RECORD_COLUMNS);
      if (inserted[0]) return toRecord(inserted[0]);

      // A template with this (workspace, lower(name)) already exists — overwrite its mapping in place. The
      // BEFORE-UPDATE trigger bumps updated_at; `.returning()` reflects the trigger-updated row.
      const updated = await tx
        .update(importMappingTemplates)
        .set({ name: values.name, mapping: values.mapping })
        .where(
          and(
            eq(importMappingTemplates.workspaceId, values.workspaceId),
            sql`lower(${importMappingTemplates.name}) = lower(${values.name})`,
          ),
        )
        .returning(RECORD_COLUMNS);
      if (!updated[0]) throw new Error("import mapping template vanished after upsert conflict");
      return toRecord(updated[0]);
    });
  },

  /** Read one template by its case-insensitive name (the save-path ownership check, import-redesign 10
   *  §2.1 template row: a member may overwrite only their OWN template). Workspace-scoped via RLS. */
  async findByName(scope: TenantScope, name: string): Promise<ImportMappingTemplateRecord | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select(RECORD_COLUMNS)
        .from(importMappingTemplates)
        .where(sql`lower(${importMappingTemplates.name}) = lower(${name})`)
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    });
  },

  /** Newest-updated-first templates for the workspace (the picker's data). Workspace-scoped via RLS. */
  async listByWorkspace(scope: TenantScope, limit = 200): Promise<ImportMappingTemplateRecord[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select(RECORD_COLUMNS)
        .from(importMappingTemplates)
        .where(
          and(
            eq(importMappingTemplates.workspaceId, scope.workspaceId ?? ""),
            eq(importMappingTemplates.tenantId, scope.tenantId),
          ),
        )
        .orderBy(desc(importMappingTemplates.updatedAt))
        .limit(limit);
      return rows.map(toRecord);
    });
  },

  /** Read one template by id (RLS already restricts it to the caller's workspace). Null if not visible. */
  async findById(scope: TenantScope, id: string): Promise<ImportMappingTemplateRecord | null> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select(RECORD_COLUMNS)
        .from(importMappingTemplates)
        .where(eq(importMappingTemplates.id, id))
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    });
  },

  /**
   * Delete one template by id. Returns true if a row was removed (false if it didn't exist or wasn't visible
   * to this workspace). Workspace-scoped via RLS + the explicit workspace predicate (defense in depth).
   */
  async deleteById(scope: TenantScope, id: string): Promise<boolean> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .delete(importMappingTemplates)
        .where(
          and(
            eq(importMappingTemplates.id, id),
            eq(importMappingTemplates.workspaceId, scope.workspaceId ?? ""),
          ),
        )
        .returning({ id: importMappingTemplates.id });
      return rows.length > 0;
    });
  },
};
