import { DATABASE_COUNT_CAP, type DatabaseFacetKey, type DatabaseQuery } from "@leadwolf/types";
// masterPersonSearchRepository.ts — the GLOBAL database search over Layer-0 persons (Layer-0-as-database
// plan, slice 2 [S-09][S-13][S-10]). A SIBLING of searchRepository, not a second SearchPort implementation:
// the overlay port is typed to workspace-owned contacts, and this returns people the workspace does NOT
// own (the account-search precedent for a second search surface).
//
// Every query is filtered by MASTER_PERSON_VISIBLE — the read-side policy predicate — so a private
// (workspace-minted), suppressed, or merged person can never appear in a hit or a count. The partial
// indexes in 0123 are built on exactly that predicate, so the filter is also what makes it fast.
// Runs under the caller's withErTx (leadwolf_er).
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import {
  MASTER_PERSON_VISIBLE,
  type MasterPersonRow,
  PERSON_FROM,
  PERSON_SELECT,
  type RawPersonRow,
  toMasterPersonRow,
} from "./masterPersonReadRepository.ts";

/** ILIKE-any over one column — the same substring semantics the overlay search uses (trgm-indexed). */
function ilikeAny(column: SQL, values: string[]): SQL {
  const legs = values.map((v) => sql`${column} ILIKE ${`%${v}%`}`);
  return sql`(${sql.join(legs, sql` OR `)})`;
}

/** Bound IN-list — sql.join per element (never `= ANY(${jsArray})`: Drizzle does not bind a JS array as a
 *  SQL array, and the failure is a runtime "malformed array literal"). */
function inList(column: SQL, values: string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

/** The FLAT columns — matched by substring (trgm-indexed) or, for the enum, by exact IN. */
const COL = {
  title: sql`p.job_title`,
  location: sql`p.location_raw`,
  company: sql`mc.name`,
  industry: sql`mc.industry`,
  seniority: sql`p.seniority_level`,
} as const;

/**
 * A SATELLITE fact: one row per (person, value) in a Layer-0 edge table, matched by a correlated EXISTS.
 *
 * EQUALITY, NEVER `ILIKE '%x%'`, and that is the whole performance story. Every column below is CITEXT, so
 * an IN-list is both case-insensitive AND served by the plain btree migration 0135 built for it — 0135's
 * own header says so: "citext … is fine for an equality/prefix btree — this is NOT the trgm case". A
 * leading-wildcard ILIKE would silently drop to a sequential scan of the edge table, and there is no trgm
 * GIN on any of these columns to catch it.
 *
 * Correlated on `p.id` rather than joined so the outer row count is untouched: a person with four matching
 * skills is one result, not four.
 */
function satelliteExists(table: SQL, column: SQL, values: string[]): SQL {
  return sql`EXISTS (SELECT 1 FROM ${table} sat
                      WHERE sat.master_person_id = p.id
                        AND ${inList(column, values)})`;
}

/** Build the WHERE leg for one term field. Flat columns and satellites dispatch from the same place so a
 *  new field cannot be added to the contract without a clause here (the enum indexes this switch). */
function termCondition(field: DatabaseFacetKey, values: string[]): SQL {
  switch (field) {
    case "seniority":
      // A closed enum — exact IN, not substring, or "vp" would also select "svp".
      return inList(COL.seniority, values);
    case "skill":
      return satelliteExists(sql`master_person_skills`, sql`sat.skill`, values);
    case "language":
      return satelliteExists(sql`master_person_languages`, sql`sat.name`, values);
    case "school":
      return satelliteExists(sql`master_education`, sql`sat.school_name_normalized`, values);
    case "field_of_study":
      // Array containment (`&&` = overlaps), served by 0135's GIN. Mirrors the company repo's
      // `specialtyCondition`. `fields_of_study` is nullable — "absent" is not "empty" — and `&&` is
      // false for NULL, which is the right answer for a person whose fields were never recorded.
      return sql`EXISTS (SELECT 1 FROM master_education sat
                          WHERE sat.master_person_id = p.id
                            AND sat.fields_of_study && ARRAY[${sql.join(
                              values.map((v) => sql`${v}`),
                              sql`, `,
                            )}]::text[])`;
    default:
      return ilikeAny(COL[field], values);
  }
}

/**
 * The satellite columns a global typeahead can draw values from, and the table each lives in.
 *
 * Deliberately NOT the flat person columns: `title`/`location` are free text over a table sized for
 * billions, where a prefix aggregate is a different (and much larger) query than an aggregate over an edge
 * table keyed by person. Those keep using the workspace suggest, which is what the sidebar has always shown.
 */
const SUGGEST_SOURCE = {
  skill: { table: sql`master_person_skills`, column: sql`sat.skill` },
  language: { table: sql`master_person_languages`, column: sql`sat.name` },
  school: { table: sql`master_education`, column: sql`sat.school_name_normalized` },
} as const;

export type DatabaseSuggestField = keyof typeof SUGGEST_SOURCE;

export function isDatabaseSuggestField(field: string): field is DatabaseSuggestField {
  return field in SUGGEST_SOURCE;
}

/**
 * Typeahead over the Layer-0 satellite values — the global twin of `searchRepository.suggest`.
 *
 * VISIBILITY IS NOT OPTIONAL HERE. The aggregate never returns a person, only values and counts, but a value
 * is still evidence: a suggestion that exists only because one suppressed or private person holds it
 * confirms that person is in the database, and the count says how many. That is the same reasoning the
 * workspace suggest records for its suppression anti-join — egress means egress — so this joins
 * `master_persons` purely to apply MASTER_PERSON_VISIBLE, and never to return anything from it.
 *
 * Prefix-matched (`ILIKE 'x%'`, not `'%x%'`) so the 0135 btrees serve it; these columns are CITEXT, so the
 * match is case-insensitive without a lower() that would defeat the index.
 */
export async function suggestDatabaseValuesTx(
  tx: Tx,
  field: DatabaseSuggestField,
  prefix: string,
  limit: number,
): Promise<Array<{ value: string; count: number }>> {
  // Same server-side floor as the workspace suggest: a 0/1-character prefix aggregates the whole edge table
  // per keystroke for a list the user has not meaningfully narrowed.
  if (prefix.trim().length < 2) return [];
  const src = SUGGEST_SOURCE[field];
  const rows = (await tx.execute(sql`
    SELECT ${src.column}::text AS value, count(*)::int AS n
      FROM ${src.table} sat
      JOIN master_persons p ON p.id = sat.master_person_id
     WHERE ${MASTER_PERSON_VISIBLE("p")}
       AND ${src.column} ILIKE ${`${prefix}%`}
     GROUP BY ${src.column}
     ORDER BY count(*) DESC, ${src.column}
     LIMIT ${limit}
  `)) as unknown as Array<{ value: string; n: number }>;
  return rows.map((r) => ({ value: r.value, count: r.n }));
}

export function buildWhere(query: DatabaseQuery): SQL {
  const conds: SQL[] = [
    MASTER_PERSON_VISIBLE("p"),
    // A person with no name is not a sellable search result (a landing whose payload carried none).
    sql`p.full_name IS NOT NULL`,
  ];
  for (const f of query.filters) {
    if (f.kind === "term") {
      const cond = termCondition(f.field, f.values);
      // An exclude must not also drop rows where the column is NULL — "not a Recruiter" includes people
      // with no title recorded. A bare NOT (…) evaluates to NULL for those and filters them out, which
      // reads as the exclude being far more aggressive than the user asked for.
      conds.push(f.op === "exclude" ? sql`NOT COALESCE(${cond}, false)` : cond);
    } else {
      const column = f.field === "has_email" ? sql`p.has_email` : sql`p.has_phone`;
      conds.push(sql`${column} = ${f.value}`);
    }
  }
  const text = query.text?.trim();
  if (text) {
    // Only INDEXED legs (the 0123 trgm GINs): name, title, company. A headline leg would be a seq scan.
    conds.push(
      sql`(p.full_name ILIKE ${`%${text}%`} OR p.job_title ILIKE ${`%${text}%`} OR mc.name ILIKE ${`%${text}%`})`,
    );
  }
  return sql.join(conds, sql` AND `);
}

/** Cursor = base64url JSON of the last row's (created_at, slug) — no Layer-0 id ever leaves the server. */
export function encodeCursor(payload: { k: string; s: string }): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
export function decodeCursor(cursor: string): { k: string; s: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed?.k === "string" && typeof parsed?.s === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export interface DatabaseSearchRows {
  rows: MasterPersonRow[];
  nextCursor: string | null;
}

export const masterPersonSearchRepository = {
  suggestDatabaseValuesTx,
  /**
   * Keyset page over the visible population, newest first.
   *
   * The cursor key is `created_at::text` — the FULL-PRECISION string — and not
   * `new Date(created_at).toISOString()`. That distinction is a correctness bug, not a style choice: a
   * timestamptz carries MICROSECONDS and a JS Date carries milliseconds, so the round trip truncates the
   * key DOWNWARD. The seek `(created_at, slug) < (k, s)` then excludes every row whose timestamp lies in
   * the microseconds between the truncated key and the real value — and because the walk is descending,
   * that interval is exactly where the next rows are.
   *
   * Two shapes it produced: rows written by one statement share a created_at, so the walk STALLED after a
   * single page; rows spread over real time were silently SKIPPED instead, which is the worse of the two
   * because nothing looks wrong. Caught by the company twin's full-cursor-walk itest, which failed on
   * `relevance` and `recently_updated` (the timestamp-keyed sorts) while the text- and int-keyed sorts
   * passed — this repository had the same defect and no test.
   */
  async searchPersonsTx(tx: Tx, query: DatabaseQuery): Promise<DatabaseSearchRows> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const seek = cursor
      ? sql` AND (p.created_at, p.linkedin_public_id) < (${cursor.k}::timestamptz, ${cursor.s})`
      : sql``;
    const raw = (await tx.execute(sql`
      SELECT ${PERSON_SELECT}, p.created_at::text AS cursor_created_at ${PERSON_FROM}
       WHERE ${buildWhere(query)}${seek}
       ORDER BY p.created_at DESC, p.linkedin_public_id DESC
       LIMIT ${query.limit + 1}
    `)) as unknown as Array<RawPersonRow & { cursor_created_at: string }>;

    const page = raw.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      raw.length > query.limit && last
        ? encodeCursor({ k: last.cursor_created_at, s: last.linkedin_public_id })
        : null;
    return { rows: page.map(toMasterPersonRow), nextCursor };
  },

  /**
   * Total for the same predicate, CAPPED (the grid header).
   *
   * Counting through a LIMIT subquery is what actually bounds the work — capping the number in JS after an
   * uncapped `count(*)` would report a smaller figure while still paying to scan every matching row. An
   * exact count over a trgm-filtered population has unbounded cost as the graph grows and nothing bills off
   * it, so the ceiling is real and the client renders the floor as "10,000+".
   */
  async countPersonsTx(tx: Tx, query: DatabaseQuery): Promise<{ total: number; capped: boolean }> {
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 ${PERSON_FROM} WHERE ${buildWhere(query)} LIMIT ${DATABASE_COUNT_CAP + 1}
      ) t
    `)) as unknown as Array<{ n: number }>;
    const n = rows[0]?.n ?? 0;
    return n > DATABASE_COUNT_CAP
      ? { total: DATABASE_COUNT_CAP, capped: true }
      : { total: n, capped: false };
  },
};
