// validateMapping.ts — the PURE CRM field-mapping validator (crm-sync §4.3). IO-free: a list of mappings + the
// set of known TruePoint fields → a list of structured errors (no throw, no DB, no network), so it unit-tests
// cleanly and can run anywhere. This is what the future admin mapping editor (inline validation) and a startup
// self-check (the seeded presets must stay well-formed) call. It checks the SHAPE/consistency rules that the
// per-field config must hold; it deliberately does NOT re-implement the closed-enum checks the Zod schema
// (crmFieldMappingSchema) already enforces at the edge.

import type { CrmFieldMapping, CrmObjectType } from "@leadwolf/types";

/** The closed set of consistency violations validateCrmMappings can report. */
export type CrmMappingErrorCode =
  | "duplicate_tp_field"
  | "unknown_tp_field"
  | "empty_crm_field"
  | "conf_threshold_out_of_range"
  | "enabled_but_disabled";

/** One violation, tagged with the offending (object, tpField) so a UI can pin it to its row. */
export interface CrmMappingError {
  code: CrmMappingErrorCode;
  objectType: CrmObjectType;
  tpField: string;
  message: string;
}

/**
 * Validate a set of field mappings against the known TruePoint field set. Pure — neither argument is mutated.
 * Reports, per row: a duplicate (object, tpField) pairing; an unknown tpField (not in `knownTpFields`); an
 * empty/blank crmField; a confThreshold outside [0,1]; and an enabled mapping whose direction is "disabled"
 * (a contradiction — disable it or pick a real direction). Returns [] when every mapping is well-formed.
 */
export function validateCrmMappings(
  mappings: readonly CrmFieldMapping[],
  knownTpFields: Iterable<string>,
): CrmMappingError[] {
  const known = new Set(knownTpFields);
  const errors: CrmMappingError[] = [];
  const seen = new Set<string>();

  const add = (m: CrmFieldMapping, code: CrmMappingErrorCode, message: string): void => {
    errors.push({ code, objectType: m.objectType, tpField: m.tpField, message });
  };

  for (const m of mappings) {
    const key = `${m.objectType}::${m.tpField}`;
    if (seen.has(key)) {
      add(m, "duplicate_tp_field", `duplicate mapping (${m.objectType}/${m.tpField})`);
    }
    seen.add(key);

    if (!known.has(m.tpField)) {
      add(m, "unknown_tp_field", `unknown TruePoint field "${m.tpField}"`);
    }
    if (m.crmField.trim() === "") {
      add(m, "empty_crm_field", `empty crmField for "${m.tpField}"`);
    }
    if (m.confThreshold !== undefined && (m.confThreshold < 0 || m.confThreshold > 1)) {
      add(m, "conf_threshold_out_of_range", `confThreshold ${m.confThreshold} is outside [0,1]`);
    }
    if (m.enabled !== false && m.direction === "disabled") {
      add(m, "enabled_but_disabled", `enabled mapping has direction "disabled"`);
    }
  }

  return errors;
}
