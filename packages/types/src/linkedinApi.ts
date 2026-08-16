// linkedinApi.ts — zod contracts for the vendor-neutral LinkedIn-shaped source API payloads
// (docs/planning/linkedin-source-ingestion/; fixtures = the `source plan/` samples).
//
// TOLERANT BY DESIGN: `.passthrough()` everywhere, every field beyond the identity spine optional — a vendor
// ADDING fields must not hard-fail ingestion (the raw payload is retained verbatim in source_records either
// way). The literal `schema_version` IS the contract pin: a version bump fails parsing loudly instead of
// silently mis-mapping (the forge SHAPE_DRIFT posture, expressed in zod).
//
// COMPLIANCE BOUNDARY NOTE: this schema deliberately PARSES the sensitive-adjacent fields (pronoun, premium,
// open_link, job_seeker, photos, skills, languages, volunteering) so the payload validates — but the MAPPER
// (core/sourceLanding/mapLinkedinPayload.ts) drops them before anything structured is written. Raw-only per
// the 2026-08-16 decision; HUMAN GATE to ever project them.

import { z } from "zod";

/** "YYYY" | "YYYY-MM" | (rare) "YYYY-MM-DD" | null — normalized by @leadwolf/types parsePartialDate. */
const partialDateString = z.string().nullish();

/** A typed channel value some vendors assert instead of a bare string: the value under any of the common
 *  keys, plus an optional kind ("work" | "personal" | "mobile" | …). */
export const linkedinApiTypedValueSchema = z
  .object({
    value: z.string().nullish(),
    email: z.string().nullish(),
    number: z.string().nullish(),
    phone: z.string().nullish(),
    type: z.string().nullish(),
  })
  .passthrough();
export type LinkedinApiTypedValue = z.infer<typeof linkedinApiTypedValueSchema>;

export const linkedinApiPositionSchema = z
  .object({
    title: z.string().nullish(),
    company_name: z.string().nullish(),
    company_id: z.number().int().nullish(),
    company_logo: z.string().nullish(),
    location: z.string().nullish(),
    description: z.string().nullish(),
    is_current: z.boolean().nullish(),
    start_date: partialDateString,
    end_date: partialDateString,
  })
  .passthrough();
export type LinkedinApiPosition = z.infer<typeof linkedinApiPositionSchema>;

export const linkedinApiEducationSchema = z
  .object({
    school_name: z.string().nullish(),
    school_id: z.number().int().nullish(),
    school_url: z.string().nullish(),
    school_logo: z.string().nullish(),
    degree: z.string().nullish(),
    fields_of_study: z.array(z.string()).nullish(),
    start_date: partialDateString,
    end_date: partialDateString,
  })
  .passthrough();
export type LinkedinApiEducation = z.infer<typeof linkedinApiEducationSchema>;

export const linkedinApiPersonPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    profile_id: z.string().min(1), // the immutable member urn ("ACwAA…")
    member_id: z.number().int().nullish(), // the numeric member id
    public_identifier: z.string().min(1), // the slug — the mintable person key
    linkedin_url: z.string().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    full_name: z.string().nullish(),
    headline: z.string().nullish(),
    summary: z.string().nullish(),
    location: z.string().nullish(),
    current_position: linkedinApiPositionSchema.nullish(),
    positions: z.array(linkedinApiPositionSchema).nullish(),
    educations: z.array(linkedinApiEducationSchema).nullish(),
    contact: z
      .object({
        primary_email: z.string().nullish(),
        // Bare strings in every recorded sample; typed objects tolerated forward-compatibly (a vendor
        // that starts asserting kinds must not hard-fail parsing). The mapper normalizes both shapes.
        emails: z.array(z.union([z.string(), linkedinApiTypedValueSchema])).nullish(),
        phones: z.array(z.union([z.string(), linkedinApiTypedValueSchema])).nullish(),
      })
      .passthrough()
      .nullish(),
    // Structured multi-value attributes (C6 gate opened 2026-08-16 by user instruction): the mapper
    // projects skills + languages into master_person_skills / master_person_languages.
    skills: z.array(z.string()).nullish(),
    languages: z
      .array(
        z.object({ name: z.string().nullish(), proficiency: z.string().nullish() }).passthrough(),
      )
      .nullish(),
    // Parsed-but-never-projected (raw-only; see the header). Listed so the shape is documented, not so the
    // mapper may read them.
    pronoun: z.string().nullish(),
    premium: z.boolean().nullish(),
    open_link: z.boolean().nullish(),
    job_seeker: z.boolean().nullish(),
    profile_picture: z.string().nullish(),
    background_picture: z.string().nullish(),
    volunteering: z.array(z.object({}).passthrough()).nullish(),
  })
  .passthrough();
export type LinkedinApiPersonPayload = z.infer<typeof linkedinApiPersonPayloadSchema>;

const revenueBoundSchema = z
  .object({ amount: z.number().nullish(), unit: z.string().nullish() })
  .passthrough();

export const linkedinApiCompanyPayloadSchema = z
  .object({
    schema_version: z.literal(2),
    company_id: z.number().int(),
    entity_urn: z.string().nullish(),
    public_identifier: z.string().nullish(), // the company slug
    linkedin_url: z.string().nullish(),
    sales_navigator_url: z.string().nullish(),
    name: z.string().min(1),
    description: z.string().nullish(),
    industry: z.string().nullish(),
    type: z.string().nullish(), // ownership display string ("Public Company" | "Privately Held" | …)
    specialties: z.array(z.string()).nullish(),
    website: z.string().nullish(),
    location: z.string().nullish(),
    headquarters: z
      .object({
        line1: z.string().nullish(),
        line2: z.string().nullish(),
        city: z.string().nullish(),
        geographic_area: z.string().nullish(),
        postal_code: z.string().nullish(),
        country: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    year_founded: z.number().int().nullish(),
    revenue_range: z
      .object({
        currency: z.string().nullish(),
        min: revenueBoundSchema.nullish(),
        max: revenueBoundSchema.nullish(),
      })
      .passthrough()
      .nullish(),
    logo: z.string().nullish(),
    background_picture: z.string().nullish(),
    employee_count: z.number().int().nullish(),
    headcount: z
      .object({
        total: z.number().int().nullish(),
        as_of: z.string().nullish(), // "YYYY-MM"
        monthly: z
          .array(
            z
              .object({
                month: z.string(), // "YYYY-MM"
                count: z.number().int(),
              })
              .passthrough(),
          )
          .nullish(),
        by_function: z
          .array(
            z
              .object({
                function: z.string().nullish(),
                monthly: z
                  .array(z.object({ month: z.string(), count: z.number().int() }).passthrough())
                  .nullish(),
              })
              .passthrough(),
          )
          .nullish(),
        // growth / changes_by_function are DERIVED data — parsed through passthrough, never stored
        // structured (lag() over the monthly series reproduces them; no-rollup rule).
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type LinkedinApiCompanyPayload = z.infer<typeof linkedinApiCompanyPayloadSchema>;

/** Discriminates a raw payload by its schema_version pin. Throws ZodError on drift — the caller quarantines. */
export const linkedinApiPayloadSchema = z.union([
  linkedinApiPersonPayloadSchema,
  linkedinApiCompanyPayloadSchema,
]);
export type LinkedinApiPayload = z.infer<typeof linkedinApiPayloadSchema>;
