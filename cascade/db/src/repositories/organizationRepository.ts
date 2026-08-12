import type { DbClient } from "../client";

export interface OrganizationRow {
  org_id: string;
  org_kind: string;
  legal_name: string;
  display_name: string | null;
  primary_domain: string | null;
  country_code: string | null;
  employee_range: string | null;
  founded_year: number | null;
  institution_type: string | null;
  confidence: string;
}

const ORG_COLS = `org_id, org_kind, legal_name, display_name, primary_domain, country_code,
  employee_range, founded_year, institution_type, confidence`;

const ORG_COLS_O = `o.org_id, o.org_kind, o.legal_name, o.display_name, o.primary_domain, o.country_code,
  o.employee_range, o.founded_year, o.institution_type, o.confidence`;

export const organizationRepository = {
  async getById(db: DbClient, orgId: string): Promise<OrganizationRow | null> {
    const rows = await db.query<OrganizationRow>(
      `SELECT ${ORG_COLS} FROM organizations WHERE org_id = $1 AND valid_to IS NULL`,
      [orgId],
    );
    return rows[0] ?? null;
  },

  async aliases(db: DbClient, orgId: string): Promise<{ alias: string; alias_kind: string }[]> {
    return db.query(
      "SELECT alias, alias_kind FROM organization_aliases WHERE org_id = $1 ORDER BY alias",
      [orgId],
    );
  },

  async identifiers(db: DbClient, orgId: string): Promise<{ id_type: string; id_value: string }[]> {
    return db.query(
      "SELECT id_type, id_value FROM organization_identifiers WHERE org_id = $1 ORDER BY id_type, id_value",
      [orgId],
    );
  },

  /** Deterministic tier: an identifier anchors exactly one org. */
  async byIdentifier(
    db: DbClient,
    idType: string,
    idValue: string,
  ): Promise<OrganizationRow | null> {
    const rows = await db.query<OrganizationRow>(
      `SELECT ${ORG_COLS_O} FROM organizations o
       JOIN organization_identifiers i ON i.org_id = o.org_id
       WHERE i.id_type = $1 AND lower(i.id_value) = lower($2) AND o.valid_to IS NULL`,
      [idType, idValue],
    );
    return rows[0] ?? null;
  },

  /** Probabilistic tier: names/aliases are candidates, scored crudely for now
   *  (exact alias > exact legal/display name > prefix). Splink replaces this scoring. */
  async candidatesByName(
    db: DbClient,
    name: string,
    kind?: string,
  ): Promise<{ org: OrganizationRow; match_confidence: number }[]> {
    const kindFilter = kind ? "AND o.org_kind = $2" : "";
    const params: unknown[] = kind ? [name, kind] : [name];
    const rows = await db.query<OrganizationRow & { tier: number }>(
      `SELECT DISTINCT ON (o.org_id) ${ORG_COLS_O},
        CASE
          WHEN EXISTS (SELECT 1 FROM organization_aliases a WHERE a.org_id = o.org_id AND lower(a.alias) = lower($1)) THEN 1
          WHEN lower(o.legal_name) = lower($1) OR lower(o.display_name) = lower($1) THEN 1
          WHEN lower(o.legal_name) LIKE lower($1) || '%' OR lower(o.display_name) LIKE lower($1) || '%' THEN 2
          ELSE 3
        END AS tier
      FROM organizations o
      LEFT JOIN organization_aliases a ON a.org_id = o.org_id
      WHERE o.valid_to IS NULL ${kindFilter}
        AND (lower(o.legal_name) LIKE lower($1) || '%'
          OR lower(o.display_name) LIKE lower($1) || '%'
          OR lower(a.alias) = lower($1))
      ORDER BY o.org_id, tier
      LIMIT 10`,
      params,
    );
    return rows
      .map((r) => ({
        org: r,
        match_confidence: r.tier === 1 ? 0.93 : r.tier === 2 ? 0.6 : 0.4,
      }))
      .sort((x, y) => y.match_confidence - x.match_confidence);
  },
};
