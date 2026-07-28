// setValues.ts — business logic to set custom-field values on one contact/account (ADR-0028, gap G-REV-5).
// Each incoming key is matched to a live definition and validated by type (validateValue); unknown or
// archived keys are rejected so the jsonb never accumulates orphan/garbage keys. Validated values are
// shallow-merged into the record's `custom_fields` jsonb (03 §15.3: `existing || incoming`, incoming-wins).
// One withTenantTx: load definitions + verify the record + merge, all RLS-scoped to the workspace.

import {
  type CustomFieldValue,
  type TenantScope,
  customFieldRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type CustomFieldEntity,
  type CustomFieldType,
  type CustomFieldValueDto,
  NotFoundError,
  ValidationError,
} from "@leadwolf/types";
import { type FieldDefinitionForValidation, validateValue } from "./validateValue.ts";

export interface SetValuesInput {
  scope: TenantScope & { workspaceId: string };
  entity: CustomFieldEntity;
  recordId: string;
  /** key → value (string|number|boolean|null). A null clears that one key. */
  values: Record<string, CustomFieldValue>;
}

/** Build the value-joined DTO list (definition order) from a raw jsonb store + the live definitions. */
function toDtos(
  defs: FieldDefinitionForValidation[],
  store: Record<string, CustomFieldValue>,
): CustomFieldValueDto[] {
  return defs.map((d) => ({
    key: d.key,
    label: d.label,
    fieldType: d.fieldType,
    options: d.options,
    value: store[d.key] ?? null,
  }));
}

/**
 * Validate + persist custom-field values for a record, returning the record's full (live-definition-ordered)
 * value set. Rejects unknown/archived keys (422) and any value that fails its definition's type rule. A null
 * value clears that key. Returns 404 if the record isn't in the scoped workspace.
 */
export async function setCustomFieldValues(input: SetValuesInput): Promise<CustomFieldValueDto[]> {
  return withTenantTx(input.scope, async (tx) => {
    const records = await customFieldRepository.listDefinitionsByEntity(tx, input.entity, true);
    const defs: FieldDefinitionForValidation[] = records.map((d) => ({
      key: d.key,
      label: d.label,
      fieldType: d.fieldType as CustomFieldType,
      options: d.options,
      required: d.required,
      archived: d.archived,
    }));
    const byKey = new Map(defs.map((d) => [d.key, d]));

    // Verify the record exists in this workspace before validating (404 over a misleading "unknown key").
    const current = await customFieldRepository.getValues(tx, input.entity, input.recordId);
    if (current === null) {
      throw new NotFoundError(`${input.entity} not found in this workspace.`);
    }

    const merged: Record<string, CustomFieldValue> = {};
    for (const [key, raw] of Object.entries(input.values)) {
      const def = byKey.get(key);
      if (!def) throw new ValidationError(`Unknown custom field "${key}".`, { key });
      // An archived field can still be CLEARED (null) so a stale value isn't stuck forever, but no new
      // non-null value may be written to it.
      if (def.archived && raw !== null) {
        throw new ValidationError(`Custom field "${def.label}" is archived.`, { key });
      }
      merged[key] = validateValue(def, raw);
    }

    if (Object.keys(merged).length === 0) {
      // Nothing to write — return the current live-definition view unchanged (avoids a no-op UPDATE that
      // would needlessly fire the set_updated_at trigger).
      return toDtos(
        defs.filter((d) => !d.archived),
        current,
      );
    }

    const after = await customFieldRepository.mergeValues(tx, input.entity, input.recordId, merged);
    if (after === null) throw new NotFoundError(`${input.entity} not found in this workspace.`);
    return toDtos(
      defs.filter((d) => !d.archived),
      after,
    );
  });
}

/** Read a record's custom-field values, joined to its live definitions (definition order). 404 if not in scope. */
export async function getCustomFieldValues(
  scope: TenantScope & { workspaceId: string },
  entity: CustomFieldEntity,
  recordId: string,
): Promise<CustomFieldValueDto[]> {
  return withTenantTx(scope, async (tx) => {
    const store = await customFieldRepository.getValues(tx, entity, recordId);
    if (store === null) throw new NotFoundError(`${entity} not found in this workspace.`);
    const records = await customFieldRepository.listDefinitionsByEntity(tx, entity, false);
    const defs: FieldDefinitionForValidation[] = records.map((d) => ({
      key: d.key,
      label: d.label,
      fieldType: d.fieldType as CustomFieldType,
      options: d.options,
      required: d.required,
      archived: d.archived,
    }));
    return toDtos(defs, store);
  });
}
