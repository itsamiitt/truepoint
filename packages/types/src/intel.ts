// intel.ts — shared vocabulary for the intelligence layer (03 §6, ADR-0008) and the enrichment engine
// (06 §3): intent-signal types, the score breakdown contract, and the provider-facing enrichment DTOs.
// Lead score (prospect quality) is DISTINCT from email_status (field correctness) — never conflate.

import { z } from "zod";

// ── Intent signals (03 §6) ─────────────────────────────────────────────────────────────────────────────
//
// NOT EVERY VALUE HERE IS BUILDABLE, and the enum does not say so on its own — which is the trap this
// comment exists to close (intelligence-platform conflict C10). As of the 07 §2 audit:
//   • job_change    — has a producer (recordJobChange), triggered by the workers' job-change sweep.
//   • tech_install / funding_round — have CONSUMERS (firmographics.ts rolls them into account facets) but
//     no producer anywhere in the repo. They wait on a licensed feed; see conflict C4/RD-7.
//   • web_visit · content_engagement · keyword_search — these ARE intent data, which
//     `docs/strategy/04-opportunity-scores.md` lists as DEFERRED NON-GOAL X-04. Do not build a producer
//     without an explicit human decision recorded in decisions.md.
//   • linkedin_activity · sales_nav_view — could only be populated by means CLAUDE.md hard-constraint 4
//     forbids outright (background/bulk scraping of logged-in sites; collection beyond user-initiated
//     extension actions). These are NOT a roadmap.
//
// The five un-populatable values are kept rather than removed on purpose: this is a shipped zod schema and
// rows may already reference it, so deleting a member is a breaking change to fix a documentation problem.
export const signalType = z.enum([
  "job_change",
  "new_hire",
  "funding_round",
  "tech_install",
  "web_visit",
  "content_engagement",
  "keyword_search",
  "linkedin_activity",
  "sales_nav_view",
]);
export type SignalType = z.infer<typeof signalType>;

// ── Versioned scores (ADR-0008): every re-score APPENDS a row; the breakdown explains the math ─────────
export const scoreBreakdownSchema = z.object({
  icpFit: z.record(z.string(), z.number()), // factor → contribution (0–100 scale)
  intent: z.array(z.object({ signalType: signalType, weight: z.number() })),
  engagement: z.record(z.string(), z.number()),
  weights: z.object({ icpFit: z.number(), intent: z.number(), engagement: z.number() }),
});
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

export const scoreRowSchema = z.object({
  icpFit: z.number().int().min(0).max(100),
  intentScore: z.number().int().min(0).max(100),
  engagementScore: z.number().int().min(0).max(100),
  compositeScore: z.number().int().min(0).max(100),
  breakdown: scoreBreakdownSchema,
});
export type ScoreRow = z.infer<typeof scoreRowSchema>;

// ── Enrichment (06 §3): the provider-agnostic contract DTOs ────────────────────────────────────────────
export const enrichCapability = z.enum([
  "contact.email",
  "contact.phone",
  "contact.profile",
  "account.firmographics",
  "account.domain",
  "email.verify",
]);
export type EnrichCapability = z.infer<typeof enrichCapability>;

export const enrichField = z.enum(["email", "phone", "jobTitle", "seniorityLevel", "department"]);
export type EnrichField = z.infer<typeof enrichField>;

/**
 * The provider ids a workspace may order/disable and the API validates `providerOrder` against — the
 * single source shared by api validation, the platform-admin allowlist, and the web settings panel
 * (waterfall v2, 06 §4: "the ordering is configurable, not hardcoded"). Ids match EnrichmentProvider.name
 * and provider_configs.provider exactly. Adding a vendor = one entry here + an adapter + a sourceName
 * member (contacts.ts) + the source_imports CHECK — grep 0109 for the checklist.
 */
export const KNOWN_ENRICH_PROVIDERS = [
  { provider: "apollo", label: "Apollo" },
  { provider: "zoominfo", label: "ZoomInfo" },
  { provider: "clearbit", label: "Clearbit" },
  { provider: "pdl", label: "People Data Labs" },
  { provider: "coresignal", label: "Coresignal" },
] as const;
export const knownEnrichProviderIds = KNOWN_ENRICH_PROVIDERS.map((p) => p.provider) as [
  string,
  ...string[],
];
/** A provider id from the known set — the validation for stored prefs and per-run overrides. */
export const enrichProviderId = z.enum(
  knownEnrichProviderIds as ["apollo", "zoominfo", "clearbit", "pdl", "coresignal"],
);
export type EnrichProviderId = z.infer<typeof enrichProviderId>;

export const enrichmentRequestSchema = z.object({
  fields: z.array(enrichField).min(1),
  /**
   * Per-RUN provider-order override (waterfall v2): tried before the workspace's saved
   * provider_prefs and the engine default. Validated against the known set; never persisted.
   */
  providerOrder: z.array(enrichProviderId).max(20).optional(),
});

/** 202 body when ENRICHMENT_ASYNC_ENABLED routes the enrich POST through the queue (waterfall v2). */
export const enrichmentTriggerAckSchema = z.object({
  queued: z.literal(true),
  jobId: z.string().min(1),
});
export type EnrichmentTriggerAck = z.infer<typeof enrichmentTriggerAckSchema>;

/** Per-tenant half of the waterfall-v2 DUAL GATE (0109). Effective v2 = the global WATERFALL_V2_ENABLED
 *  env kill-switch AND this flag (fail-closed via evaluateFlag: unknown flag = off). The shared key lives
 *  here so api/workers can never drift (the CHANNELS_DUAL_WRITE_FLAG_KEY precedent). */
export const ENRICHMENT_WATERFALL_V2_FLAG_KEY = "enrichment_waterfall_v2";

/**
 * The `enrichment` queue's job payload — the producer/consumer contract shared by the api's 202 producer
 * (ENRICHMENT_ASYNC_ENABLED) and the worker's processor (the ReverificationJobData precedent: the moment
 * a second app produces onto a queue, its payload contract moves to the leaf package). PII-free: ids +
 * field names only.
 */
export const enrichmentJobDataSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  contactId: z.string().uuid(),
  fields: z.array(enrichField).min(1),
  requestedByUserId: z.string().nullable().optional(),
  providerOrder: z.array(enrichProviderId).max(20).optional(),
  /** All-throttled deferral count (worker-internal) — bounds the re-enqueue loop; capped, never user-set. */
  deferrals: z.number().int().nonnegative().max(10).optional(),
});
export type EnrichmentJobData = z.infer<typeof enrichmentJobDataSchema>;

// ── Data quality & freshness (22, ADR-0025) ────────────────────────────────────────────────────────────
// freshness_status derives from age / re-verify-SLA (22 §3): <0.5 fresh, <1.0 aging, <1.5 stale, else expired.
// Distinct from data_quality_score (the 0–100 composite) and from email_status (single-field correctness).
export const freshnessStatus = z.enum(["fresh", "aging", "stale", "expired"]);
export type FreshnessStatus = z.infer<typeof freshnessStatus>;
