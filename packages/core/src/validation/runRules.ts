// runRules.ts — the pure data-quality validation engine (database-management-research 06). Runs the GIVEN rules
// against a prepared import row, returning one ValidationFailure per failed rule (reject-on-fail). The CALLER
// assembles the rule set: the import pipeline passes the enabled staff-authored CUSTOM rules — the built-in checks
// are shown in the rule-builder but NOT enforced on import (they would reject LinkedIn-only / nameless rows the
// pipeline otherwise accepts). Pure + side-effect-free; a failure carries the rule id + field + a reason code
// (never the offending value), so it is safe to surface in a staff reject-reason histogram.
import type { ValidationCheckType, ValidationFailure, ValidationRuleConfig } from "@leadwolf/types";

/** The minimal rule shape the engine needs — built-in constants and validation_rules DB rows both satisfy it. */
export interface ValidationRuleSpec {
  id: string;
  name: string;
  field: string;
  checkType: ValidationCheckType;
  config: ValidationRuleConfig;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toText = (value: unknown): string => (value == null ? "" : String(value).trim());

/** Evaluate one check against a field value; return a reason fragment on failure, or null on pass. An empty
 *  value only fails `required` — format/length/one_of checks treat empty as "nothing to validate" so they
 *  compose with a separate `required` rule rather than double-rejecting. */
function evaluate(
  checkType: ValidationCheckType,
  config: ValidationRuleConfig,
  value: unknown,
): string | null {
  const text = toText(value);
  switch (checkType) {
    case "required":
      return text.length === 0 ? "is required" : null;
    case "email_format":
      return text.length > 0 && !EMAIL_RE.test(text) ? "is not a valid email" : null;
    case "regex": {
      if (text.length === 0 || !config.pattern) return null;
      try {
        return new RegExp(config.pattern).test(text) ? null : "does not match the required format";
      } catch {
        return null; // a malformed stored pattern must never reject a row
      }
    }
    case "max_length":
      return config.maxLength != null && text.length > config.maxLength
        ? `exceeds ${config.maxLength} characters`
        : null;
    case "one_of":
      return text.length > 0 && config.allowed && !config.allowed.includes(text)
        ? "is not an allowed value"
        : null;
    default:
      return null; // unknown check type: never reject (future-proof to a new enum value)
  }
}

/** Run the given rules over a prepared row (canonical field → value). Returns every failure. */
export function runValidationRules(
  row: Record<string, unknown>,
  rules: ValidationRuleSpec[],
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  for (const rule of rules) {
    const reason = evaluate(rule.checkType, rule.config, row[rule.field]);
    if (reason) failures.push({ ruleId: rule.id, field: rule.field, message: `${rule.field} ${reason}` });
  }
  return failures;
}
