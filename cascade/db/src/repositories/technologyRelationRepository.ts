// The develops-vs-uses traversals (03 §2, 05 §3–4).
// relationship_type is a REQUIRED argument on every read here — there is no
// call shape that returns portfolio and stack mixed together.

import type { DbClient } from "../client";

export type OrgTechRelationship = "develops" | "uses" | "resells";
export type EdgeStatus = "open" | "closed" | "all";

export interface OrgTechEdgeRow {
  rel_id: string;
  org_id: string;
  technology_id: string;
  canonical_name: string;
  tech_kind: string;
  category_path: string | null;
  relationship_type: string;
  confidence: string;
  valid_from: string;
  valid_to: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  detection_method: string | null;
  detected_on_domain: string | null;
  is_primary_product: boolean | null;
  launched_on: string | null;
}

export interface TraversalOptions {
  status?: EdgeStatus;
  minConfidence?: number;
  asOf?: string;
  closedSince?: string;
  limit?: number;
  cursor?: string | null;
}

/** Shared predicate builder — keeps status/as_of/min_confidence semantics identical
 *  in both traversal directions (the bug class where one side drifts). */
function buildFilters(opts: TraversalOptions, params: unknown[], alias: string): string {
  const clauses: string[] = [];
  const status = opts.status ?? "open";
  if (opts.asOf) {
    // Valid-time travel wins over status: edges true on that date.
    params.push(opts.asOf);
    const p = `$${params.length}`;
    clauses.push(
      `${alias}.valid_from <= ${p} AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ${p})`,
    );
  } else if (status === "open") {
    clauses.push(`${alias}.valid_to IS NULL`);
  } else if (status === "closed") {
    clauses.push(`${alias}.valid_to IS NOT NULL`);
    if (opts.closedSince) {
      params.push(opts.closedSince);
      clauses.push(`${alias}.valid_to >= $${params.length}`);
    }
  }
  if (opts.minConfidence !== undefined) {
    params.push(opts.minConfidence);
    clauses.push(`${alias}.confidence >= $${params.length}`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    clauses.push(`${alias}.rel_id > $${params.length}`);
  }
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

export const technologyRelationRepository = {
  /** "What did Sage build?" / "What does Sage run?" — one call, disjoint answers. */
  async technologiesForOrg(
    db: DbClient,
    orgId: string,
    relationship: OrgTechRelationship,
    opts: TraversalOptions = {},
  ): Promise<OrgTechEdgeRow[]> {
    const params: unknown[] = [orgId, relationship];
    const filters = buildFilters(opts, params, "r");
    params.push(Math.min(opts.limit ?? 25, 100));
    return db.query<OrgTechEdgeRow>(
      `SELECT r.rel_id, r.org_id, r.technology_id, t.canonical_name, t.tech_kind, c.path AS category_path,
              r.relationship_type, r.confidence, r.valid_from, r.valid_to,
              r.first_seen_at, r.last_seen_at, r.detection_method, r.detected_on_domain,
              r.is_primary_product, r.launched_on
       FROM org_technology_relations r
       JOIN technologies t ON t.technology_id = r.technology_id
       LEFT JOIN technology_categories c ON c.category_id = t.category_id
       WHERE r.org_id = $1 AND r.relationship_type = $2 ${filters}
       ORDER BY r.rel_id
       LIMIT $${params.length}`,
      params,
    );
  },

  /** The reverse traversal: adopters ("who uses GA") or makers ("who develops WordPress"). */
  async orgsForTechnology(
    db: DbClient,
    technologyId: string,
    relationship: OrgTechRelationship,
    opts: TraversalOptions = {},
  ): Promise<
    (OrgTechEdgeRow & { legal_name: string; display_name: string | null; org_kind: string })[]
  > {
    const params: unknown[] = [technologyId, relationship];
    const filters = buildFilters(opts, params, "r");
    params.push(Math.min(opts.limit ?? 25, 100));
    return db.query(
      `SELECT r.rel_id, r.org_id, r.technology_id, t.canonical_name, t.tech_kind, c.path AS category_path,
              r.relationship_type, r.confidence, r.valid_from, r.valid_to,
              r.first_seen_at, r.last_seen_at, r.detection_method, r.detected_on_domain,
              r.is_primary_product, r.launched_on,
              o.legal_name, o.display_name, o.org_kind
       FROM org_technology_relations r
       JOIN organizations o ON o.org_id = r.org_id
       JOIN technologies t ON t.technology_id = r.technology_id
       LEFT JOIN technology_categories c ON c.category_id = t.category_id
       WHERE r.technology_id = $1 AND r.relationship_type = $2 ${filters}
       ORDER BY r.rel_id
       LIMIT $${params.length}`,
      params,
    );
  },

  /** "Who made the tools Sage runs?" — uses → creator, in one query (05 §5). */
  async creatorsForTechnologies(
    db: DbClient,
    technologyIds: string[],
  ): Promise<
    { technology_id: string; org_id: string; display_name: string | null; legal_name: string }[]
  > {
    if (technologyIds.length === 0) return [];
    return db.query(
      `SELECT v.technology_id, o.org_id, o.display_name, o.legal_name
       FROM technology_vendors v
       JOIN organizations o ON o.org_id = v.org_id
       WHERE v.relationship = 'creator' AND v.valid_to IS NULL
         AND v.technology_id = ANY($1)`,
      [technologyIds],
    );
  },

  /** The bitemporal ownership ledger, optionally as-of a date (05 §8). */
  async vendorsForTechnology(
    db: DbClient,
    technologyId: string,
    asOf?: string,
  ): Promise<
    {
      link_id: string;
      org_id: string;
      legal_name: string;
      display_name: string | null;
      relationship: string;
      confidence: string;
      valid_from: string;
      valid_to: string | null;
    }[]
  > {
    const params: unknown[] = [technologyId];
    let filter = "";
    if (asOf) {
      params.push(asOf);
      filter = "AND v.valid_from <= $2 AND (v.valid_to IS NULL OR v.valid_to > $2)";
    }
    return db.query(
      `SELECT v.link_id, v.org_id, o.legal_name, o.display_name, v.relationship,
              v.confidence, v.valid_from, v.valid_to
       FROM technology_vendors v
       JOIN organizations o ON o.org_id = v.org_id
       WHERE v.technology_id = $1 ${filter}
       ORDER BY v.valid_from`,
      params,
    );
  },
};
