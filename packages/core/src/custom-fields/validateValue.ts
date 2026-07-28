// validateValue.ts — validate one custom-field value against its definition by field_type (ADR-0028, gap
// G-REV-5). Pure: no I/O, no DB. The api validates the *request shape* with @leadwolf/types; THIS validates
// the *semantic* contract (a number is a number, a select value is one of the options, a url parses, a date
// is ISO-8601). Returns the coerced/canonical value to persist, or throws ValidationError. Reused by the
// set-values service and (later) the import mapper, so the rule lives in exactly one place.

import { type CustomFieldType, ValidationError } from "@leadwolf/types";

/** A definition's slice the validator needs (decoupled from the db record shape). */
export interface FieldDefinitionForValidation {
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[] | null;
  required: boolean;
  archived: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate `value` against `def`, returning the canonical value to store. A null/undefined value clears the
 * key (allowed only when the field isn't required). Throws ValidationError (422) with a field-scoped message
 * on any type mismatch — never persists a value that doesn't satisfy its definition.
 */
export function validateValue(
  def: FieldDefinitionForValidation,
  value: unknown,
): string | number | boolean | null {
  const fail = (msg: string): never => {
    throw new ValidationError(`Custom field "${def.label}": ${msg}`, { key: def.key });
  };

  if (value === null || value === undefined) {
    if (def.required) fail("a value is required.");
    return null;
  }

  switch (def.fieldType) {
    case "text": {
      if (typeof value !== "string") return fail("must be text.");
      if (value.length > 2000) return fail("must be at most 2000 characters.");
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("must be a number.");
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") return fail("must be true or false.");
      return value;
    }
    case "date": {
      // Stored as an ISO-8601 calendar date string (YYYY-MM-DD) — stable, locale-free, jsonb-friendly.
      if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        return fail("must be a date (YYYY-MM-DD).");
      }
      return value;
    }
    case "url": {
      if (typeof value !== "string") return fail("must be a URL.");
      if (value.length > 2000) return fail("must be at most 2000 characters.");
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return fail("must be a valid URL.");
      }
      // Protocol check is OUTSIDE the try so its specific message isn't shadowed by the catch's generic one.
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail("must be an http(s) URL.");
      }
      return value;
    }
    case "select": {
      if (typeof value !== "string") return fail("must be one of the allowed options.");
      if (!def.options || !def.options.includes(value)) {
        return fail(`must be one of: ${(def.options ?? []).join(", ")}.`);
      }
      return value;
    }
    default:
      return fail("has an unknown type.");
  }
}
