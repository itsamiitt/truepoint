// types.ts — view-model types for the provider-configs admin slice. The MASKED config shape only: secrets
// (API keys) are NEVER sent to the client — keyHint is a non-reversible last-4/preview the API computes.
// Domain types proper live in @leadwolf/types/integrations once the admin provider-config endpoints land.

export interface ProviderConfigView {
  /** Provider id, e.g. "apollo" | "zoominfo" | "clearbit". */
  provider: string;
  /** Human label. */
  label: string;
  enabled: boolean;
  /** Masked key indicator only — e.g. "••••4f2a" or null when no key is set. Never the secret itself. */
  keyHint: string | null;
  /** Requests/min cap, or null for unlimited. */
  rateLimitPerMin: number | null;
  /** Monthly cost budget in cents, or null for unset. */
  monthlyBudgetCents: number | null;
  /** Month-to-date spend in cents (read-only). */
  monthToDateCents: number | null;
  /** Coarse health, surfaced by the API's provider health check. */
  health: "healthy" | "degraded" | "down" | "unknown";
}
