// customFields.ts — Zod schemas + inferred types for the workspace-scoped record-customization layer
// (ADR-0028, 03 §14/§15, 05 §7, gap G-REV-5). Single source of truth shared by apps/api, apps/workers,
// apps/web and packages/core. The registry (`custom_field_definitions`) describes typed fields; the values
// live in a typed-jsonb `custom_fields` column on contacts/accounts (NOT EAV, NOT physical columns).
// Enums mirror the 03 §14 design + the customFields.ts CHECK constraints exactly. Validation lives here.

import { z } from "zod";

// ── Enums (mirror the custom_field_definitions CHECK constraints) ─────────────────────────────────────────
/** Which record a definition customizes. The two overlay records that carry a `custom_fields` jsonb column. */
export const customFieldEntity = z.enum(["contact", "account"]);
export type CustomFieldEntity = z.infer<typeof customFieldEntity>;

/**
 * The supported field types (ADR-0028 — 'select' is the ADR's 'enum'; the multi/user/url variants in the ADR
 * are deferred beyond url). Each maps to a concrete value-validation rule in packages/core/validateValue.
 */
export const customFieldType = z.enum(["text", "number", "date", "select", "boolean", "url"]);
export type CustomFieldType = z.infer<typeof customFieldType>;

/**
 * A definition `key` is the immutable jsonb storage key: lowercase, starts with a letter, then
 * letters/digits/underscores. Bounded so a key never bloats the jsonb document. Immutable post-create.
 */
export const customFieldKey = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Key must be lowercase letters, digits, or underscores, starting with a letter.",
  );

// ── Definition CRUD requests ──────────────────────────────────────────────────────────────────────────────
/**
 * POST /custom-fields — create a definition. `options` is required-and-non-empty for `select`, forbidden
 * otherwise (enforced by the superRefine below + the core validator). `key` is immutable once created.
 */
export const createCustomFieldSchema = z
  .object({
    entity: customFieldEntity,
    key: customFieldKey,
    label: z.string().min(1).max(120),
    field_type: customFieldType,
    options: z.array(z.string().min(1).max(120)).max(100).optional(),
    required: z.boolean().optional(),
    ordering: z.number().int().min(0).max(10000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.field_type === "select") {
      if (!v.options || v.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "A 'select' field needs at least one option.",
        });
      }
    } else if (v.options && v.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Only a 'select' field may carry options.",
      });
    }
  });
export type CreateCustomFieldRequest = z.infer<typeof createCustomFieldSchema>;

/**
 * PATCH /custom-fields/:id — mutate a definition. `key`, `entity` and `field_type` are immutable (the jsonb
 * storage contract); only the editorial surface (label/options/required/ordering/archived) changes.
 */
export const updateCustomFieldSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    options: z.array(z.string().min(1).max(120)).max(100).optional(),
    required: z.boolean().optional(),
    ordering: z.number().int().min(0).max(10000).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update." });
export type UpdateCustomFieldRequest = z.infer<typeof updateCustomFieldSchema>;

// ── Value mutation request ────────────────────────────────────────────────────────────────────────────────
/**
 * PATCH /<entity>/:id/custom-fields — set values, shallow-merged into the record's `custom_fields` jsonb
 * (existing || incoming — 03 §15.3). A null value clears that one key. Each value is validated against its
 * definition by type before persisting (packages/core/validateValue).
 */
export const setCustomFieldValuesSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type SetCustomFieldValuesRequest = z.infer<typeof setCustomFieldValuesSchema>;

/** The runtime shape a custom-field value may take before validation (one jsonb leaf). */
export type CustomFieldValueInput = string | number | boolean | null;

// ── DTOs (GET responses) ──────────────────────────────────────────────────────────────────────────────────
/** One field definition as the API returns it (the registry row, camelCased for the web slice). */
export interface CustomFieldDefinitionDto {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[] | null;
  required: boolean;
  archived: boolean;
  ordering: number;
}

/** GET /<entity>/:id/custom-fields — a record's values joined to their (non-archived) definitions, ordered. */
export interface CustomFieldValueDto {
  key: string;
  label: string;
  fieldType: CustomFieldType;
  /** Allowed values for a `select` field (so editors can render a constrained dropdown); null otherwise. */
  options: string[] | null;
  value: CustomFieldValueInput;
}
