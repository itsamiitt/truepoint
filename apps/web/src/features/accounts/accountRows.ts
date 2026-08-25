// accountRows.ts — the seam that makes ONE Accounts search cover the whole platform database
// (search-consolidation stage 2). The company twin of the prospect slice's databaseRows.ts, and the same
// idea: a company search is not "my accounts" and "everyone else" on two screens; it is one filtered list of
// companies where "already in my workspace" is a STATE of a row.
//
// Two mappings, both pure:
//   1. `toDatabaseCompanyQuery` — the workspace AccountQuery reduced to the facets the global graph can
//      answer. Workspace-only facets (technology, funding stage, ICP score…) mean the user is interrogating
//      their OWN book, so the database half is skipped entirely rather than answered wrongly.
//   2. `databaseCompanyToRow` — a database company adapted into the grid's row shape, marked with
//      `databaseDomain` so the grid can tell the two apart.
import type {
  AccountQuery,
  DatabaseCompanyQuery,
  MaskedAccount,
  MaskedDatabaseCompany,
} from "@leadwolf/types";

/** A grid row: a workspace account, or a database company adapted to the same shape. */
export type AccountRow = MaskedAccount & {
  /** Set ⇒ this company is NOT in the workspace; the row is addressable only by its registrable domain. */
  databaseDomain?: string;
};

/** Account range fields with a global equivalent, by name. `revenue_range` is a workspace display string
 *  with no structured twin, so it is deliberately absent — and is declared workspace-only in the registry. */
const SHARED_RANGE_FIELDS: Record<string, "employee_count" | "founded_year"> = {
  employee_count: "employee_count",
  founded_year: "founded_year",
};

const SORT_MAP: Record<AccountQuery["sort"], DatabaseCompanyQuery["sort"]> = {
  relevance: "relevance",
  name_asc: "name_asc",
  headcount_desc: "headcount_desc",
  // The overlay's "created_desc" means "recently added to MY workspace", which has no meaning for a company
  // the workspace does not hold. The nearest honest global order is when the graph last learned something
  // about it.
  created_desc: "recently_updated",
};

/**
 * Reduce a workspace account query to a global company query, reporting WHICH clauses (if any) forced the
 * database half to be skipped.
 *
 * Skipping stays the honest answer — silently dropping "ICP score ≥ 80" would show companies the user
 * explicitly did not ask for. Doing it invisibly was not: the whole global half of the grid disappeared with
 * nothing to say a filter, rather than the dataset, was the reason. Which fields are answerable comes from
 * `accountFacetScope`, the same metadata the sidebar badges read.
 */
export interface DatabaseCompanyQueryNarrowing {
  query: DatabaseCompanyQuery | null;
  droppedFields: string[];
}

export function toDatabaseCompanyQuery(
  query: AccountQuery,
  limit: number,
  /**
   * The active fields the global graph cannot answer, from `accountFacetScope`. Passed IN rather than
   * imported: the filter registry lives in the prospect slice (which owns the Accounts filter panel), and
   * this module may not import another feature (lint:cross-feature). The caller already imports it.
   */
  workspaceOnlyFields: string[] = [],
): DatabaseCompanyQueryNarrowing {
  const droppedFields = workspaceOnlyFields;
  if (droppedFields.length > 0) return { query: null, droppedFields };

  const filters: DatabaseCompanyQuery["filters"] = [];

  for (const clause of query.filters) {
    if (clause.kind === "term") {
      filters.push({
        kind: "term",
        field: clause.field as "industry" | "hq_country" | "hq_city" | "employee_band",
        op: clause.op,
        values: clause.values,
      });
      continue;
    }
    if (clause.kind === "range") {
      const mapped = SHARED_RANGE_FIELDS[clause.field];
      // Unreachable while every `both` range facet is mapped above; a guard for the next one added.
      if (!mapped) return { query: null, droppedFields: [clause.field] };
      filters.push({
        kind: "range",
        field: mapped,
        ...(clause.gte !== undefined ? { gte: clause.gte } : {}),
        ...(clause.lte !== undefined ? { lte: clause.lte } : {}),
      });
      continue;
    }
    // Bool clauses on accounts are all overlay signals (has contacts, is revealed…) — workspace-only, and
    // the server drops them anyway, so they can never reach the global engine.
    return { query: null, droppedFields: [clause.field] };
  }

  return {
    query: { text: query.text, filters, sort: SORT_MAP[query.sort], limit },
    droppedFields: [],
  };
}

/**
 * Adapt a database company to the grid row shape. Workspace-only fields take their empty state — the row is
 * a company the user does not own yet, which is exactly what it is.
 */
export function databaseCompanyToRow(c: MaskedDatabaseCompany): AccountRow {
  return {
    // Synthetic, stable, and never sent back to the server: the row is addressed by its domain.
    id: `db:${c.primaryDomain}`,
    name: c.name,
    domain: c.primaryDomain,
    industry: c.industryLabel ?? c.industry,
    subIndustry: null,
    employeeCount: c.employeeCount,
    revenueRange: c.revenueDisplay,
    hqCountry: c.hqCountry,
    hqCity: c.hqCity,
    // Technologies and funding are Layer-0 subsystems with no production writer yet (0 rows), so a database
    // row honestly reports nothing rather than implying the data is merely missing for this company.
    technologies: [],
    fundingStage: null,
    companyStage: null,
    foundedYear: c.yearFounded,
    icpFitScore: null,
    contactCount: 0,
    revealedContactCount: 0,
    createdAt: c.updatedAt,
    databaseDomain: c.primaryDomain,
  };
}

/** Owned accounts first, then database companies the workspace does not already hold (deduped by domain). */
export function mergeAccountRows(
  owned: MaskedAccount[],
  database: MaskedDatabaseCompany[],
): AccountRow[] {
  // `accounts.domain` is citext and Layer-0 domains are stored lowercase, but the two are compared HERE in
  // JS, where case matters — lowercase both sides or a spelling difference renders the same company twice.
  const held = new Set(
    owned.map((a) => a.domain?.toLowerCase()).filter((d): d is string => Boolean(d)),
  );
  const extra = database
    .filter((c) => !held.has(c.primaryDomain.toLowerCase()) && !c.inWorkspace)
    .map(databaseCompanyToRow);
  return [...(owned as AccountRow[]), ...extra];
}
