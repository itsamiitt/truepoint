// Person node + the two person→org edge domains (02 §3–4).
// Employment and education stay separate reads: different payloads, different questions.

import type { DbClient } from "../client";

export interface PersonRow {
  person_id: string;
  full_name: string;
  headline: string | null;
  location_text: string | null;
  country_code: string | null;
  current_org_id: string | null;
  current_title: string | null;
  current_function: string | null;
  current_seniority: string | null;
  confidence: string;
}

export interface PositionRow {
  position_id: string;
  person_id: string;
  org_id: string | null;
  company_name_raw: string;
  org_legal_name: string | null;
  org_display_name: string | null;
  relationship_type: string;
  title: string | null;
  job_function: string | null;
  seniority: string | null;
  started_on: string | null;
  ended_on: string | null;
  is_current: boolean;
  confidence: string;
  valid_from: string;
  valid_to: string | null;
}

export interface EducationRow {
  education_id: string;
  person_id: string;
  org_id: string | null;
  school_name: string;
  org_legal_name: string | null;
  org_display_name: string | null;
  relationship_type: string;
  degree: string | null;
  fields_of_study: string[] | null;
  started_year: number | null;
  ended_year: number | null;
  confidence: string;
  valid_from: string;
  valid_to: string | null;
}

const PERSON_COLS = `person_id, full_name, headline, location_text, country_code,
  current_org_id, current_title, current_function, current_seniority, confidence`;

const PERSON_COLS_P = `p.person_id, p.full_name, p.headline, p.location_text, p.country_code,
  p.current_org_id, p.current_title, p.current_function, p.current_seniority, p.confidence`;

export const personRepository = {
  async getById(db: DbClient, personId: string): Promise<PersonRow | null> {
    const rows = await db.query<PersonRow>(
      `SELECT ${PERSON_COLS} FROM persons WHERE person_id = $1 AND valid_to IS NULL`,
      [personId],
    );
    return rows[0] ?? null;
  },

  async byIdentifier(db: DbClient, idType: string, idValue: string): Promise<PersonRow | null> {
    const rows = await db.query<PersonRow>(
      `SELECT ${PERSON_COLS_P}
       FROM persons p JOIN person_identifiers i ON i.person_id = p.person_id
       WHERE i.id_type = $1 AND i.id_value = $2 AND p.valid_to IS NULL`,
      [idType, idValue],
    );
    return rows[0] ?? null;
  },

  /** "Where does Alex work?" (05 §1) */
  async positions(
    db: DbClient,
    personId: string,
    opts: { current?: boolean; minConfidence?: number } = {},
  ): Promise<PositionRow[]> {
    const params: unknown[] = [personId];
    let filter = "";
    if (opts.current !== undefined) {
      params.push(opts.current);
      filter += ` AND p.is_current = $${params.length}`;
    }
    if (opts.minConfidence !== undefined) {
      params.push(opts.minConfidence);
      filter += ` AND p.confidence >= $${params.length}`;
    }
    return db.query<PositionRow>(
      `SELECT p.position_id, p.person_id, p.org_id, p.company_name_raw,
              o.legal_name AS org_legal_name, o.display_name AS org_display_name,
              p.relationship_type, p.title, p.job_function, p.seniority,
              p.started_on, p.ended_on, p.is_current, p.confidence, p.valid_from, p.valid_to
       FROM person_positions p
       LEFT JOIN organizations o ON o.org_id = p.org_id
       WHERE p.person_id = $1 AND p.valid_to IS NULL ${filter}
       ORDER BY p.is_current DESC, p.started_on DESC NULLS LAST`,
      params,
    );
  },

  /** "Where did Alex study?" (05 §2) */
  async educations(db: DbClient, personId: string): Promise<EducationRow[]> {
    return db.query<EducationRow>(
      `SELECT e.education_id, e.person_id, e.org_id, e.school_name,
              o.legal_name AS org_legal_name, o.display_name AS org_display_name,
              e.relationship_type, e.degree, e.fields_of_study, e.started_year, e.ended_year,
              e.confidence, e.valid_from, e.valid_to
       FROM person_educations e
       LEFT JOIN organizations o ON o.org_id = e.org_id
       WHERE e.person_id = $1 AND e.valid_to IS NULL
       ORDER BY e.ended_year DESC NULLS LAST`,
      [personId],
    );
  },

  /** "Who works at Sage?" — the reverse traversal (05 §1). */
  async peopleAtOrg(
    db: DbClient,
    orgId: string,
    opts: {
      relationship?: string;
      current?: boolean;
      function?: string;
      seniority?: string;
      limit?: number;
    } = {},
  ): Promise<
    (PersonRow & { position_id: string; title: string | null; position_relationship: string })[]
  > {
    const params: unknown[] = [orgId];
    let filter = "";
    if (opts.relationship) {
      params.push(opts.relationship);
      filter += ` AND pp.relationship_type = $${params.length}`;
    }
    if (opts.current !== undefined) {
      params.push(opts.current);
      filter += ` AND pp.is_current = $${params.length}`;
    }
    if (opts.function) {
      params.push(opts.function);
      filter += ` AND pp.job_function = $${params.length}`;
    }
    if (opts.seniority) {
      params.push(opts.seniority);
      filter += ` AND pp.seniority = $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 25, 100));
    return db.query(
      `SELECT p.person_id, p.full_name, p.headline, p.location_text, p.country_code,
              p.current_org_id, p.current_title, p.current_function, p.current_seniority, p.confidence,
              pp.position_id, pp.title, pp.relationship_type AS position_relationship
       FROM person_positions pp
       JOIN persons p ON p.person_id = pp.person_id
       WHERE pp.org_id = $1 AND pp.valid_to IS NULL AND p.valid_to IS NULL ${filter}
       ORDER BY p.full_name
       LIMIT $${params.length}`,
      params,
    );
  },

  /** "Alumni of SPPU" — completed is DERIVED from dates, never an asserted type (02 §4). */
  async peopleWithEducationAtOrg(
    db: DbClient,
    orgId: string,
    opts: { status?: "current" | "completed"; limit?: number } = {},
  ): Promise<
    (PersonRow & { education_id: string; degree: string | null; ended_year: number | null })[]
  > {
    const params: unknown[] = [orgId];
    let filter = "";
    const nowYear = new Date().getUTCFullYear();
    if (opts.status === "completed") {
      params.push(nowYear);
      filter = ` AND e.ended_year IS NOT NULL AND e.ended_year <= $${params.length}`;
    } else if (opts.status === "current") {
      params.push(nowYear);
      filter = ` AND (e.ended_year IS NULL OR e.ended_year > $${params.length})`;
    }
    params.push(Math.min(opts.limit ?? 25, 100));
    return db.query(
      `SELECT p.person_id, p.full_name, p.headline, p.location_text, p.country_code,
              p.current_org_id, p.current_title, p.current_function, p.current_seniority, p.confidence,
              e.education_id, e.degree, e.ended_year
       FROM person_educations e
       JOIN persons p ON p.person_id = e.person_id
       WHERE e.org_id = $1 AND e.valid_to IS NULL AND p.valid_to IS NULL ${filter}
       ORDER BY p.full_name
       LIMIT $${params.length}`,
      params,
    );
  },

  /** "Who are Alex's colleagues?" — the one built-in 2-hop (05 §1). */
  async colleagues(
    db: DbClient,
    personId: string,
    opts: { function?: string; limit?: number } = {},
  ): Promise<(PersonRow & { shared_org_id: string; title: string | null })[]> {
    const params: unknown[] = [personId];
    let filter = "";
    if (opts.function) {
      params.push(opts.function);
      filter = ` AND cp.job_function = $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 25, 100));
    return db.query(
      `SELECT DISTINCT p.person_id, p.full_name, p.headline, p.location_text, p.country_code,
              p.current_org_id, p.current_title, p.current_function, p.current_seniority, p.confidence,
              cp.org_id AS shared_org_id, cp.title
       FROM person_positions me
       JOIN person_positions cp ON cp.org_id = me.org_id AND cp.person_id <> me.person_id
       JOIN persons p ON p.person_id = cp.person_id
       WHERE me.person_id = $1 AND me.is_current AND cp.is_current
         AND me.valid_to IS NULL AND cp.valid_to IS NULL AND p.valid_to IS NULL ${filter}
       ORDER BY p.full_name
       LIMIT $${params.length}`,
      params,
    );
  },
};
