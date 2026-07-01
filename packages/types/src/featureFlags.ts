// featureFlags.ts — shared vocabulary + DTOs for the platform feature-flag system (13 §3.5, ADR-0011).
// Flags are GLOBAL (the platform-managed feature_flags table) with optional PER-TENANT overrides
// (tenant_feature_flags). The admin endpoints in apps/api validate against these schemas; the schemas
// here are the source of truth, mirrored as columns/CHECKs in packages/db/src/schema/featureFlags.ts.

import { z } from "zod";

// A flag key is a stable, lowercase dotted identifier (e.g. "bulk_enrich", "search.semantic"). Kept short
// and machine-safe so it can live in code gates and URLs without escaping.
export const featureFlagKey = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "lowercase dotted/underscored identifier");
export type FeatureFlagKey = z.infer<typeof featureFlagKey>;

// ── A flag definition (one row of feature_flags). `default` is the fallback when neither global_enabled
// nor a tenant override decides; surfaced as `defaultEnabled` (default is a reserved word). ───────────────
export const featureFlagSchema = z.object({
  key: featureFlagKey,
  description: z.string().max(500).nullable(),
  globalEnabled: z.boolean(),
  defaultEnabled: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type FeatureFlag = z.infer<typeof featureFlagSchema>;

// A per-tenant override (one row of tenant_feature_flags): forces the flag on/off for that tenant only.
export const tenantFeatureFlagSchema = z.object({
  flagKey: featureFlagKey,
  tenantId: z.string().uuid(),
  enabled: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type TenantFeatureFlag = z.infer<typeof tenantFeatureFlagSchema>;

// ── Admin request DTOs ───────────────────────────────────────────────────────────────────────────────────
// Define / upsert a flag (super-admin only). Idempotent on key.
export const featureFlagUpsertSchema = z.object({
  key: featureFlagKey,
  description: z.string().max(500).optional(),
  global_enabled: z.boolean().optional(),
  default: z.boolean().optional(),
});
export type FeatureFlagUpsert = z.infer<typeof featureFlagUpsertSchema>;

// Toggle a flag globally.
export const featureFlagGlobalToggleSchema = z.object({ enabled: z.boolean() });
export type FeatureFlagGlobalToggle = z.infer<typeof featureFlagGlobalToggleSchema>;

// Set or clear a per-tenant override. `enabled: null` clears the override (falls back to global/default).
export const featureFlagTenantToggleSchema = z.object({
  tenant_id: z.string().uuid(),
  enabled: z.boolean().nullable(),
});
export type FeatureFlagTenantToggle = z.infer<typeof featureFlagTenantToggleSchema>;

// ── Admin response DTOs ──────────────────────────────────────────────────────────────────────────────────
// A flag row plus its current overrides, for the admin list/detail screen.
export const featureFlagWithOverridesSchema = featureFlagSchema.extend({
  overrides: z.array(z.object({ tenantId: z.string().uuid(), enabled: z.boolean() })),
});
export type FeatureFlagWithOverrides = z.infer<typeof featureFlagWithOverridesSchema>;

export const featureFlagListSchema = z.object({
  flags: z.array(featureFlagWithOverridesSchema),
});
export type FeatureFlagList = z.infer<typeof featureFlagListSchema>;

// The evaluation result for a single flag in a tenant context — and where the decision came from.
export const flagEvaluationSource = z.enum(["tenant_override", "global", "default", "unknown"]);
export type FlagEvaluationSource = z.infer<typeof flagEvaluationSource>;

export const flagEvaluationSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  source: flagEvaluationSource,
});
export type FlagEvaluation = z.infer<typeof flagEvaluationSchema>;

// ── Env master-switch gates (read-only) ──────────────────────────────────────────────────────────────────
// A deploy-time env boolean that gates a feature at the process level (a master kill-switch). These are NOT
// UI-toggleable (a running process reads them at boot) — the admin console surfaces their STATE read-only so
// staff can see the full gate picture. `flagKey` names the per-tenant feature_flags flag it dual-gates with
// (both must be on for the feature to be live for a tenant), or null when the env switch is the only gate.
export const envFeatureGateSchema = z.object({
  key: z.string(), // the env var name, e.g. "BULK_IMPORT_ENABLED"
  label: z.string(), // human feature name
  description: z.string(),
  enabled: z.boolean(), // current process state
  flagKey: featureFlagKey.nullable(), // the per-tenant flag it pairs with (dual-gate), or null
});
export type EnvFeatureGate = z.infer<typeof envFeatureGateSchema>;

export const envFeatureGatesResponseSchema = z.object({ gates: z.array(envFeatureGateSchema) });
export type EnvFeatureGatesResponse = z.infer<typeof envFeatureGatesResponseSchema>;
