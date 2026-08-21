// masterCompanySearchRepository.ts — the GLOBAL company search over Layer-0 (search-consolidation stage 2).
// The company twin of masterPersonSearchRepository, and a SIBLING of accountSearchRepository rather than a
// replacement: that one searches the workspace's own `accounts` under RLS, this one searches every company
// the PLATFORM holds.
//
// Every query is filtered by MASTER_COMPANY_VISIBLE — the read-side policy predicate — so a school node, a
// minted stub, or a company with no addressable key can never appear in a hit or a count. The 0134 partial
// indexes are built on exactly that predicate, so the filter is also what makes it fast.
// Runs under the caller's withErTx (leadwolf_er).
import { DATABASE_COUNT_CAP, type DatabaseCompanyQuery, EMPLOYEE_BANDS } from "@leadwolf/types";

import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import {
  COMPANY_FROM,
  COMPANY_SELECT,
  MASTER_COMPANY_VISIBLE,
  type MasterCompanyRow,
  type RawCompanyRow,
  toMasterCompanyRow,
} from "./masterCompanyReadRepository.ts";
/** ILIKE-any over one column — the same substring semantics the rest of search uses (trgm-indexed). */
function ilikeAny(column: SQL, values: string[]): SQL {
  return sql`(${sql.join(
    values.map((v) => sql`${column} ILIKE ${`%${v}%`}`),
    sql` OR `,
  )})`;
}

/** Bound IN-list — sql.join per element. NEVER `= ANY(${jsArray})`: drizzle does not bind a JS array as a
 *  SQL array, and the failure is a runtime "malformed array literal", not a type error. */
function inList(column: SQL, values: string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

/** Map an employee_band label to its inclusive employee_count bounds. */
function bandBounds(label: string): { min: number; max: number | null } | undefined {
  return EMPLOYEE_BANDS.find((b) => b.band === label);
}

/**
 * `employee_band` is DERIVED: the column of that name on master_companies has no writer and is always NULL.
 * A band clause therefore becomes an OR of employee_count ranges — the same translation
 * accountSearchRepository does for the workspace twin, so one band↔range mapping serves both surfaces.
 * An unrecognised label contributes `false` rather than being dropped: silently ignoring an unknown band
 * would widen the result set past what the user asked for.
 */
function bandCondition(values: string[]): SQL {
  const legs = values.map((v) => {
    const b = bandBounds(v);
    if (!b) return sql`false`;
    return b.max === null
      ? sql`c.employee_count >= ${b.min}`
      : sql`c.employee_count BETWEEN ${b.min} AND ${b.max}`;
  });
  return sql`(${sql.join(legs, sql` OR `)})`;
}

/** `specialties` is text[] — containment, not ILIKE, so the GIN index serves it. */
function specialtyCondition(values: string[]): SQL {
  return sql`c.specialties && ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** hq_region lives on the locations edge, not on master_companies — an EXISTS keeps it out of the row shape. */
function regionCondition(values: string[]): SQL {
  return sql`EXISTS (
    SELECT 1 FROM master_company_locations l
     WHERE l.master_company_id = c.id AND l.kind = 'hq' AND ${ilikeAny(sql`l.region`, values)}
  )`;
}

const TERM_COL = {
  industry: sql`c.industry`,
  hq_country: sql`c.hq_country`,
  hq_city: sql`c.hq_city`,
  ownership_type: sql`c.ownership_type`,
} as const;

/** One term clause → its SQL condition, before the include/exclude sense is applied. */
function termCondition(field: string, values: string[]): SQL {
  if (field === "employee_band") return bandCondition(values);
  if (field === "specialty") return specialtyCondition(values);
  if (field === "hq_region") return regionCondition(values);
  // ownership_type is a normalized token ('public'|'private'|…), so it is an exact IN rather than a
  // substring match — 'public' must not also match 'publicly traded' spellings the mapper never emits.
  if (field === "ownership_type") return inList(TERM_COL.ownership_type, values);
  return ilikeAny(TERM_COL[field as keyof typeof TERM_COL] ?? sql`c.industry`, values);
}

const RANGE_COL = {
  employee_count: sql`c.employee_count`,
  founded_year: sql`c.year_founded`,
} as const;

/**
 * `revenue_minor` compares against the STRUCTURED band, and OVERLAP is the right semantic: a company whose
 * revenue band is 1M–5M matches a filter of "at least 2M", because part of its band satisfies it. Comparing
 * only the min (or only the max) would drop companies whose band straddles the bound.
 */
function rangeCondition(field: string, gte?: number, lte?: number): SQL {
  if (field === "revenue_minor") {
    const legs: SQL[] = [];
    if (gte !== undefined)
      legs.push(sql`coalesce(c.revenue_max_minor, c.revenue_min_minor) >= ${gte}`);
    if (lte !== undefined)
      legs.push(sql`coalesce(c.revenue_min_minor, c.revenue_max_minor) <= ${lte}`);
    return sql`(${sql.join(legs, sql` AND `)})`;
  }
  const col = RANGE_COL[field as keyof typeof RANGE_COL];
  const legs: SQL[] = [];
  if (gte !== undefined) legs.push(sql`${col} >= ${gte}`);
  if (lte !== undefined) legs.push(sql`${col} <= ${lte}`);
  return sql`(${sql.join(legs, sql` AND `)})`;
}

export function buildWhere(query: DatabaseCompanyQuery): SQL {
  const conds: SQL[] = [MASTER_COMPANY_VISIBLE("c")];

  for (const f of query.filters) {
    if (f.kind === "term") {
      const cond = termCondition(f.field, f.values);
      // An exclude must not also drop rows where the column is NULL — "not in Software" includes companies
      // with no industry recorded. `NOT (cond)` alone evaluates to NULL for those and filters them out.
      conds.push(f.op === "exclude" ? sql`NOT COALESCE(${cond}, false)` : cond);
      continue;
    }
    conds.push(rangeCondition(f.field, f.gte, f.lte));
  }

  const text = query.text?.trim();
  if (text) {
    // Only INDEXED legs (0123's name trgm + 0134's domain trgm). A description leg would be a seq scan over
    // the whole visible population, which is exactly what the trgm posture exists to avoid.
    conds.push(sql`(c.name ILIKE ${`%${text}%`} OR (c.primary_domain::text) ILIKE ${`%${text}%`})`);
  }
  return sql.join(conds, sql` AND `);
}

// ── Sort + keyset ───────────────────────────────────────────────────────────────────────────────────────
/** Cursor = base64url JSON of the last row's (sort key, domain). No Layer-0 id ever leaves the server. */
export function encodeCursor(payload: { k: string; d: string }): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
export function decodeCursor(cursor: string): { k: string; d: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed?.k === "string" && typeof parsed?.d === "string" ? parsed : null;
  } catch {
    return null;
  }
}

type Sort = DatabaseCompanyQuery["sort"];

/** ORDER BY + the matching seek predicate + how to read the cursor key off a row — kept in ONE place so a
 *  sort can never be added with a mismatched seek (which silently skips or repeats rows). */
const SORTS: Record<
  Sort,
  {
    order: SQL;
    seek: (c: { k: string; d: string }) => SQL;
    key: (r: RawCompanyRow & { created_at: string | Date }) => string;
  }
> = {
  relevance: {
    order: sql`c.created_at DESC, c.primary_domain DESC`,
    seek: (c) => sql`(c.created_at, c.primary_domain) < (${c.k}::timestamptz, ${c.d})`,
    key: (r) => new Date(r.created_at).toISOString(),
  },
  recently_updated: {
    order: sql`c.updated_at DESC, c.primary_domain DESC`,
    seek: (c) => sql`(c.updated_at, c.primary_domain) < (${c.k}::timestamptz, ${c.d})`,
    key: (r) => new Date(r.updated_at).toISOString(),
  },
  name_asc: {
    order: sql`c.name ASC, c.primary_domain ASC`,
    seek: (c) => sql`(c.name, c.primary_domain) > (${c.k}, ${c.d})`,
    key: (r) => r.name,
  },
  headcount_desc: {
    // coalesce so unknown headcount sorts last deterministically rather than clustering as NULLs whose
    // position depends on the planner. The 0134 expression index matches this expression textually.
    order: sql`coalesce(c.employee_count, -1) DESC, c.primary_domain DESC`,
    seek: (c) =>
      sql`(coalesce(c.employee_count, -1), c.primary_domain) < (${Number(c.k)}::int, ${c.d})`,
    key: (r) => String(r.employee_count ?? -1),
  },
};

export interface DatabaseCompanySearchRows {
  rows: MasterCompanyRow[];
  nextCursor: string | null;
}

export const masterCompanySearchRepository = {
  /**
   * One keyset page over the visible company population.
   *
   * `overfetch` exists for the caller that filters owned companies out AFTER the page is read (the
   * "exclude my workspace" mode). That anti-join cannot live in this query — leadwolf_app is REVOKEd from
   * every master_* table and leadwolf_er cannot see `accounts`, so the two halves are two transactions by
   * construction. The caller therefore asks for more candidates than it needs and derives nextCursor from
   * the last CANDIDATE examined, not the last row it returns — otherwise the filtered-out rows are skipped
   * on the next page. Bounded so it can never become an unbounded scan.
   */
  async searchCompaniesTx(
    tx: Tx,
    query: DatabaseCompanyQuery,
    overfetch = 1,
  ): Promise<DatabaseCompanySearchRows> {
    const spec = SORTS[query.sort];
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const seek = cursor ? sql` AND ${spec.seek(cursor)}` : sql``;
    const want = Math.min(query.limit * Math.max(1, overfetch), 300);

    const raw = (await tx.execute(sql`
      SELECT ${COMPANY_SELECT}, c.created_at ${COMPANY_FROM}
       WHERE ${buildWhere(query)}${seek}
       ORDER BY ${spec.order}
       LIMIT ${want + 1}
    `)) as unknown as Array<RawCompanyRow & { created_at: string | Date }>;

    const page = raw.slice(0, want);
    const last = page.at(-1);
    const nextCursor =
      raw.length > want && last
        ? encodeCursor({ k: spec.key(last), d: last.primary_domain })
        : null;
    return { rows: page.map(toMasterCompanyRow), nextCursor };
  },

  /** Total for the same predicate, capped. Counting through a LIMIT subquery bounds the work regardless of
   *  how many rows match — an exact count over a trgm-filtered population has unbounded cost. */
  async countCompaniesTx(
    tx: Tx,
    query: DatabaseCompanyQuery,
  ): Promise<{ total: number; capped: boolean }> {
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 ${COMPANY_FROM} WHERE ${buildWhere(query)} LIMIT ${DATABASE_COUNT_CAP + 1}
      ) t
    `)) as unknown as Array<{ n: number }>;
    const n = rows[0]?.n ?? 0;
    return n > DATABASE_COUNT_CAP
      ? { total: DATABASE_COUNT_CAP, capped: true }
      : { total: n, capped: false };
  },

  /** Live facet counts for the current query. Each facet is counted with its OWN clause removed, so the
   *  numbers answer "what would I get if I picked this instead", not "what is already selected". */
  async facetCountsTx(
    tx: Tx,
    query: DatabaseCompanyQuery,
    field: "industry" | "hq_country" | "ownership_type",
  ): Promise<Array<{ value: string; count: number }>> {
    const without: DatabaseCompanyQuery = {
      ...query,
      filters: query.filters.filter((f) => !(f.kind === "term" && f.field === field)),
    };
    const col = TERM_COL[field];
    const rows = (await tx.execute(sql`
      SELECT ${col} AS value, count(*)::int AS n ${COMPANY_FROM}
       WHERE ${buildWhere(without)} AND ${col} IS NOT NULL
       GROUP BY ${col}
       ORDER BY n DESC
       LIMIT 25
    `)) as unknown as Array<{ value: string; n: number }>;
    return rows.map((r) => ({ value: r.value, count: r.n }));
  },
};
