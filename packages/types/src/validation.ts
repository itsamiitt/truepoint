// validation.ts — the data-quality validation framework contract (database-management-research 06). GLOBAL,
// staff-authored rules (your team sets them) that an imported row must pass; a row failing ANY enabled rule is
// REJECTED (reject-on-fail). Built-in rules are seeded and can be disabled but not deleted; custom rules are
// authored via the rule builder. The pure engine in @leadwolf/core runs these rules against a prepared row.

import { z } from "zod";

/** The kind of check a rule performs against one canonical field. */
export const validationCheckType = z.enum([
  "required", // the field must be present and non-empty
  "email_format", // the field must look like a syntactically valid email
  "regex", // the field must match config.pattern
  "max_length", // the field's length must be <= config.maxLength
  "one_of", // the field must be one of config.allowed
]);
export type ValidationCheckType = z.infer<typeof validationCheckType>;

/** Per-check configuration — only the keys relevant to the checkType are read. */
export const validationRuleConfigSchema = z.object({
  pattern: z.string().max(500).optional(), // for regex
  maxLength: z.number().int().positive().optional(), // for max_length
  allowed: z.array(z.string()).max(500).optional(), // for one_of
});
export type ValidationRuleConfig = z.infer<typeof validationRuleConfigSchema>;

/** A global validation rule: which canonical field to check, the check, its config, and whether it's active.
 *  `field` is a canonical contact field key (e.g. "email", "firstName", "company"). */
export const validationRuleSchema = z.object({
  id: z.string().min(1), // a uuid for custom rules; a "builtin:*" key for the code-defined built-ins
  name: z.string().min(1).max(120),
  field: z.string().min(1).max(60),
  checkType: validationCheckType,
  config: validationRuleConfigSchema,
  enabled: z.boolean(),
  builtin: z.boolean(), // seeded built-ins can be disabled but not deleted
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ValidationRule = z.infer<typeof validationRuleSchema>;

/** Create or update a custom rule (the rule-builder form). `id` present = update an existing custom rule. */
export const upsertValidationRuleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  field: z.string().min(1).max(60),
  checkType: validationCheckType,
  config: validationRuleConfigSchema.default({}),
  enabled: z.boolean().default(true),
});
export type UpsertValidationRuleInput = z.infer<typeof upsertValidationRuleSchema>;

/** Toggle a rule on/off by id (built-ins included — they can be disabled, not deleted). */
export const toggleValidationRuleSchema = z.object({ enabled: z.boolean() });
export type ToggleValidationRuleInput = z.infer<typeof toggleValidationRuleSchema>;

/** One rule failure on a row — the per-field reject reason the engine returns. Non-PII (rule + field + a
 *  reason code), so it is safe to surface in the staff reject-reason histogram. */
export interface ValidationFailure {
  ruleId: string;
  field: string;
  message: string;
}
