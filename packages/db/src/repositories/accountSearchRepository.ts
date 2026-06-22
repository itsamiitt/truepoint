// accountSearchRepository.ts — the Postgres-backed COMPANY-level (accounts) search data layer (24, ADR-0035):
// the firmographic sibling of searchRepository. Faceted, keyset-paged account search + live facet counts +
// typeahead, run within withTenantTx so workspace RLS is the hard boundary (a query can NEVER cross
// workspaces). Lives in packages/db (NOT packages/search) because the dependency graph forbids search→db;
// the apps/api account-search feature delegates here. Accounts carry NO PII.
//
// Coverage: term facets (industry/sub_industry/technology(jsonb)/funding_stage/company_stage/revenue_range/
// hq_country/hq_city), numeric ranges (employee_count, founded_year→company_age, icp_fit_score), the derived
// employee_band facet, free-text (name/domain), keyset pagination, and the workspace-scoped per-account
// contact rollup (contactCount + revealedContactCount via a correlated subquery — RLS-isolated in the same tx).

import {
  type AccountFacetKey,
  type AccountQuery,
  type AccountSearchPage,
  type AccountSuggestQuery,
  EMPLOYEE_BANDS,
  type MaskedAccount,
} from "@leadwolf/types";
import { type SQL, and, desc, inArray, or, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { accounts } from "../schema/contacts.ts";

/** Workspace-scoped per-account contact rollup. RLS keeps the correlated subquery in the SAME workspace as
 *  the outer accounts row (the tx GUC gates contacts too), so the counts are workspace-isolated automatically. */
const CONTACT_COUNT = sql<number>`(
  SELECT count(*)::int FROM contacts cc WHERE cc.account_id = ${accounts.id} AND cc.deleted_at IS NULL
)`;
const REVEALED_CONTACT_COUNT = sql<number>`(
  SELECT count(*)::int FROM contacts cc
  WHERE cc.account_id = ${accounts.id} AND cc.deleted_at IS NULL AND cc.is_revealed
)`;

/** SQL fragment that resolves a facet to its grouping value (facetCounts + suggest). `employee_band` maps the
 *  numeric employee_count into the coarse band labels; `technology` is grouped via jsonb_array_elements_text. */
const FACET_EXPR: Partial<Record<AccountFacetKey, SQL>> = {
  industry: sql`${accounts.industry}`,
  sub_industry: sql`${accounts.subIndustry}`,
  funding_stage: sql`${accounts.fundingStage}`,
  company_stage: sql`${accounts.companyStage}`,
  revenue_range: sql`${accounts.revenueRange}`,
  hq_country: sql`${accounts.hqCountry}`,
  employee_band: employeeBandExpr(),
};

/** CASE expression that buckets employee_count into the canonical EMPLOYEE_BANDS labels (null = no headcount). */
function employeeBandExpr(): SQL {
  const whens = EMPLOYEE_BANDS.map((b) =>
    b.max === null
      ? sql`WHEN ${accounts.employeeCount} >= ${b.min} THEN ${b.band}`
      : sql`WHEN ${accounts.employeeCount} BETWEEN ${b.min} AND ${b.max} THEN ${b.band}`,
  );
  return sql`CASE ${sql.join(whens, sql` `)} ELSE NULL END`;
}

/** Map an employee_band label → its [min,max] bounds (used by the term filter on employee_band). */
function bandBounds(label: string): { min: number; max: number | null } | undefined {
  return EMPLOYEE_BANDS.find((b) => b.band === label);
}

/** ILIKE-any across the given values for one column (case-insensitive contains). */
function ilikeAny(col: SQL, values: string[]): SQL | undefined {
  const parts = values.map((v) => sql`${col} ILIKE ${`%${v}%`}`);
  return parts.length ? or(...parts) : undefined;
}

/** A term clause over a derived employee_band: each band → its employee_count range; OR them together. */
function employeeBandCondition(values: string[]): SQL | undefined {
  const ranges = values
    .map(bandBounds)
    .filter((b): b is { min: number; max: number | null } => b !== undefined)
    .map((b) =>
      b.max === null
        ? (sql`${accounts.employeeCount} >= ${b.min}` as SQL)
        : (sql`${accounts.employeeCount} BETWEEN ${b.min} AND ${b.max}` as SQL),
    );
  return ranges.length ? or(...ranges) : undefined;
}

/** Build the WHERE condition for one filter clause. `undefined` = a clause this adapter doesn't support
 *  (skipped). `exceptFacet` lets facetCounts drop a facet's OWN term filter so its options still show their
 *  independent counts (Apollo behaviour). Accounts have no boolean data-signals, so bool clauses are skipped. */
function clauseCondition(clause: AccountQuery["filters"][number]): SQL | undefined {
  if (clause.kind === "term") {
    const inv = (cond: SQL | undefined): SQL | undefined =>
      cond ? (clause.op === "exclude" ? (sql`NOT (${cond})` as SQL) : cond) : undefined;
    const values = clause.values;
    // `field` is the shared FilterClause's open string; dispatch on the account field names. Unknown fields
    // (e.g. a contact-only facet) fall through to `default` and are skipped (the adapter is the closed set).
    switch (clause.field) {
      case "industry":
        return inv(inArray(accounts.industry, values));
      case "sub_industry":
        return inv(inArray(accounts.subIndustry, values));
      case "technology":
        // jsonb array overlap: does accounts.technologies contain ANY of the requested tech slugs.
        return inv(sql`${accounts.technologies} ?| ${values}::text[]`);
      case "funding_stage":
        return inv(inArray(accounts.fundingStage, values));
      case "company_stage":
        return inv(inArray(accounts.companyStage, values));
      case "revenue_range":
        return inv(inArray(accounts.revenueRange, values));
      case "hq_country":
        return inv(inArray(accounts.hqCountry, values));
      case "hq_city":
        return inv(ilikeAny(sql`${accounts.hqCity}`, values));
      case "employee_band":
        return inv(employeeBandCondition(values));
      default:
        return undefined; // a contact-only facet — no column on accounts
    }
  }
  if (clause.kind === "bool") return undefined; // accounts have no boolean data-signals
  // range
  const col = rangeColumn(clause.field);
  if (!col) return undefined;
  const bounds: SQL[] = [];
  if (clause.gte !== undefined) bounds.push(sql`${col} >= ${clause.gte}`);
  if (clause.lte !== undefined) bounds.push(sql`${col} <= ${clause.lte}`);
  return bounds.length ? and(...bounds) : undefined;
}

/** Map a range field name to its numeric SQL expression. `company_age` derives from founded_year. */
function rangeColumn(field: string): SQL | undefined {
  switch (field) {
    case "headcount":
    case "employee_count":
      return sql`${accounts.employeeCount}`;
    case "founded_year":
      return sql`${accounts.foundedYear}`;
    case "company_age":
      return sql`(extract(year from now())::int - ${accounts.foundedYear})`;
    case "icp_fit_score":
    case "score":
      return sql`${accounts.icpFitScore}`;
    default:
      return undefined;
  }
}

/** Free-text contains across the company identity fields (name / domain). */
function textCondition(text: string | undefined): SQL | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  const like = `%${t}%`;
  return or(sql`${accounts.name} ILIKE ${like}`, sql`${accounts.domain}::text ILIKE ${like}`);
}

/** Combine all clauses + text into one WHERE. `exceptFacet` drops a facet's own term filter (for live facet
 *  counts). Workspace isolation is RLS (withTenantTx) — never spelled out in the WHERE. */
function buildWhere(query: AccountQuery, exceptFacet?: AccountFacetKey): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  for (const clause of query.filters) {
    if (exceptFacet && clause.kind === "term" && clause.field === exceptFacet) continue;
    conds.push(clauseCondition(clause));
  }
  conds.push(textCondition(query.text));
  const present = conds.filter((c): c is SQL => c !== undefined);
  return present.length ? (and(...present) as SQL) : undefined;
}

const SELECTION = {
  id: accounts.id,
  name: accounts.name,
  domain: accounts.domain,
  industry: accounts.industry,
  subIndustry: accounts.subIndustry,
  employeeCount: accounts.employeeCount,
  revenueRange: accounts.revenueRange,
  hqCountry: accounts.hqCountry,
  hqCity: accounts.hqCity,
  technologies: accounts.technologies,
  fundingStage: accounts.fundingStage,
  companyStage: accounts.companyStage,
  foundedYear: accounts.foundedYear,
  icpFitScore: accounts.icpFitScore,
  contactCount: CONTACT_COUNT,
  revealedContactCount: REVEALED_CONTACT_COUNT,
  createdAt: accounts.createdAt,
};

type AccountRow = {
  [K in keyof typeof SELECTION]: K extends "createdAt" ? Date : unknown;
};

/** Normalize the jsonb `technologies` column (stored as a JSON array) into a string[]. */
function toTechnologies(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return [];
}

function toMasked(r: AccountRow): MaskedAccount {
  return {
    id: r.id as string,
    name: r.name as string,
    domain: r.domain as string | null,
    industry: r.industry as string | null,
    subIndustry: r.subIndustry as string | null,
    employeeCount: r.employeeCount as number | null,
    revenueRange: r.revenueRange as string | null,
    hqCountry: r.hqCountry as string | null,
    hqCity: r.hqCity as string | null,
    technologies: toTechnologies(r.technologies),
    fundingStage: r.fundingStage as string | null,
    companyStage: r.companyStage as string | null,
    foundedYear: r.foundedYear as number | null,
    icpFitScore: r.icpFitScore as number | null,
    contactCount: r.contactCount as number,
    revealedContactCount: r.revealedContactCount as number,
    createdAt: (r.createdAt as Date).toISOString(),
  };
}

/** Cursor = base64 JSON of the last row's sort key + id (keyset, never offset). */
function encodeCursor(payload: { k: string | number | null; id: string }): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
function decodeCursor(cursor: string): { k: string | number | null; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export const accountSearchRepository = {
  /** Faceted, keyset-paged company search. Workspace-isolated via RLS (withTenantTx). */
  async searchAccounts(scope: TenantScope, query: AccountQuery): Promise<AccountSearchPage> {
    return withTenantTx(scope, async (tx) => {
      const where = buildWhere(query);
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const rows = await runSearch(tx, where, query.sort, query.limit + 1, cursor);
      const more = rows.length > query.limit;
      const page = more ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];
      let nextCursor: string | null = null;
      if (more && last) {
        const key =
          query.sort === "name_asc"
            ? (last.name as string)
            : query.sort === "headcount_desc"
              ? ((last.employeeCount as number | null) ?? -1)
              : (last.createdAt as Date).toISOString();
        nextCursor = encodeCursor({ k: key, id: last.id as string });
      }
      return { accounts: page.map(toMasked), nextCursor };
    });
  },

  /** The TOTAL count of workspace-visible accounts matching a query (same WHERE as searchAccounts, no paging). */
  async countAccounts(scope: TenantScope, query: AccountQuery): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const where = buildWhere(query);
      const base = tx.select({ n: sql<number>`count(*)::int` }).from(accounts);
      const rows = where ? await base.where(where) : await base;
      return rows[0]?.n ?? 0;
    });
  },

  /** Live facet counts: per requested facet, the count of matching accounts per value, EXCLUDING that facet's
   *  own term filter (so its options stay independently countable, Apollo behaviour). Top 50 values per facet.
   *  `technology` is counted per jsonb element (unnested); everything else groups by its column/expression. */
  async facetCounts(
    scope: TenantScope,
    query: AccountQuery,
    fields: AccountFacetKey[],
  ): Promise<{ field: AccountFacetKey; value: string; displayLabel: string; count: number }[]> {
    return withTenantTx(scope, async (tx) => {
      const out: { field: AccountFacetKey; value: string; displayLabel: string; count: number }[] =
        [];
      for (const field of fields) {
        const baseWhere = buildWhere(query, field);
        if (field === "technology") {
          // Count each technology slug independently by unnesting the jsonb array (LATERAL). Raw SQL via
          // tx.execute (the repo's established pattern for LATERAL/derived-alias queries); RLS still applies
          // because the workspace GUC + leadwolf_app role are set on this tx. The `${accounts.*}` fragments in
          // baseWhere render as "accounts"."col", consistent with FROM accounts.
          const whereSql = baseWhere ? sql`WHERE ${baseWhere}` : sql``;
          const rows = (await tx.execute(sql`
            SELECT tech.value AS value, count(*)::int AS count
            FROM accounts, LATERAL jsonb_array_elements_text(${accounts.technologies}) AS tech(value)
            ${whereSql}
            GROUP BY tech.value
            ORDER BY count(*) DESC
            LIMIT 50
          `)) as unknown as Array<{ value: string; count: number }>;
          for (const r of rows)
            out.push({ field, value: r.value, displayLabel: r.value, count: Number(r.count) });
          continue;
        }
        const expr = FACET_EXPR[field];
        if (!expr) continue;
        const where = and(baseWhere, sql`${expr} IS NOT NULL`) as SQL;
        const rows = await tx
          .select({ value: sql<string>`${expr}::text`, count: sql<number>`count(*)::int` })
          .from(accounts)
          .where(where)
          .groupBy(expr)
          .orderBy(desc(sql`count(*)`))
          .limit(50);
        for (const r of rows)
          out.push({ field, value: r.value, displayLabel: r.value, count: r.count });
      }
      return out;
    });
  },

  /** Typeahead: distinct account field values matching the prefix, with their counts, most-frequent first.
   *  `technology` suggests from the unnested jsonb slugs; everything else from the column. */
  async suggest(
    scope: TenantScope,
    req: AccountSuggestQuery,
  ): Promise<{ value: string; displayLabel: string; count: number }[]> {
    return withTenantTx(scope, async (tx) => {
      const like = `${req.prefix}%`;
      if (req.field === "technology") {
        // Prefix-match distinct tech slugs by unnesting the jsonb array (LATERAL). Raw SQL via tx.execute
        // (the repo's LATERAL pattern); RLS applies via the tx GUC + leadwolf_app role.
        const rows = (await tx.execute(sql`
          SELECT tech.value AS value, count(*)::int AS count
          FROM accounts, LATERAL jsonb_array_elements_text(${accounts.technologies}) AS tech(value)
          WHERE tech.value ILIKE ${like}
          GROUP BY tech.value
          ORDER BY count(*) DESC
          LIMIT ${req.limit}
        `)) as unknown as Array<{ value: string; count: number }>;
        return rows.map((r) => ({ value: r.value, displayLabel: r.value, count: Number(r.count) }));
      }
      const col = suggestColumn(req.field);
      const rows = await tx
        .select({ value: sql<string>`${col}::text`, count: sql<number>`count(*)::int` })
        .from(accounts)
        .where(and(sql`${col} IS NOT NULL`, sql`${col}::text ILIKE ${like}`) as SQL)
        .groupBy(col)
        .orderBy(desc(sql`count(*)`))
        .limit(req.limit);
      return rows.map((r) => ({ value: r.value, displayLabel: r.value, count: r.count }));
    });
  },
};

/** Map a suggest field → its column expression (technology is handled separately via jsonb unnest). */
function suggestColumn(field: AccountSuggestQuery["field"]): SQL {
  switch (field) {
    case "industry":
      return sql`${accounts.industry}`;
    case "sub_industry":
      return sql`${accounts.subIndustry}`;
    case "hq_country":
      return sql`${accounts.hqCountry}`;
    case "hq_city":
      return sql`${accounts.hqCity}`;
    default:
      return sql`${accounts.name}`;
  }
}

/** Run the keyset query for a given sort. Kept separate so the cursor seek predicate stays readable.
 *  relevance|created_desc seek on (created_at, id) desc; name_asc on (name, id) asc; headcount_desc on
 *  (coalesce(employee_count,-1), id) desc. The (workspace_id, …) btree indexes back each sort. */
function runSearch(
  tx: Tx,
  where: SQL | undefined,
  sort: AccountQuery["sort"],
  limit: number,
  cursor: { k: string | number | null; id: string } | null,
) {
  const base = tx.select({ ...SELECTION }).from(accounts);

  let seek: SQL | undefined;
  let order: SQL;
  if (sort === "name_asc") {
    order = sql`${accounts.name} ASC, ${accounts.id} ASC`;
    if (cursor)
      seek = sql`(${accounts.name}, ${accounts.id}) > (${String(cursor.k)}, ${cursor.id}::uuid)`;
  } else if (sort === "headcount_desc") {
    order = sql`coalesce(${accounts.employeeCount}, -1) DESC, ${accounts.id} DESC`;
    if (cursor)
      seek = sql`(coalesce(${accounts.employeeCount}, -1), ${accounts.id}) < (${Number(cursor.k ?? -1)}::int, ${cursor.id}::uuid)`;
  } else {
    order = sql`${accounts.createdAt} DESC, ${accounts.id} DESC`;
    if (cursor)
      seek = sql`(${accounts.createdAt}, ${accounts.id}) < (${String(cursor.k)}::timestamptz, ${cursor.id}::uuid)`;
  }
  const finalWhere = where && seek ? (and(where, seek) as SQL) : (seek ?? where);
  const q = finalWhere ? base.where(finalWhere) : base;
  return q.orderBy(order).limit(limit);
}
