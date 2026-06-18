// customFieldRepository.ts — data access for the record-customization layer (ADR-0028, 03 §14, gap G-REV-5).
// Two concerns: (1) the workspace-scoped `custom_field_definitions` registry (CRUD), and (2) typed-jsonb
// values stored in the `custom_fields` column on contacts/accounts — read + shallow-merge-write (03 §15.3:
// `existing || incoming`, import-key-wins). String-typed enums like other overlay repos (the closed
// entity/field_type enums live in @leadwolf/types + the CHECK constraints; the api narrows at the edge).
// Definition writes take `tx` so the api composes validation + write in ONE withTenantTx; reads are scoped.

import { and, asc, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { accounts, contacts } from "../schema/contacts.ts";
import { customFieldDefinitions } from "../schema/customFields.ts";

/** A jsonb leaf value a custom field may hold (validated by type at the core layer before it reaches here). */
export type CustomFieldValue = string | number | boolean | null;

/** The writable columns for a new definition. `entity`/`field_type` are the closed enums (CHECK-constrained). */
export interface CustomFieldDefinitionInsert {
  tenantId: string;
  workspaceId: string;
  entity: string;
  key: string;
  label: string;
  fieldType: string;
  options?: string[] | null;
  required?: boolean;
  ordering?: number;
}

/** The mutable surface of a definition (key/entity/field_type are immutable — the jsonb storage contract). */
export interface CustomFieldDefinitionUpdate {
  label?: string;
  options?: string[] | null;
  required?: boolean;
  ordering?: number;
  archived?: boolean;
}

/** A registry row as repositories return it (camelCased). */
export interface CustomFieldDefinitionRecord {
  id: string;
  entity: string;
  key: string;
  label: string;
  fieldType: string;
  options: string[] | null;
  required: boolean;
  archived: boolean;
  ordering: number;
}

/** The select() projection shared by every definition read. */
const DEF_COLUMNS = {
  id: customFieldDefinitions.id,
  entity: customFieldDefinitions.entity,
  key: customFieldDefinitions.key,
  label: customFieldDefinitions.label,
  fieldType: customFieldDefinitions.fieldType,
  options: customFieldDefinitions.options,
  required: customFieldDefinitions.required,
  archived: customFieldDefinitions.archived,
  ordering: customFieldDefinitions.ordering,
} as const;

/** Which overlay record carries the `custom_fields` jsonb column for an entity. */
const recordTable = (entity: string) => (entity === "account" ? accounts : contacts);

export const customFieldRepository = {
  // ── Definitions ──────────────────────────────────────────────────────────────────────────────────────

  /** Insert a definition; returns the full row. Tx-aware so the api validates + writes in one tx. */
  async insertDefinition(
    tx: Tx,
    values: CustomFieldDefinitionInsert,
  ): Promise<CustomFieldDefinitionRecord> {
    const rows = await tx
      .insert(customFieldDefinitions)
      .values({
        tenantId: values.tenantId,
        workspaceId: values.workspaceId,
        entity: values.entity,
        key: values.key,
        label: values.label,
        fieldType: values.fieldType,
        options: values.options ?? null,
        required: values.required ?? false,
        ordering: values.ordering ?? 0,
      })
      .returning(DEF_COLUMNS);
    return rows[0]!;
  },

  /** Patch a definition's editorial surface; returns the updated row, or null if it isn't in this workspace. */
  async updateDefinition(
    tx: Tx,
    id: string,
    patch: CustomFieldDefinitionUpdate,
  ): Promise<CustomFieldDefinitionRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.options !== undefined) set.options = patch.options;
    if (patch.required !== undefined) set.required = patch.required;
    if (patch.ordering !== undefined) set.ordering = patch.ordering;
    if (patch.archived !== undefined) set.archived = patch.archived;
    const rows = await tx
      .update(customFieldDefinitions)
      .set(set)
      .where(eq(customFieldDefinitions.id, id))
      .returning(DEF_COLUMNS);
    return rows[0] ?? null;
  },

  /** One definition by id within the scoped workspace (RLS gates it). Tx-aware for compose-in-tx reads. */
  async getDefinitionById(tx: Tx, id: string): Promise<CustomFieldDefinitionRecord | null> {
    const rows = await tx
      .select(DEF_COLUMNS)
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * All definitions for an entity in the scoped workspace, ordered (ordering, then key). `includeArchived`
   * defaults false (the settings list shows live fields; the value-validator needs archived too). Tx-aware.
   */
  async listDefinitionsByEntity(
    tx: Tx,
    entity: string,
    includeArchived = false,
  ): Promise<CustomFieldDefinitionRecord[]> {
    const where = includeArchived
      ? eq(customFieldDefinitions.entity, entity)
      : and(eq(customFieldDefinitions.entity, entity), eq(customFieldDefinitions.archived, false));
    return tx
      .select(DEF_COLUMNS)
      .from(customFieldDefinitions)
      .where(where)
      .orderBy(asc(customFieldDefinitions.ordering), asc(customFieldDefinitions.key));
  },

  /** Workspace-scoped list of an entity's definitions (own withTenantTx) for the settings/read surfaces. */
  async listDefinitions(
    scope: TenantScope,
    entity: string,
    includeArchived = false,
  ): Promise<CustomFieldDefinitionRecord[]> {
    return withTenantTx(scope, (tx) => this.listDefinitionsByEntity(tx, entity, includeArchived));
  },

  // ── Values (typed jsonb on contacts/accounts) ──────────────────────────────────────────────────────────

  /**
   * Read a record's raw `custom_fields` jsonb (one object of key→value). Returns null if the record isn't in
   * the scoped workspace (RLS gates it). Tx-aware so the api composes the existence check + read.
   */
  async getValues(
    tx: Tx,
    entity: string,
    recordId: string,
  ): Promise<Record<string, CustomFieldValue> | null> {
    const table = recordTable(entity);
    const rows = await tx
      .select({ customFields: table.customFields })
      .from(table)
      .where(eq(table.id, recordId))
      .limit(1);
    if (!rows[0]) return null;
    return (rows[0].customFields as Record<string, CustomFieldValue>) ?? {};
  },

  /**
   * Shallow-merge `incoming` into the record's `custom_fields` (03 §15.3: `existing || incoming`,
   * incoming-key-wins; other keys preserved). A null value in `incoming` writes JSON null (clears that key
   * to "unset" semantically — the read joins definitions so a cleared key simply reads back null). Returns
   * the merged object, or null if the record isn't in this workspace. Tx-aware.
   */
  async mergeValues(
    tx: Tx,
    entity: string,
    recordId: string,
    incoming: Record<string, CustomFieldValue>,
  ): Promise<Record<string, CustomFieldValue> | null> {
    const table = recordTable(entity);
    // `||` shallow-merges at the jsonb level; cast the bound param so postgres treats it as jsonb not text.
    const merged = sql`${table.customFields} || ${JSON.stringify(incoming)}::jsonb`;
    const rows = await tx
      .update(table)
      .set({ customFields: merged, updatedAt: new Date() })
      .where(eq(table.id, recordId))
      .returning({ customFields: table.customFields });
    if (!rows[0]) return null;
    return (rows[0].customFields as Record<string, CustomFieldValue>) ?? {};
  },
};
