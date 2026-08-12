import type { DbClient } from "../client";

export interface TechnologyRow {
  technology_id: string;
  canonical_name: string;
  slug: string;
  tech_kind: string;
  category_path: string | null;
  is_saas: boolean | null;
  is_open_source: boolean | null;
  cpe23: string | null;
  wikidata_qid: string | null;
  confidence: string;
}

const TECH_SELECT = `t.technology_id, t.canonical_name, t.slug, t.tech_kind, c.path AS category_path,
  t.is_saas, t.is_open_source, t.cpe23, t.wikidata_qid, t.confidence`;

export const technologyRepository = {
  async getById(db: DbClient, technologyId: string): Promise<TechnologyRow | null> {
    const rows = await db.query<TechnologyRow>(
      `SELECT ${TECH_SELECT} FROM technologies t
       LEFT JOIN technology_categories c ON c.category_id = t.category_id
       WHERE t.technology_id = $1 AND t.valid_to IS NULL`,
      [technologyId],
    );
    return rows[0] ?? null;
  },

  async aliases(db: DbClient, technologyId: string): Promise<string[]> {
    const rows = await db.query<{ alias: string }>(
      "SELECT alias FROM technology_aliases WHERE technology_id = $1 ORDER BY alias",
      [technologyId],
    );
    return rows.map((r) => r.alias);
  },

  /** Resolution: exact identifier, exact name, or alias ("GA4" → Google Analytics). */
  async resolve(
    db: DbClient,
    key: { name?: string; cpe23?: string; wikidata_qid?: string },
  ): Promise<{ tech: TechnologyRow; match_confidence: number }[]> {
    if (key.cpe23 || key.wikidata_qid) {
      const col = key.cpe23 ? "cpe23" : "wikidata_qid";
      const rows = await db.query<TechnologyRow>(
        `SELECT ${TECH_SELECT} FROM technologies t
         LEFT JOIN technology_categories c ON c.category_id = t.category_id
         WHERE t.${col} = $1 AND t.valid_to IS NULL`,
        [key.cpe23 ?? key.wikidata_qid],
      );
      return rows.map((tech) => ({ tech, match_confidence: 1 }));
    }
    if (!key.name) return [];
    const rows = await db.query<TechnologyRow & { tier: number }>(
      `SELECT DISTINCT ON (t.technology_id) ${TECH_SELECT},
              CASE WHEN lower(t.canonical_name) = lower($1) THEN 1
                   WHEN EXISTS (SELECT 1 FROM technology_aliases a
                                WHERE a.technology_id = t.technology_id AND lower(a.alias) = lower($1)) THEN 1
                   ELSE 2 END AS tier
       FROM technologies t
       LEFT JOIN technology_categories c ON c.category_id = t.category_id
       LEFT JOIN technology_aliases a2 ON a2.technology_id = t.technology_id
       WHERE t.valid_to IS NULL
         AND (lower(t.canonical_name) LIKE lower($1) || '%' OR lower(a2.alias) = lower($1))
       ORDER BY t.technology_id, tier
       LIMIT 10`,
      [key.name],
    );
    return rows
      .map((r) => ({ tech: r, match_confidence: r.tier === 1 ? 0.95 : 0.55 }))
      .sort((a, b) => b.match_confidence - a.match_confidence);
  },

  async categories(
    db: DbClient,
  ): Promise<{ category_id: string; name: string; path: string; parent_id: string | null }[]> {
    return db.query(
      "SELECT category_id, name, path, parent_id FROM technology_categories ORDER BY path",
    );
  },
};
