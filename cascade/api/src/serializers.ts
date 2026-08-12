// Response shaping (08 §2, §6): explicit DTOs, never raw rows. Adding a column
// to a table must not silently start exposing it.

import type {
  EducationRow,
  OrgTechEdgeRow,
  OrganizationRow,
  PersonRow,
  PositionRow,
  TechnologyRow,
} from "@cascade/db";

const num = (v: string | number | null) => (v === null ? null : Number(v));

export function organizationDto(row: OrganizationRow, extras: Record<string, unknown> = {}) {
  return {
    org_id: row.org_id,
    org_kind: row.org_kind,
    legal_name: row.legal_name,
    display_name: row.display_name,
    primary_domain: row.primary_domain,
    country_code: row.country_code,
    employee_range: row.employee_range,
    founded_year: row.founded_year,
    institution_type: row.institution_type,
    confidence: num(row.confidence),
    ...extras,
  };
}

export function personDto(row: PersonRow, extras: Record<string, unknown> = {}) {
  return {
    person_id: row.person_id,
    full_name: row.full_name,
    headline: row.headline,
    location_text: row.location_text,
    country_code: row.country_code,
    current_org: row.current_org_id ? { org_id: row.current_org_id } : null,
    current_title: row.current_title,
    current_function: row.current_function,
    current_seniority: row.current_seniority,
    confidence: num(row.confidence),
    ...extras,
  };
}

export function technologyDto(row: TechnologyRow, extras: Record<string, unknown> = {}) {
  return {
    technology_id: row.technology_id,
    canonical_name: row.canonical_name,
    slug: row.slug,
    tech_kind: row.tech_kind,
    category_path: row.category_path,
    is_saas: row.is_saas,
    is_open_source: row.is_open_source,
    cpe23: row.cpe23,
    wikidata_qid: row.wikidata_qid,
    confidence: num(row.confidence),
    ...extras,
  };
}

export function positionDto(row: PositionRow) {
  return {
    position_id: row.position_id,
    organization: row.org_id
      ? { org_id: row.org_id, legal_name: row.org_legal_name, display_name: row.org_display_name }
      : null,
    company_name_raw: row.company_name_raw,
    relationship: row.relationship_type,
    title: row.title,
    job_function: row.job_function,
    seniority: row.seniority,
    started_on: row.started_on,
    ended_on: row.ended_on,
    is_current: row.is_current,
    confidence: num(row.confidence),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
  };
}

export function educationDto(row: EducationRow) {
  const currentYear = new Date().getUTCFullYear();
  return {
    education_id: row.education_id,
    organization: row.org_id
      ? { org_id: row.org_id, legal_name: row.org_legal_name, display_name: row.org_display_name }
      : null,
    school_name: row.school_name,
    relationship: row.relationship_type,
    degree: row.degree,
    fields_of_study: row.fields_of_study ?? [],
    started_year: row.started_year,
    ended_year: row.ended_year,
    // DERIVED, never stored (02 §4): alumnus is a date predicate.
    completed: row.ended_year !== null && row.ended_year <= currentYear,
    confidence: num(row.confidence),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
  };
}

export function orgTechEdgeDto(
  row: OrgTechEdgeRow,
  creator?: { org_id: string; display_name: string | null; legal_name: string },
) {
  return {
    rel_id: row.rel_id,
    technology: {
      technology_id: row.technology_id,
      canonical_name: row.canonical_name,
      tech_kind: row.tech_kind,
      category_path: row.category_path,
    },
    relationship: row.relationship_type,
    confidence: num(row.confidence),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    detection_method: row.detection_method,
    detected_on_domain: row.detected_on_domain,
    is_primary_product: row.is_primary_product,
    launched_on: row.launched_on,
    ...(creator
      ? {
          creator: {
            org_id: creator.org_id,
            display_name: creator.display_name,
            legal_name: creator.legal_name,
          },
        }
      : {}),
  };
}
