// providerConfigs.ts — the platform-admin provider-config contract (13 §3.6). The MASKED view sent to the
// staff console (NEVER a provider secret) + the enable/budget mutation bodies. Single source of truth shared
// by apps/api (validates) and apps/admin (derives its view type). Provider keys live in env/KMS, never here.

import { z } from "zod";

export const providerHealth = z.enum(["healthy", "degraded", "down", "unknown"]);
export type ProviderHealth = z.infer<typeof providerHealth>;

/** The masked provider row shown in the staff console. `keyHint` is a non-reversible indicator, never the secret. */
export const providerConfigViewSchema = z.object({
  provider: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  keyHint: z.string().nullable(),
  rateLimitPerMin: z.number().int().nullable(),
  monthlyBudgetCents: z.number().int().nullable(),
  monthToDateCents: z.number().int().nullable(),
  health: providerHealth,
});
export type ProviderConfigView = z.infer<typeof providerConfigViewSchema>;

export const providerEnabledToggleSchema = z.object({ enabled: z.boolean() });
export type ProviderEnabledToggle = z.infer<typeof providerEnabledToggleSchema>;

// Monthly cost budget in cents — non-negative and capped to a sane ceiling ($1M/mo) so a fat-finger can't
// set an absurd budget.
export const providerBudgetSchema = z.object({
  monthly_budget_cents: z.number().int().nonnegative().max(100_000_000),
});
export type ProviderBudget = z.infer<typeof providerBudgetSchema>;
