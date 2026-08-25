// databaseSearch.ts — the contract for the GLOBAL database search (Layer-0-as-database plan, slice 2):
// searching every person the PLATFORM holds, not just the workspace's own contacts. Deliberately a
// separate contract from `search.ts` (the overlay `ContactQuery`/`MaskedContact`), because the answers are
// different kinds of thing: an overlay hit is a record the workspace OWNS (it has an id, an owner, reveal
// state); a database hit is a person the platform can SELL — addressed by its public URL, with no id, no
// channel values and no Layer-0 identifier of any kind crossing the API boundary.
import { z } from "zod";
import { seniorityLevel } from "./contacts.ts";

/** The facets a database search may filter on (each maps to an indexed Layer-0 column). */
/**
 * The fields the GLOBAL people search can filter on.
 *
 * The first five are flat columns on `master_persons` (or its current-employer join). The rest are
 * SATELLITE facts — one row per (person, value) in a Layer-0 edge table — answered by a correlated EXISTS.
 * They exist here and nowhere else on purpose: the workspace overlay holds none of this data and its role
 * (`leadwolf_app`) is REVOKEd from every `master_*` table, so these questions are answerable by the global
 * engine or not at all. The client marks them `database-only` and skips the workspace half when one is
 * active — see `facetScope` in the web app's filterGroups.
 */
export const databaseFacetKey = z.enum([
  "title",
  "company",
  "location",
  "seniority",
  "industry",
  // Satellite facts (EXISTS-backed). Indexed by migration 0135, which was written for exactly these.
  "skill",
  "language",
  "school",
  "field_of_study",
]);
export type DatabaseFacetKey = z.infer<typeof databaseFacetKey>;

export const databaseTermFilter = z.object({
  kind: z.literal("term"),
  field: databaseFacetKey,
  /**
   * ADDITIVE (defaults "include"), and it closes a real gap: before this the global contract had no exclude,
   * so `toDatabaseQuery` had to return null for ANY excluding query — one "not in Recruiting" clause and the
   * whole database half of the People grid silently vanished. Bailing out was the honest behaviour given the
   * contract; the fix is the contract.
   */
  op: z.enum(["include", "exclude"]).default("include"),
  values: z.array(z.string().min(1)).min(1),
});
export type DatabaseTermFilter = z.infer<typeof databaseTermFilter>;

export const databaseBoolFilter = z.object({
  kind: z.literal("bool"),
  field: z.enum(["has_email", "has_phone"]),
  value: z.boolean(),
});
export type DatabaseBoolFilter = z.infer<typeof databaseBoolFilter>;

export const databaseFilter = z.union([databaseTermFilter, databaseBoolFilter]);
export type DatabaseFilter = z.infer<typeof databaseFilter>;

export const databaseQuery = z.object({
  text: z.string().trim().max(200).optional(),
  filters: z.array(databaseFilter).default([]),
  /** Opaque keyset cursor (base64url of {k,s}) — never contains a Layer-0 id. */
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type DatabaseQuery = z.infer<typeof databaseQuery>;

/** One database person as the customer sees it: profile facts + the URL-shaped addressing key. */
export const maskedDatabasePersonSchema = z.object({
  linkedinPublicId: z.string(),
  linkedinUrl: z.string(),
  fullName: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  headline: z.string().nullable(),
  jobTitle: z.string().nullable(),
  seniorityLevel: seniorityLevel.nullable(),
  locationRaw: z.string().nullable(),
  locationCity: z.string().nullable(),
  locationCountry: z.string().nullable(),
  companyName: z.string().nullable(),
  companyDomain: z.string().nullable(),
  companyIndustry: z.string().nullable(),
  /** Presence facets only — the values are a paid reveal, and only after the person is in the workspace. */
  hasEmail: z.boolean(),
  hasPhone: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
  /** Set when THIS workspace already holds the person (RLS-scoped join back to the overlay). */
  inWorkspace: z.object({ contactId: z.string().uuid(), isRevealed: z.boolean() }).nullable(),
});
export type MaskedDatabasePerson = z.infer<typeof maskedDatabasePersonSchema>;

export const databaseSearchPage = z.object({
  hits: z.array(maskedDatabasePersonSchema),
  nextCursor: z.string().nullable(),
});
export type DatabaseSearchPage = z.infer<typeof databaseSearchPage>;

/**
 * The ceiling both global counts stop at. It lives in the CONTRACT rather than in a repository because it
 * is what `capped: true` means: the server counted to here and stopped, so the number is a floor. The two
 * repositories and the web client all read this one value, and the grid's "10,000+" is derived from it
 * rather than hard-coded next to it.
 */
export const DATABASE_COUNT_CAP = 10_000;

/**
 * `capped` true means the server stopped counting at DATABASE_COUNT_CAP and the total is a FLOOR — render it
 * as "10,000+", never as an exact number. ADDITIVE (defaults false), so an older client that ignores the
 * field behaves exactly as before.
 *
 * WHY CAP AT ALL. This count used to be exact and uncapped. An exact count over a trgm-filtered population
 * has unbounded cost as the graph grows, and nothing bills or gates off this number — it is a grid header.
 * The workspace contact count made the same trade at the same 10k ceiling (CONTACT_COUNT_CAP).
 */
export const databaseCountResult = z.object({
  total: z.number().int().nonnegative(),
  capped: z.boolean().default(false),
});
export type DatabaseCountResult = z.infer<typeof databaseCountResult>;
