// accountIntelligence.ts — the contract for the customer READ surface over the Layer-0 graph (migration
// 0108). Lives in the LEAF types package so `apps/api` validates against the same shapes the web client
// derives its types from, and neither can drift from the other (api-contract §1).
//
// THE ONE INVARIANT THIS FILE ENCODES: "what does this company BUILD" and "what does it RUN" are different
// facts, from different tables (master_technology_vendors vs master_technology_adoptions), and there is no
// response shape that merges them. `relationship` is a REQUIRED discriminant on both the request and the
// response, and the per-row payloads differ — a `develops` row carries ownership/launch, a `uses` row
// carries detection method/recency. A caller that conflates them cannot even typecheck.
//
// NO PERSONAL DATA crosses this contract: technology, vendor and adoption rows describe ORGANIZATIONS. The
// education contract at the foot of this file is the one that touches a person, and it carries no contact
// values — only institution, degree and dates.

import { z } from "zod";

// ── Request ──────────────────────────────────────────────────────────────────────────────────────────────
/** The traversal to follow. Required — the API refuses to guess (400 `relationship_required`). */
export const orgTechnologyRelationship = z.enum(["develops", "uses"]);
export type OrgTechnologyRelationship = z.infer<typeof orgTechnologyRelationship>;

export const accountTechnologiesQuery = z.object({
  relationship: orgTechnologyRelationship,
  /** Comma-separated field groups. `vendors` expands each technology's creator on a `uses` read. */
  fields: z.string().optional(),
});
export type AccountTechnologiesQuery = z.infer<typeof accountTechnologiesQuery>;

// ── Response rows (discriminated on `relationship`) ───────────────────────────────────────────────────────
const technologyBase = {
  technology_id: z.string().uuid(),
  slug: z.string(),
  canonical_name: z.string(),
  /** Fused belief for the edge, 0–1. Null while the confidence policy has nothing to fold. */
  confidence: z.number().min(0).max(1).nullable(),
};

/** A product the organization BUILDS — sourced from the vendor ledger, so it carries ownership, not detection. */
export const developsRow = z.object({
  ...technologyBase,
  relationship: z.literal("develops"),
  /** Which vendor claim backs this: it created the product, or it owns it today (e.g. post-acquisition). */
  ownership: z.enum(["creator", "current_owner"]),
  started_on: z.string().nullable(),
});
export type DevelopsRow = z.infer<typeof developsRow>;

/** Technology the organization RUNS — sourced from the adoption edge, so it carries detection provenance. */
export const usesRow = z.object({
  ...technologyBase,
  relationship: z.literal("uses"),
  detection_method: z.string(),
  first_seen_at: z.coerce.date(),
  /** Liveness is derived from RECENCY, not a status flag — a stale last_seen_at is what closes an episode. */
  last_seen_at: z.coerce.date(),
  source_count: z.number().int().nonnegative(),
  /** Present only with `fields=vendors`: who built the thing this company merely runs. */
  creator: z.object({ name: z.string() }).optional(),
});
export type UsesRow = z.infer<typeof usesRow>;

export const accountTechnologyRow = z.discriminatedUnion("relationship", [developsRow, usesRow]);
export type AccountTechnologyRow = z.infer<typeof accountTechnologyRow>;

export const accountTechnologiesResponse = z.object({
  relationship: orgTechnologyRelationship,
  /** false = this account has no Layer-0 bridge yet (ER has not matched it). Distinct from "bridged, but
   *  nothing found" — an empty list under `resolved:false` must never render as "builds nothing". */
  resolved: z.boolean(),
  technologies: z.array(accountTechnologyRow),
});
export type AccountTechnologiesResponse = z.infer<typeof accountTechnologiesResponse>;

// ── Education (the person→organization edge, 0108) ────────────────────────────────────────────────────────
export const educationRow = z.object({
  id: z.string().uuid(),
  // NOTE: master_company_id is deliberately NOT shipped. Nothing renders it (the school NAME is what a
  // reader wants), and a stable Layer-0 identifier handed to every tenant is a cross-tenant correlation key
  // for no gain. `resolved` below already answers "did ER match this institution".
  school_name: z.string().nullable(),
  /** True once ER matched the institution to a graph node — the raw assertion stands alone until then. */
  resolved: z.boolean(),
  /** 'school' once resolved against a school node; null while unresolved. */
  org_kind: z.string().nullable(),
  degree: z.string().nullable(),
  fields_of_study: z.array(z.string()),
  started_on: z.string().nullable(),
  ended_on: z.string().nullable(),
  /** DERIVED from ended_on, never stored — see the master_education header for why. */
  completed: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  source_count: z.number().int().nonnegative(),
});
export type EducationRowDto = z.infer<typeof educationRow>;

export const contactEducationResponse = z.object({
  resolved: z.boolean(),
  education: z.array(educationRow),
});
export type ContactEducationResponse = z.infer<typeof contactEducationResponse>;
