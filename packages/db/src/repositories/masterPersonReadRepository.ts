// masterPersonReadRepository.ts — the CUSTOMER read seam over Layer-0 persons (docs/planning: Layer-0 as THE
// product database, D2/D5/D8). Two guarantees every caller inherits:
//   1. MASTER_PERSON_VISIBLE is applied INSIDE every read — a private (workspace-minted), suppressed, or
//      merged person is indistinguishable from absence. Callers cannot forget the policy.
//   2. The projection is MASKED: names/title/location/employer + the public slug (URL-shaped, per the front-end
//      contract) — never numeric ids/urns, never channel values. Layer-0 uuids leave this module only for
//      the caller's own bridge/materialization writes, never to a client.
// Runs under the caller's withErTx (leadwolf_er has SELECT on master_* + source_fetch_registry).
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** The read-side policy predicate — ONE fragment for every Layer-0 customer read. `alias` = the
 *  master_persons alias in the caller's FROM. */
export function MASTER_PERSON_VISIBLE(alias = "p") {
  const a = sql.raw(alias);
  return sql`${a}.visibility IN ('licensed','coop') AND ${a}.is_suppressed = false AND ${a}.merged_into_person_id IS NULL`;
}

export interface MasterPersonCompany {
  id: string;
  name: string;
  primaryDomain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  employeeCount: number | null;
}

export interface MasterPersonRow {
  id: string;
  linkedinPublicId: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  jobTitle: string | null;
  seniorityLevel: string | null;
  locationRaw: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
  updatedAt: Date;
  company: MasterPersonCompany | null;
}

const PERSON_SELECT = sql`
  p.id, p.linkedin_public_id, p.full_name, p.first_name, p.last_name, p.headline, p.job_title,
  p.seniority_level, p.location_raw, p.location_city, p.location_country, p.has_email, p.has_phone,
  p.updated_at,
  mc.id AS company_id, mc.name AS company_name, mc.primary_domain AS company_domain,
  mc.website_url AS company_website, mc.industry AS company_industry, mc.employee_count AS company_employees`;

const PERSON_FROM = sql`FROM master_persons p LEFT JOIN master_companies mc ON mc.id = p.current_company_id`;

type RawPersonRow = {
  id: string;
  linkedin_public_id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  job_title: string | null;
  seniority_level: string | null;
  location_raw: string | null;
  location_city: string | null;
  location_country: string | null;
  has_email: boolean;
  has_phone: boolean;
  updated_at: string | Date;
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_website: string | null;
  company_industry: string | null;
  company_employees: number | null;
};

export function toMasterPersonRow(r: RawPersonRow): MasterPersonRow {
  return {
    id: r.id,
    linkedinPublicId: r.linkedin_public_id,
    fullName: r.full_name,
    firstName: r.first_name,
    lastName: r.last_name,
    headline: r.headline,
    jobTitle: r.job_title,
    seniorityLevel: r.seniority_level,
    locationRaw: r.location_raw,
    locationCity: r.location_city,
    locationCountry: r.location_country,
    hasEmail: r.has_email,
    hasPhone: r.has_phone,
    updatedAt: new Date(r.updated_at),
    company:
      r.company_id && r.company_name
        ? {
            id: r.company_id,
            name: r.company_name,
            primaryDomain: r.company_domain,
            websiteUrl: r.company_website,
            industry: r.company_industry,
            employeeCount: r.company_employees,
          }
        : null,
  };
}

export const masterPersonReadRepository = {
  /** One VISIBLE person by public slug (lowercased canonical) or by Layer-0 id (from a prior bridge/registry
   *  hop). Null = absent OR not visible — deliberately indistinguishable. Slug-less persons are never returned
   *  (the slug is the customer-facing addressing key). */
  async readVisiblePerson(
    tx: Tx,
    by: { slug: string } | { id: string },
  ): Promise<MasterPersonRow | null> {
    const where =
      "slug" in by
        ? sql`p.linkedin_public_id = ${by.slug.toLowerCase()}`
        : sql`p.id = ${by.id}::uuid AND p.linkedin_public_id IS NOT NULL`;
    const rows = (await tx.execute(sql`
      SELECT ${PERSON_SELECT} ${PERSON_FROM}
       WHERE ${where} AND ${MASTER_PERSON_VISIBLE("p")}
       LIMIT 1
    `)) as unknown as RawPersonRow[];
    return rows[0] ? toMasterPersonRow(rows[0]) : null;
  },

  /** The Sales-Nav lead-URL → person hop: source_fetch_registry.resolved_person_id stamped by the landing
   *  (recordFetch). URLs + ids only. Null when the URL was never fetched or never resolved. */
  async resolveRegistryPerson(tx: Tx, normalizedUrl: string): Promise<string | null> {
    const rows = (await tx.execute(sql`
      SELECT resolved_person_id FROM source_fetch_registry
       WHERE entity_kind = 'person' AND normalized_url = ${normalizedUrl}
         AND resolved_person_id IS NOT NULL
       LIMIT 1
    `)) as unknown as Array<{ resolved_person_id: string }>;
    return rows[0]?.resolved_person_id ?? null;
  },
};

export { PERSON_FROM, PERSON_SELECT, type RawPersonRow };
