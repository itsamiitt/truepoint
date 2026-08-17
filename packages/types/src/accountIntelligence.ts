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

/** What kind of institution an account resolved to (0108). The UI stops saying "company" for a university. */
export const orgKind = z.enum(["company", "school", "nonprofit", "government", "other"]);
export type OrgKind = z.infer<typeof orgKind>;

export const accountTechnologiesResponse = z.object({
  relationship: orgTechnologyRelationship,
  /** false = this account has no Layer-0 bridge yet (ER has not matched it). Distinct from "bridged, but
   *  nothing found" — an empty list under `resolved:false` must never render as "builds nothing". */
  resolved: z.boolean(),
  /** Null until the bridge resolves. Lets the drawer adapt its labels to what the institution actually is. */
  org_kind: orgKind.nullable(),
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

// ── Signals on a contact (plan 33 · Track C; audit 32 · A2) ───────────────────────────────────────────────
// Reads the TENANT-private intent_signals table, not the Layer-0 signal store — so this crosses no wall and
// needs no er transaction. It is also the one signal surface with real data: recordJobChange (the S-13
// sweep) writes job_change rows today.
//
// ⚠ HONESTY ABOUT COVERAGE. The signal_type CHECK admits nine values, but only `job_change` has a producer.
// `tech_install` and `funding_round` have consumers and no writer; the web/content/keyword family is the
// deferred X-04 non-goal; the LinkedIn-derived pair is forbidden outright by hard-constraint 4. A UI that
// lists the nine as categories would advertise coverage that cannot exist — so this contract ships the rows
// that ARE there and nothing else. Never render an empty bucket per type.
export const contactSignal = z.object({
  signal_type: z.string(),
  /** Scoring weight as recorded. Exposed because "why did this contact score up" should be answerable. */
  weight: z.number(),
  detected_at: z.coerce.date(),
});
export type ContactSignalDto = z.infer<typeof contactSignal>;

export const contactSignalsResponse = z.object({
  signals: z.array(contactSignal),
});
export type ContactSignalsResponse = z.infer<typeof contactSignalsResponse>;

// ── Displacement: what an organization recently STOPPED running (plan 33 · Track C) ───────────────────────
// The sales trigger. Sourced from closed adoption episodes (`removed_at`), never inferred from an absence —
// an absence is indistinguishable from "we never detected it in the first place".
export const removedTechnology = z.object({
  technology_id: z.string().uuid(),
  slug: z.string(),
  canonical_name: z.string(),
  detection_method: z.string(),
  first_seen_at: z.coerce.date(),
  /** The last time it WAS detected — with removed_at, this brackets how long they ran it. */
  last_seen_at: z.coerce.date(),
  removed_at: z.coerce.date(),
});
export type RemovedTechnologyDto = z.infer<typeof removedTechnology>;

export const accountDisplacementResponse = z.object({
  resolved: z.boolean(),
  within_days: z.number().int().positive(),
  removed: z.array(removedTechnology),
});
export type AccountDisplacementResponse = z.infer<typeof accountDisplacementResponse>;

// ── Peer adopters: which of MY OTHER accounts run this too (plan 33 · Track C) ────────────────────────────
// The reverse traversal, deliberately NOT built as a second global technology filter.
//
// Account search already has a `technology` facet, and it reads accounts.technologies — the per-workspace
// rollup INFERRED from intent signals. Adding a competing Layer-0 filter beside it would give the product
// two "filter by technology" controls backed by different datasets, which is exactly the confusion this whole
// model exists to remove, and it would pre-empt a cutover decision that is the owner's to make (plan 33 §6).
//
// So the reverse traversal is scoped to ONE technology reached from ONE account the caller already has open:
// "who else in your workspace runs this", answered through the overlay under RLS. Useful, and it creates no
// second filter to reconcile.
export const peerAdopter = z.object({
  account_id: z.string().uuid(),
  name: z.string(),
  domain: z.string().nullable(),
  last_seen_at: z.coerce.date(),
});
export type PeerAdopterDto = z.infer<typeof peerAdopter>;

export const technologyPeersResponse = z.object({
  technology_id: z.string().uuid(),
  /** Accounts in the caller's workspace, excluding the one they are looking at. */
  peers: z.array(peerAdopter),
});
export type TechnologyPeersResponse = z.infer<typeof technologyPeersResponse>;

// ── Alumni: the caller's OWN contacts who studied at an institution (plan 33 · Track C) ───────────────────
// Deliberately NOT "everyone in the graph who studied there". That answer spans every tenant and would leak
// the population of a dataset the caller has not earned; this is the reverse bridge, mapped back through the
// overlay under RLS, which is both the useful question and the only askable one.
export const alumniContact = z.object({
  contact_id: z.string().uuid(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  job_title: z.string().nullable(),
  degree: z.string().nullable(),
  ended_on: z.string().nullable(),
});
export type AlumniContactDto = z.infer<typeof alumniContact>;

export const accountAlumniResponse = z.object({
  resolved: z.boolean(),
  /** True when the bridged institution is actually a school — the caller can hide the surface otherwise. */
  is_school: z.boolean(),
  alumni: z.array(alumniContact),
});
export type AccountAlumniResponse = z.infer<typeof accountAlumniResponse>;

// ── Employment (the other person→organization edge, plan 33 · A2) ─────────────────────────────────────────
// NOTE ON SHAPE vs REALITY: the import path mints a BARE edge — company, is_current, is_primary — with no
// title and no dates. The contract models the rich stint because enrichment will fill it, but a client must
// treat title/dates as usually-absent and render a company list rather than a timeline of blanks.
export const employmentStint = z.object({
  company_name: z.string().nullable(),
  org_kind: orgKind.nullable(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  seniority_level: z.string().nullable(),
  /** The '-infinity' "start unknown" sentinel is normalized away server-side; this is a real date or null. */
  started_on: z.string().nullable(),
  ended_on: z.string().nullable(),
  is_current: z.boolean(),
  /** The ONE edge that drives the person's headline employer. */
  is_primary: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  source_count: z.number().int().nonnegative(),
});
export type EmploymentStintDto = z.infer<typeof employmentStint>;

export const contactEmploymentResponse = z.object({
  resolved: z.boolean(),
  employment: z.array(employmentStint),
});
export type ContactEmploymentResponse = z.infer<typeof contactEmploymentResponse>;

// ── Multi-value person attributes (0116; linkedin-source-ingestion §read surfaces) ────────────────────
// Public professional facts only — no contact values, no Layer-0 ids. Suppression-safe by construction:
// erasure DELETES the underlying rows, so a suppressed subject reads as empty.
export const contactSkillDto = z.object({
  skill: z.string(),
  /** Corroboration count — how many independent assertions agree (the S-10 signal, not a ranking). */
  source_count: z.number().int().nonnegative(),
});
export const contactLanguageDto = z.object({
  name: z.string(),
  /** LinkedIn's five-level vocabulary, or null when the source asserted no level. */
  proficiency: z.string().nullable(),
});
export const contactAttributesResponse = z.object({
  resolved: z.boolean(),
  skills: z.array(contactSkillDto),
  languages: z.array(contactLanguageDto),
});
export type ContactAttributesResponse = z.infer<typeof contactAttributesResponse>;

// ── Company headcount series (0114; growth is DERIVED client-side — no stored rollups) ────────────────
export const headcountPointDto = z.object({
  /** First-of-month ISO date. */
  month: z.string(),
  employee_count: z.number().int().nonnegative(),
});
export const accountHeadcountResponse = z.object({
  resolved: z.boolean(),
  /** Newest-first monthly totals (job_function='' rows only). */
  series: z.array(headcountPointDto),
});
export type AccountHeadcountResponse = z.infer<typeof accountHeadcountResponse>;

// ── Provenance / confidence (plan 33 · A1) ────────────────────────────────────────────────────────────────
// The evidence behind a field, readable WITHOUT spending a credit. Until now the confidence model surfaced
// only inside RevealDialog, so a customer saw it at the moment they paid and never again.
//
// WHAT DELIBERATELY IS NOT HERE: contributor identity, source names, and the raw per-event log. The badge
// carries COUNTS, a recency, a band and the strongest method — the C-02 invariant that public surfaces show
// corroboration without exposing who corroborated. The repository enforces that in SQL; this schema is the
// second wall.
export const confidenceBandValue = z.enum(["high", "medium", "low", "unverified"]);
export type ConfidenceBandValue = z.infer<typeof confidenceBandValue>;

export const fieldProvenance = z.object({
  /** The field this evidence is about — 'email', 'phone', … */
  field: z.string(),
  /** The word the UI shows. A band, never the raw decimal — a false-precision number invites arguments. */
  band: confidenceBandValue,
  /** ISO of the most recent VALID-time observation (when a source vouched), not when we recorded it. */
  last_verified_at: z.string().nullable(),
  age_days: z.number().int().nonnegative().nullable(),
  /** Independent corroborating CHANNELS. One source asserting ten times is not ten sources. */
  source_count: z.number().int().nonnegative(),
  /** What the score was priced off, so "why is this low" is answerable without a support escalation. */
  strongest_method: z.string().nullable(),
});
export type FieldProvenanceDto = z.infer<typeof fieldProvenance>;

export const contactProvenanceResponse = z.object({
  /** false = no Layer-0 person bridge yet, so there is no evidence log to read — NOT "no evidence exists". */
  resolved: z.boolean(),
  /**
   * Empty when the record has no accepted assertions yet. Render nothing rather than a zero: most records
   * have no events until the provenance log fills, and "0 sources" reads as a verdict when it is an absence.
   */
  fields: z.array(fieldProvenance),
});
export type ContactProvenanceResponse = z.infer<typeof contactProvenanceResponse>;
