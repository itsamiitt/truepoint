// manageDefinitions.ts — business logic for the custom-field registry (ADR-0028, gap G-REV-5): create / list /
// update a workspace's field definitions. Thin domain layer over customFieldRepository: it owns the rules
// (duplicate-key conflict, immutable key/entity/field_type) and leaves transport to apps/api and storage to
// packages/db. NO HTTP here. custom_field.* mutations are audit-free for now (sales_nav_links precedent; the
// audit-action enum is owned elsewhere) — follow-up: wire audit when the enum adds custom_field.* actions
// (28 §3.17 G-CMP-1).

import {
  type CustomFieldDefinitionRecord,
  type TenantScope,
  customFieldRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type CustomFieldEntity,
  type CustomFieldType,
  NotFoundError,
  ValidationError,
} from "@leadwolf/types";

export interface ScopeRequired {
  scope: TenantScope & { workspaceId: string };
}

export interface CreateDefinitionInput extends ScopeRequired {
  entity: CustomFieldEntity;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[] | null;
  required?: boolean;
  ordering?: number;
}

export interface UpdateDefinitionInput extends ScopeRequired {
  id: string;
  patch: {
    label?: string;
    options?: string[] | null;
    required?: boolean;
    ordering?: number;
    archived?: boolean;
  };
}

/**
 * Create a definition. Pre-checks for a duplicate (workspace, entity, key) inside the same tx and maps the
 * race-loser unique-violation to the same input error. `options` is normalized to null for non-select types
 * (the request schema already enforces the shape; this guards direct core callers too).
 */
export async function createDefinition(
  input: CreateDefinitionInput,
): Promise<CustomFieldDefinitionRecord> {
  return withTenantTx(input.scope, async (tx) => {
    const existing = await customFieldRepository.listDefinitionsByEntity(tx, input.entity, true);
    if (existing.some((d) => d.key === input.key)) {
      throw new ValidationError(`A "${input.key}" field already exists for ${input.entity}.`, {
        key: input.key,
      });
    }
    try {
      return await customFieldRepository.insertDefinition(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        entity: input.entity,
        key: input.key,
        label: input.label,
        fieldType: input.fieldType,
        options: input.fieldType === "select" ? (input.options ?? null) : null,
        required: input.required,
        ordering: input.ordering,
      });
    } catch (err) {
      // The (workspace, entity, key) unique index — a race against a concurrent create.
      if (String(err).includes("uniq_custom_field_defs_ws_entity_key")) {
        throw new ValidationError(`A "${input.key}" field already exists.`, { key: input.key });
      }
      throw err;
    }
  });
}

/**
 * Patch a definition's editorial surface (label/options/required/ordering/archived). 404 if not in scope.
 * Maps the `options`-shape CHECK violation (e.g. clearing a select's options, or setting options on a
 * non-select field) to a clean 422 — the constraint is field_type-aware and can't be re-checked here without
 * a read, so the DB is the source of truth and its violation is translated, never leaked as a raw 500.
 */
export async function updateDefinition(
  input: UpdateDefinitionInput,
): Promise<CustomFieldDefinitionRecord> {
  return withTenantTx(input.scope, async (tx) => {
    let updated: CustomFieldDefinitionRecord | null;
    try {
      updated = await customFieldRepository.updateDefinition(tx, input.id, input.patch);
    } catch (err) {
      if (String(err).includes("custom_field_defs_options_shape")) {
        throw new ValidationError(
          "Options may only be set on a 'select' field, and a 'select' field needs at least one option.",
        );
      }
      throw err;
    }
    if (!updated) throw new NotFoundError("Custom field not found in this workspace.");
    return updated;
  });
}

/** All definitions for an entity in the workspace; live-only unless `includeArchived`. */
export async function listDefinitions(
  scope: TenantScope & { workspaceId: string },
  entity: CustomFieldEntity,
  includeArchived = false,
): Promise<CustomFieldDefinitionRecord[]> {
  return customFieldRepository.listDefinitions(scope, entity, includeArchived);
}
