// databaseProfile.ts — the contract for the GLOBAL profile reads (search-consolidation stage 3): opening
// the full masked Layer-0 profile of a person or a company WITHOUT first adding the record to a workspace.
//
// WHAT THIS IS NOT. It is not a relaxed permission. There has never been a `GET /contacts/:id`: contact
// detail is composed from a search hit plus sub-resources, every one of which takes a workspace contact
// UUID and resolves Layer-0 through the master_person_id bridge. This is net-new read surface.
//
// THE TWO INVARIANTS, both structural rather than conventional:
//
//   1. NO CHANNEL VALUES. master_emails / master_phones values never appear here. The profile carries
//      presence booleans (hasEmail / hasPhone / hasMobile) and nothing more. Reveal is unchanged —
//      credit-gated, entitlement-capped, and only for a record the workspace holds. A-01/A-03 hold.
//
//   2. NO WORKSPACE-OVERLAY FACT. No owner, stage, tags, activities, notes or reveal state. This is not a
//      UI choice: Layer 0 has no workspace column, so a global read has nothing workspace-scoped to leak.
//      The one workspace-derived field is `inWorkspace` on the masked row, produced under RLS from the
//      CALLER's own workspace.
//
// Sub-collections are BOUNDED server-side. An unbounded collection never leaves the API (api-contract), and
// these are the kind that grow quietly — a 40-year career, a scraped skill list.
import { z } from "zod";
import { maskedDatabaseCompanySchema } from "./databaseCompanySearch.ts";
import { maskedDatabasePersonSchema } from "./databaseSearch.ts";

export const MAX_PROFILE_EMPLOYMENT = 25;
export const MAX_PROFILE_EDUCATION = 10;
export const MAX_PROFILE_SKILLS = 50;
export const MAX_PROFILE_LANGUAGES = 10;
export const MAX_PROFILE_LOCATIONS = 10;
export const MAX_PROFILE_HEADCOUNT_POINTS = 36;

/** One employment stint. `startedOn` is null when the source gave no start — see the sentinel note below. */
export const databaseEmploymentStint = z.object({
  companyName: z.string().nullable(),
  companyDomain: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
  isCurrent: z.boolean(),
  isPrimary: z.boolean(),
  /**
   * NULL means "start unknown", NOT "started at year zero". master_employment.started_on defaults to the
   * '-infinity' sentinel so the dedup unique (person, company, started_on) collides for unknown starts;
   * the mapper turns that sentinel back into null. Treating it as a real date reads as ~2000 years of
   * tenure and would poison any duration shown here.
   */
  startedOn: z.string().nullable(),
  endedOn: z.string().nullable(),
  startPrecision: z.string().nullable(),
  endPrecision: z.string().nullable(),
});
export type DatabaseEmploymentStint = z.infer<typeof databaseEmploymentStint>;

export const databaseEducationEntry = z.object({
  schoolName: z.string().nullable(),
  degree: z.string().nullable(),
  fieldsOfStudy: z.array(z.string()),
  startedOn: z.string().nullable(),
  endedOn: z.string().nullable(),
});
export type DatabaseEducationEntry = z.infer<typeof databaseEducationEntry>;

export const databaseLanguage = z.object({
  name: z.string(),
  proficiency: z.string().nullable(),
});

export const databasePersonProfile = z.object({
  person: maskedDatabasePersonSchema,
  employment: z.array(databaseEmploymentStint).max(MAX_PROFILE_EMPLOYMENT),
  education: z.array(databaseEducationEntry).max(MAX_PROFILE_EDUCATION),
  skills: z.array(z.string()).max(MAX_PROFILE_SKILLS),
  languages: z.array(databaseLanguage).max(MAX_PROFILE_LANGUAGES),
  /** Presence only — the values are a paid reveal, and only once the person is in the workspace. */
  hasMobile: z.boolean(),
});
export type DatabasePersonProfile = z.infer<typeof databasePersonProfile>;

export const databaseCompanyLocation = z.object({
  kind: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  countryCode: z.string().nullable(),
});

export const databaseHeadcountPoint = z.object({
  month: z.string(),
  employeeCount: z.number().int(),
});

export const databaseCompanyProfile = z.object({
  company: maskedDatabaseCompanySchema,
  locations: z.array(databaseCompanyLocation).max(MAX_PROFILE_LOCATIONS),
  /** The monthly total series. Growth is DERIVED from it by the client, never stored (the 0114 posture). */
  headcountSeries: z.array(databaseHeadcountPoint).max(MAX_PROFILE_HEADCOUNT_POINTS),
});
export type DatabaseCompanyProfile = z.infer<typeof databaseCompanyProfile>;
