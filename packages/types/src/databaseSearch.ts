// databaseSearch.ts — the contract for the GLOBAL database search (Layer-0-as-database plan, slice 2):
// searching every person the PLATFORM holds, not just the workspace's own contacts. Deliberately a
// separate contract from `search.ts` (the overlay `ContactQuery`/`MaskedContact`), because the answers are
// different kinds of thing: an overlay hit is a record the workspace OWNS (it has an id, an owner, reveal
// state); a database hit is a person the platform can SELL — addressed by its public URL, with no id, no
// channel values and no Layer-0 identifier of any kind crossing the API boundary.
import { z } from "zod";
import { seniorityLevel } from "./contacts.ts";

/** The facets a database search may filter on (each maps to an indexed Layer-0 column). */
export const databaseFacetKey = z.enum(["title", "company", "location", "seniority", "industry"]);
export type DatabaseFacetKey = z.infer<typeof databaseFacetKey>;

export const databaseTermFilter = z.object({
  kind: z.literal("term"),
  field: databaseFacetKey,
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

export const databaseCountResult = z.object({ total: z.number().int().nonnegative() });
export type DatabaseCountResult = z.infer<typeof databaseCountResult>;
