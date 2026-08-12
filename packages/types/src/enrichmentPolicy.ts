// enrichmentPolicy.ts — the per-workspace auto-enrich policy contract (G-ENR-1; 28 §3.4, 29 §3, 06 §4.1).
// Single source of truth shared by apps/api (the settings endpoint), packages/core (the enforcement guard),
// and apps/web (the settings panel). Validation lives here; the enforcement LOGIC lives in core. The field
// allowlist reuses the existing `enrichField` value set (intel.ts) — never a second enrichment vocabulary.

import { z } from "zod";
import { enrichField, enrichProviderId } from "./intel.ts";

// ── Triggers (when auto-enrich is allowed to fire) ───────────────────────────────────────────────────────
/**
 * The events that may trigger auto-enrichment under the policy (29 §3): `on_import` (a freshly imported
 * file — the 06 §4.1 enrich-on-import step), `on_reveal` (after a reveal completes), and `on_stale`
 * (the scheduled re-verify/re-enrich cadence of ADR-0025). The policy enables a SUBSET; system-initiated
 * enrichment with no matching trigger is denied.
 */
export const enrichTrigger = z.enum(["on_import", "on_reveal", "on_stale"]);
export type EnrichTrigger = z.infer<typeof enrichTrigger>;

// ── Provider priority + verification (waterfall v2; 06 §4 "ordering is configurable, not hardcoded") ────
/**
 * The workspace's saved provider preferences, stored in `enrichment_policy.provider_prefs`. Per-FIELD
 * ordering (an email order and a phone order — different vendors are strong at different fields) plus a
 * `disabled` set subtracted from every run. `version` is a literal so conditional/ICP or telemetry-driven
 * rule shapes can ship later as `version: 2` without a migration. An empty/missing object means "engine
 * defaults" (trust ÷ cost ordering, nothing disabled) — configuring nothing changes nothing.
 */
export const providerPrioritySchema = z.object({
  version: z.literal(1),
  email: z.array(enrichProviderId).max(20),
  phone: z.array(enrichProviderId).max(20),
  disabled: z.array(enrichProviderId).max(50),
});
export type ProviderPriority = z.infer<typeof providerPrioritySchema>;

/** Catch-all verdict policy: accept as-is, keep cascading to the next provider, or accept-but-flag. */
export const acceptCatchAll = z.enum(["accept", "continue", "flag"]);
export type AcceptCatchAll = z.infer<typeof acceptCatchAll>;

/**
 * Verify-before-accept knobs (waterfall v2, S-08): a provider's email candidate is verified before the
 * field is accepted; `invalid` always cascades to the next provider. `flag` (the default) accepts a
 * catch_all but persists `email_status='catch_all'` so the badge/reveal pricing see it. Verification is
 * a no-op until a verifier backend (REACHER_BACKEND_URL) is configured — the pass-through verifier
 * returns the current status unchanged. Phone verification is opt-in (metered, jurisdiction-sensitive).
 */
export const verificationPolicySchema = z.object({
  verifyEmailBeforeAccept: z.boolean(),
  acceptCatchAll,
  verifyPhone: z.boolean(),
});
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;

export const DEFAULT_PROVIDER_PRIORITY: ProviderPriority = {
  version: 1,
  email: [],
  phone: [],
  disabled: [],
};

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  verifyEmailBeforeAccept: true,
  acceptCatchAll: "flag",
  verifyPhone: false,
};

// ── The policy (the full, resolved shape the API returns and the guard reads) ────────────────────────────
/**
 * A workspace's auto-enrich policy. `monthlyBudgetMicros` caps the provider spend auto-enrich may incur in a
 * calendar month (micros = millionths of a credit/USD, the unit `provider_calls.cost_micros` uses, 06 §6);
 * `0` means "no auto-enrich spend allowed". `fieldAllowlist` bounds which fields auto-enrich may fill — an
 * empty list means no field is permitted (fail-closed), so enabling the policy without choosing fields is a
 * no-op rather than an unbounded fill.
 */
export const enrichmentPolicySchema = z.object({
  enabled: z.boolean(),
  triggers: z.array(enrichTrigger),
  fieldAllowlist: z.array(enrichField),
  monthlyBudgetMicros: z.number().int().nonnegative(),
  providerPriority: providerPrioritySchema,
  verification: verificationPolicySchema,
});
export type EnrichmentPolicy = z.infer<typeof enrichmentPolicySchema>;

/**
 * The PATCH body for the settings endpoint — every field optional so a caller can flip one knob without
 * resending the whole policy. Arrays, when present, REPLACE the stored list (last-writer-wins per the
 * overlay convention). Empty object is a valid no-op.
 */
export const updateEnrichmentPolicySchema = z
  .object({
    enabled: z.boolean(),
    triggers: z.array(enrichTrigger),
    fieldAllowlist: z.array(enrichField),
    monthlyBudgetMicros: z.number().int().nonnegative(),
    providerPriority: providerPrioritySchema,
    verification: verificationPolicySchema,
  })
  .partial();
export type UpdateEnrichmentPolicy = z.infer<typeof updateEnrichmentPolicySchema>;

/**
 * The GET/PATCH response: the resolved policy plus the live month-to-date provider spend, so the settings
 * UI can show the budget burn next to the cap (29 §3: "Data Health shows policy + burn") without a second
 * round-trip. `monthlySpentMicros` is read-only (server-computed from `provider_calls`).
 */
export const enrichmentPolicyResponseSchema = enrichmentPolicySchema.extend({
  monthlySpentMicros: z.number().int().nonnegative(),
});
export type EnrichmentPolicyResponse = z.infer<typeof enrichmentPolicyResponseSchema>;

// ── Defaults (off, per 29 §3 — auto-enrich is opt-in) ────────────────────────────────────────────────────
/**
 * The default policy a workspace has before it configures one (off by default, 29 §3 / 06 §4.1). Used by the
 * repository's `get` when no row exists and by the guard so an unconfigured workspace never auto-enriches.
 */
export const DEFAULT_ENRICHMENT_POLICY: EnrichmentPolicy = {
  enabled: false,
  triggers: [],
  fieldAllowlist: [],
  monthlyBudgetMicros: 0,
  providerPriority: DEFAULT_PROVIDER_PRIORITY,
  verification: DEFAULT_VERIFICATION_POLICY,
};
