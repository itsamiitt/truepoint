// serialize.ts — the public API's wire shaping (ADR-0049).
//
// This file exists because the public API uses a DIFFERENT wire convention from /api/v1: snake_case fields,
// because that is what doc.truepoint.in published and what the REST ecosystem this API competes in expects.
// The internal contract is camelCase and stays that way. Keeping the translation in one place means the
// convention cannot drift endpoint by endpoint, and — more importantly — it makes the response an EXPLICIT
// allow-list rather than a spread of whatever the repository happened to select.
//
// That allow-list is the security property. api-security.md: "Adding a field to a database model must not
// silently start exposing it through every endpoint that returns the row." A `return c.json(row)` here would
// mean the next column added to master_companies ships to every paying customer the moment it lands.

import type { MasterCompanyRow } from "@leadwolf/db";

/** The public shape of a company. Every field is listed on purpose; nothing is spread. */
export interface PublicCompanyPayload {
  domain: string;
  name: string;
  website_url: string | null;
  description: string | null;
  industry: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  ownership_type: string | null;
  year_founded: number | null;
  specialties: string[];
  hq_country: string | null;
  hq_city: string | null;
  /** When the graph last changed this record — the freshness signal a caller decides staleness against. */
  last_updated: string;
}

export function toCompanyPayload(row: MasterCompanyRow): PublicCompanyPayload {
  return {
    domain: row.primaryDomain,
    name: row.name,
    website_url: row.websiteUrl,
    description: row.description,
    // The canonical industry label where the graph resolved one, falling back to the raw spelling. An
    // unresolved industry is a real gap, not a reason to answer null and make the caller think we hold
    // nothing.
    industry: row.industryLabel ?? row.industry,
    employee_count: row.employeeCount,
    revenue_range: row.revenueDisplay,
    ownership_type: row.ownershipType,
    year_founded: row.yearFounded,
    specialties: row.specialties,
    hq_country: row.hqCountry,
    hq_city: row.hqCity,
    last_updated: row.updatedAt.toISOString(),
  };
}

/**
 * Fields deliberately NOT exposed, so the omissions are decisions on the record rather than oversights:
 *   • linkedinCompanyId — an internal addressing key for a third-party platform. Publishing it invites
 *     callers to build against a join we do not own and cannot guarantee.
 *   • revenueMinMinor / revenueMaxMinor / revenueCurrency — the raw bounds behind revenue_range. A band is
 *     an honest representation of what the data supports; exact minor units imply a precision we do not have.
 *   • logoUrl — a hotlink to an asset we do not host and whose availability we do not control.
 *   • industryCode — an internal taxonomy id with no published meaning.
 */
export const INTENTIONALLY_OMITTED_COMPANY_FIELDS = [
  "linkedinCompanyId",
  "revenueMinMinor",
  "revenueMaxMinor",
  "revenueCurrency",
  "logoUrl",
  "industryCode",
] as const;
