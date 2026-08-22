// masterCompanyReadRepository.ts — the CUSTOMER read seam over Layer-0 companies (search-consolidation
// stage 2), the company twin of masterPersonReadRepository. Two guarantees every caller inherits:
//   1. MASTER_COMPANY_VISIBLE is applied INSIDE every read, so a school node, a minted stub, or a company
//      with no addressable key is indistinguishable from absence. Callers cannot forget the policy.
//   2. The projection is firmographic only — companies carry no PII — and carries NO Layer-0 uuid: a
//      company is addressed by its registrable domain, which is also what "Add to workspace" takes.
// Runs under the caller's withErTx (leadwolf_er has SELECT on master_companies + master_industries).
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/**
 * The read-side policy predicate — ONE fragment for every Layer-0 company read. `alias` = the
 * master_companies alias in the caller's FROM.
 *
 * Three clauses, and the third is the one that matters:
 *
 * - `org_kind = 'company'` — education institutions are minted as master_companies rows with
 *   org_kind='school' (masterProfileRepository mints them for the education edge). A university in a
 *   company search is wrong; orgKindCopy.ts exists because that already bit the UI once.
 *
 * - `primary_domain IS NOT NULL` — the addressing key. UNIQUE, URL-shaped, and what the cursor and the
 *   profile route use.
 *
 * - `field_provenance <> '{}'` — "a company DOCUMENT actually landed". This clause is load-bearing and was
 *   NOT obvious. A company first observed as a numeric id on someone's position is minted as a stub with
 *   only a name, and `fillCompanyPrimaryDomain` later back-fills a domain onto it from the employer's
 *   website — so the domain clause does NOT separate real companies from shells. Measured against
 *   production 2026-08-21: 3,747 rows pass org_kind+domain, and only 231 of them carry any firmographics.
 *   Without this clause 94% of the Accounts tab would be blank rows. `updateCompanyProfile` stamps
 *   field_provenance if and only if a landing wrote fields, which makes it the CAUSE rather than a symptom
 *   that would go stale if a landing ever wrote only a logo. (`prov_hwm` was the other candidate and is
 *   never written — 0 rows.)
 *
 * NOTE there is no merge tombstone on master_companies — `merged_into_person_id` exists on master_persons
 * only. Do not add a `merged_into_company_id IS NULL` clause; there is no such column. When one is
 * introduced, this fragment and the 0134 partial indexes must change together, in one migration.
 *
 * Keep this byte-identical to the WHERE clauses of the 0134 partial indexes — a partial index is only used
 * when the planner can prove the query's predicate implies the index's.
 */
export function MASTER_COMPANY_VISIBLE(alias = "c") {
  const a = sql.raw(alias);
  return sql`${a}.org_kind = 'company' AND ${a}.primary_domain IS NOT NULL AND ${a}.field_provenance <> '{}'::jsonb`;
}

export interface MasterCompanyRow {
  primaryDomain: string;
  name: string;
  websiteUrl: string | null;
  logoUrl: string | null;
  description: string | null;
  linkedinCompanyId: string | null;
  industry: string | null;
  industryCode: string | null;
  industryLabel: string | null;
  employeeCount: number | null;
  revenueMinMinor: number | null;
  revenueMaxMinor: number | null;
  revenueCurrency: string | null;
  revenueDisplay: string | null;
  ownershipType: string | null;
  yearFounded: number | null;
  specialties: string[];
  hqCountry: string | null;
  hqCity: string | null;
  updatedAt: Date;
}

/** The shared projection. `mi` is the canonical industry node (LEFT JOIN — an unresolved spelling is a
 *  legitimate gap, not a reason to drop the company). */
export const COMPANY_SELECT = sql`
  c.primary_domain, c.name, c.website_url, c.logo_url, c.description, c.linkedin_company_id,
  c.industry, c.employee_count, c.revenue_min_minor, c.revenue_max_minor, c.revenue_currency,
  c.revenue_range, c.ownership_type, c.year_founded, c.specialties, c.hq_country, c.hq_city,
  c.updated_at, mi.code AS industry_code, mi.label AS industry_label`;

export const COMPANY_FROM = sql`FROM master_companies c LEFT JOIN master_industries mi ON mi.id = c.industry_id`;

export type RawCompanyRow = {
  primary_domain: string;
  name: string;
  website_url: string | null;
  logo_url: string | null;
  description: string | null;
  linkedin_company_id: string | null;
  industry: string | null;
  employee_count: number | null;
  revenue_min_minor: string | number | null;
  revenue_max_minor: string | number | null;
  revenue_currency: string | null;
  revenue_range: string | null;
  ownership_type: string | null;
  year_founded: number | null;
  specialties: string[] | null;
  hq_country: string | null;
  hq_city: string | null;
  updated_at: string | Date;
  industry_code: string | null;
  industry_label: string | null;
};

/** bigint columns arrive as strings from postgres.js when they exceed the safe-integer range; the revenue
 *  bands never do in practice, but coercing here rather than at three call sites keeps the DTO honest. */
function toNumber(v: string | number | null): number | null {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toMasterCompanyRow(r: RawCompanyRow): MasterCompanyRow {
  return {
    primaryDomain: r.primary_domain,
    name: r.name,
    websiteUrl: r.website_url,
    logoUrl: r.logo_url,
    description: r.description,
    linkedinCompanyId: r.linkedin_company_id,
    industry: r.industry,
    industryCode: r.industry_code,
    industryLabel: r.industry_label,
    employeeCount: r.employee_count,
    revenueMinMinor: toNumber(r.revenue_min_minor),
    revenueMaxMinor: toNumber(r.revenue_max_minor),
    revenueCurrency: r.revenue_currency,
    revenueDisplay: r.revenue_range,
    ownershipType: r.ownership_type,
    yearFounded: r.year_founded,
    specialties: r.specialties ?? [],
    hqCountry: r.hq_country,
    hqCity: r.hq_city,
    updatedAt: new Date(r.updated_at),
  };
}

export const masterCompanyReadRepository = {
  /** One visible company by its registrable domain. Null when absent OR not visible — the caller turns both
   *  into the same 404 so the two are indistinguishable and domains cannot be enumerated by response shape. */
  async findByDomainTx(tx: Tx, domain: string): Promise<MasterCompanyRow | null> {
    const rows = (await tx.execute(sql`
      SELECT ${COMPANY_SELECT} ${COMPANY_FROM}
       WHERE ${MASTER_COMPANY_VISIBLE("c")} AND c.primary_domain = ${domain}
       LIMIT 1
    `)) as unknown as RawCompanyRow[];
    const row = rows[0];
    return row ? toMasterCompanyRow(row) : null;
  },

  /**
   * The registrable domain of the visible company a LinkedIn company SLUG addresses — the hop the extension's
   * Profile Intelligence Panel needs, because a `/company/<slug>` page carries no domain and the domain is
   * what every company read in this module is keyed by.
   *
   * Reads `master_company_identifiers` (0113), NOT the numeric `linkedin_company_id` column: the slug is its
   * own id_type namespace, and the numeric id is internal link metadata that must never leave the server.
   * `MASTER_COMPANY_VISIBLE` is applied so a stub or a school is indistinguishable from absence, exactly like
   * `findByDomainTx`.
   */
  async domainForLinkedinSlugTx(tx: Tx, slug: string): Promise<string | null> {
    const rows = (await tx.execute(sql`
      SELECT c.primary_domain
        FROM master_company_identifiers i
        JOIN master_companies c ON c.id = i.master_company_id
       WHERE i.id_type = 'linkedin_company_slug' AND i.id_value = ${slug.toLowerCase()}
         AND ${MASTER_COMPANY_VISIBLE("c")}
       LIMIT 1
    `)) as unknown as Array<{ primary_domain: string }>;
    return rows[0]?.primary_domain ?? null;
  },

  /**
   * The registrable domain a previously-fetched company URL resolved to — the Sales-Navigator hop
   * (`/sales/company/<numeric id>`), whose id has no slug namespace.
   * `source_fetch_registry.resolved_company_id` is stamped by the landing (`recordFetch`), so this answers
   * only for URLs we have actually fetched; a never-fetched URL is a legitimate miss, not an error.
   *
   * URLs and domains only — the resolved uuid is a JOIN key inside the query and is never returned.
   */
  async domainForRegistryUrlTx(tx: Tx, normalizedUrl: string): Promise<string | null> {
    const rows = (await tx.execute(sql`
      SELECT c.primary_domain
        FROM source_fetch_registry r
        JOIN master_companies c ON c.id = r.resolved_company_id
       WHERE r.entity_kind = 'company' AND r.normalized_url = ${normalizedUrl}
         AND ${MASTER_COMPANY_VISIBLE("c")}
       LIMIT 1
    `)) as unknown as Array<{ primary_domain: string }>;
    return rows[0]?.primary_domain ?? null;
  },

  /** The HQ region (state/province) for a company, from the locations edge. Kept separate from the row
   *  projection because it is a JOIN the grid does not need and the profile does. */
  async findHqRegionTx(tx: Tx, domain: string): Promise<string | null> {
    const rows = (await tx.execute(sql`
      SELECT l.region ${COMPANY_FROM}
        JOIN master_company_locations l ON l.master_company_id = c.id AND l.kind = 'hq'
       WHERE ${MASTER_COMPANY_VISIBLE("c")} AND c.primary_domain = ${domain}
       ORDER BY l.observed_at DESC NULLS LAST
       LIMIT 1
    `)) as unknown as Array<{ region: string | null }>;
    return rows[0]?.region ?? null;
  },
};
