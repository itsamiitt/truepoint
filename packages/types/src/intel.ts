// intel.ts — shared vocabulary for the intelligence layer (03 §6, ADR-0008) and the enrichment engine
// (06 §3): intent-signal types, the score breakdown contract, and the provider-facing enrichment DTOs.
// Lead score (prospect quality) is DISTINCT from email_status (field correctness) — never conflate.

import { z } from "zod";

// ── Intent signals (03 §6) ─────────────────────────────────────────────────────────────────────────────
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

export const enrichmentRequestSchema = z.object({
  fields: z.array(enrichField).min(1),
});

// ── Data quality & freshness (22, ADR-0025) ────────────────────────────────────────────────────────────
// freshness_status derives from age / re-verify-SLA (22 §3): <0.5 fresh, <1.0 aging, <1.5 stale, else expired.
// Distinct from data_quality_score (the 0–100 composite) and from email_status (single-field correctness).
export const freshnessStatus = z.enum(["fresh", "aging", "stale", "expired"]);
export type FreshnessStatus = z.infer<typeof freshnessStatus>;
