// masterProfileReadRepository.ts — the composed PROFILE reads behind the global profile routes
// (search-consolidation stage 3). A profile drawer needs identity + history + attributes at once and it is
// all one withErTx, so this returns the whole document rather than making the client fan out to four
// endpoints for one panel.
//
// Every collection is BOUNDED here, at the source. A 40-year career or a scraped skill list is exactly the
// kind of collection that grows quietly, and "the client only renders ten" is not a bound.
//
// NO CHANNEL VALUES leave this module. `hasMobile` is an EXISTS over master_phones — the presence bit, never
// the number. The values stay behind reveal, which is workspace-scoped and credit-gated.
//
// Runs under the caller's withErTx (leadwolf_er).
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { MASTER_COMPANY_VISIBLE } from "./masterCompanyReadRepository.ts";
import { MASTER_PERSON_VISIBLE } from "./masterPersonReadRepository.ts";

export interface EmploymentStintRead {
  companyName: string | null;
  companyDomain: string | null;
  title: string | null;
  location: string | null;
  isCurrent: boolean;
  isPrimary: boolean;
  startedOn: string | null;
  endedOn: string | null;
  startPrecision: string | null;
  endPrecision: string | null;
}

export interface EducationRead {
  schoolName: string | null;
  degree: string | null;
  fieldsOfStudy: string[];
  startedOn: string | null;
  endedOn: string | null;
}

export interface CompanyLocationRead {
  kind: string;
  city: string | null;
  region: string | null;
  countryCode: string | null;
}

export interface HeadcountPointRead {
  month: string;
  employeeCount: number;
}

/**
 * `started_on` defaults to the '-infinity' SENTINEL, which means "start unknown" — it exists so the dedup
 * unique (person, company, started_on) collides for unknown starts. It is NOT a date. Rendering it as one
 * reads as roughly two thousand years of tenure, and any duration computed from it is nonsense. Every read
 * of that column in this module maps the sentinel back to null, in SQL, so no caller can forget.
 */
const NULLIF_SENTINEL = (col: string) => sql`NULLIF(${sql.raw(col)}, '-infinity'::date)::text`;

export const masterProfileReadRepository = {
  /** Employment history for a visible person, most recent first. Bounded. */
  async employmentForSlugTx(tx: Tx, slug: string, limit: number): Promise<EmploymentStintRead[]> {
    const rows = (await tx.execute(sql`
      SELECT e.company_name_raw, e.title, e.location, e.is_current, e.is_primary,
             ${NULLIF_SENTINEL("e.started_on")} AS started_on,
             e.ended_on::text AS ended_on, e.start_precision, e.end_precision,
             mc.primary_domain AS company_domain, mc.name AS company_name
        FROM master_persons p
        JOIN master_employment e ON e.master_person_id = p.id
        LEFT JOIN master_companies mc ON mc.id = e.master_company_id
       WHERE p.linkedin_public_id = ${slug.toLowerCase()} AND ${MASTER_PERSON_VISIBLE("p")}
       ORDER BY e.is_primary DESC, e.is_current DESC, e.started_on DESC NULLS LAST
       LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      companyName: (r.company_name as string | null) ?? (r.company_name_raw as string | null),
      companyDomain: r.company_domain as string | null,
      title: r.title as string | null,
      location: r.location as string | null,
      isCurrent: r.is_current as boolean,
      isPrimary: r.is_primary as boolean,
      startedOn: r.started_on as string | null,
      endedOn: r.ended_on as string | null,
      startPrecision: r.start_precision as string | null,
      endPrecision: r.end_precision as string | null,
    }));
  },

  /** Education history for a visible person, most recent first. Bounded. */
  async educationForSlugTx(tx: Tx, slug: string, limit: number): Promise<EducationRead[]> {
    const rows = (await tx.execute(sql`
      SELECT ed.degree, ed.fields_of_study,
             ${NULLIF_SENTINEL("ed.started_on")} AS started_on,
             ed.ended_on::text AS ended_on,
             ed.school_name_raw, mc.name AS school_name
        FROM master_persons p
        JOIN master_education ed ON ed.master_person_id = p.id
        LEFT JOIN master_companies mc ON mc.id = ed.master_company_id
       WHERE p.linkedin_public_id = ${slug.toLowerCase()} AND ${MASTER_PERSON_VISIBLE("p")}
       ORDER BY ed.ended_on DESC NULLS FIRST, ed.started_on DESC
       LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      schoolName: (r.school_name as string | null) ?? (r.school_name_raw as string | null),
      degree: r.degree as string | null,
      fieldsOfStudy: (r.fields_of_study as string[] | null) ?? [],
      startedOn: r.started_on as string | null,
      endedOn: r.ended_on as string | null,
    }));
  },

  /** Skills, most-corroborated first. Bounded. */
  async skillsForSlugTx(tx: Tx, slug: string, limit: number): Promise<string[]> {
    const rows = (await tx.execute(sql`
      SELECT s.skill::text AS skill
        FROM master_persons p
        JOIN master_person_skills s ON s.master_person_id = p.id
       WHERE p.linkedin_public_id = ${slug.toLowerCase()} AND ${MASTER_PERSON_VISIBLE("p")}
       ORDER BY s.source_count DESC, s.skill
       LIMIT ${limit}
    `)) as unknown as Array<{ skill: string }>;
    return rows.map((r) => r.skill);
  },

  /** Languages. Bounded. */
  async languagesForSlugTx(
    tx: Tx,
    slug: string,
    limit: number,
  ): Promise<Array<{ name: string; proficiency: string | null }>> {
    const rows = (await tx.execute(sql`
      SELECT l.name::text AS name, l.proficiency
        FROM master_persons p
        JOIN master_person_languages l ON l.master_person_id = p.id
       WHERE p.linkedin_public_id = ${slug.toLowerCase()} AND ${MASTER_PERSON_VISIBLE("p")}
       ORDER BY l.source_count DESC, l.name
       LIMIT ${limit}
    `)) as unknown as Array<{ name: string; proficiency: string | null }>;
    return rows.map((r) => ({ name: r.name, proficiency: r.proficiency }));
  },

  /**
   * Does this person have a MOBILE number on file? A boolean, deliberately — the number itself is the paid
   * product and never crosses this boundary. Serves S-04 (working direct-dial/mobile coverage) as a filter
   * and a badge without giving the value away.
   */
  async hasMobileForSlugTx(tx: Tx, slug: string): Promise<boolean> {
    const rows = (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
          FROM master_persons p
          JOIN master_phones ph ON ph.master_person_id = p.id
         WHERE p.linkedin_public_id = ${slug.toLowerCase()}
           AND ${MASTER_PERSON_VISIBLE("p")}
           AND ph.line_type = 'mobile'
      ) AS has_mobile
    `)) as unknown as Array<{ has_mobile: boolean }>;
    return rows[0]?.has_mobile ?? false;
  },

  /** Known locations for a visible company. Bounded. */
  async locationsForDomainTx(
    tx: Tx,
    domain: string,
    limit: number,
  ): Promise<CompanyLocationRead[]> {
    const rows = (await tx.execute(sql`
      SELECT l.kind, l.city, l.region, l.country_code
        FROM master_companies c
        JOIN master_company_locations l ON l.master_company_id = c.id
       WHERE c.primary_domain = ${domain} AND ${MASTER_COMPANY_VISIBLE("c")}
       ORDER BY (l.kind = 'hq') DESC, l.observed_at DESC NULLS LAST
       LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      kind: r.kind as string,
      city: r.city as string | null,
      region: r.region as string | null,
      countryCode: r.country_code as string | null,
    }));
  },

  /**
   * The monthly TOTAL headcount series, oldest last. Growth is derived by the caller from this series and
   * never stored — the 0114 posture ("growth is DERIVED via lag(), never stored").
   * `job_function = ''` is the total row; the per-function rows are a different question.
   */
  async headcountForDomainTx(tx: Tx, domain: string, limit: number): Promise<HeadcountPointRead[]> {
    const rows = (await tx.execute(sql`
      SELECT h.month::text AS month, h.employee_count
        FROM master_companies c
        JOIN master_company_headcount h ON h.master_company_id = c.id
       WHERE c.primary_domain = ${domain} AND ${MASTER_COMPANY_VISIBLE("c")}
         AND h.job_function = ''
       ORDER BY h.month DESC
       LIMIT ${limit}
    `)) as unknown as Array<{ month: string; employee_count: number }>;
    return rows.map((r) => ({ month: r.month, employeeCount: r.employee_count }));
  },
};
