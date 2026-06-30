// builtins.ts — the always-on BUILT-IN data-quality checks (database-management-research 06). These are code
// constants (not validation_rules rows), so they ship with the engine and apply to every import; the
// validation_rules table holds only the staff-authored custom rules layered on top. The admin rule list shows
// these as read-only "built-in" entries (they can't be deleted; a future slice can add a disable toggle).
import type { ValidationRuleSpec } from "./runRules.ts";

export const BUILTIN_VALIDATION_RULES: ValidationRuleSpec[] = [
  { id: "builtin:email-required", name: "Email required", field: "email", checkType: "required", config: {} },
  { id: "builtin:email-format", name: "Valid email format", field: "email", checkType: "email_format", config: {} },
  {
    id: "builtin:first-name-required",
    name: "First name required",
    field: "firstName",
    checkType: "required",
    config: {},
  },
];
