// searchRepository.ts — the Postgres-backed SearchPort data layer (24, ADR-0035): faceted, owner-scoped
// contact search + live facet counts + typeahead, run within withTenantTx so workspace RLS is the hard
// boundary (a query can NEVER cross workspaces). This replaces the 500-row in-memory candidate cap with a
// real, index-backed query path (scalability). It lives in packages/db (NOT packages/search) because the
// dependency graph forbids search→db; the apps/api provider builds a SearchPort that delegates here.
//
// Coverage: term facets (title/seniority/department/location/company/industry/technology/owner/
// outreach_status/email_status/source/funding_stage/company_stage), boolean data signals (has_email/
// has_phone/has_linkedin/is_revealed/duplicate/never_contacted/complete), numeric ranges (headcount/
// company_age/score/created_at/last_activity_at as epoch-ms), free-text (name/title/company/linkedin), and
// keyset pagination. Owner = coalesce(owner_user_id, revealed_by_user_id) (the soft owner). Title canonical
// expansion happens in the apps/api provider (core taxonomy) before values reach here — the repo ILIKEs them.
// NOT yet covered (documented, follow-ups): do_not_contact/suppression (email/domain/contact matching),
// revenue range (categorical column), signal_recency. Title facet counts/suggest group by raw job_title.

import type {
  ContactQuery,
  FacetKey,
  MaskedContact,
  SuggestQuery,
  Suggestion,
} from "@leadwolf/types";
import { type SQL, and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { accounts, contacts } from "../schema/contacts.ts";

/** One keyset page of masked hits + the opaque cursor for the next page. */
export interface SearchResultPage {
  hits: MaskedContact[];
  nextCursor: string | null;
}

/** SQL fragment that resolves a facet to its grouping value (used by facetCounts + suggest). null = the facet
 *  needs a join/column the repo doesn't group on (skipped). Title groups by raw job_title (no canon here). */
const FACET_EXPR: Partial<Record<FacetKey, SQL>> = {
  title: sql`${contacts.jobTitle}`,
  seniority: sql`${contacts.seniorityLevel}`,
  department: sql`${contacts.department}`,
  company: sql`${contacts.emailDomain}`,
  industry: sql`${accounts.industry}`,
  owner: sql`coalesce(${contacts.ownerUserId}, ${contacts.revealedByUserId})`,
  outreach_status: sql`${contacts.outreachStatus}`,
  email_status: sql`${contacts.emailStatus}`,
  funding_stage: sql`${accounts.fundingStage}`,
  company_stage: sql`${accounts.companyStage}`,
};

/** ILIKE-any across the given values for one column (case-insensitive contains). */
function ilikeAny(col: SQL, values: string[]): SQL | undefined {
  const parts = values.map((v) => sql`${col} ILIKE ${`%${v}%`}`);
  return parts.length ? or(...parts) : undefined;
}

/** Build the WHERE condition for one filter clause. `null` = a clause this adapter doesn't support (skipped,
 *  documented above). `exceptFacet` lets facetCounts drop a facet's OWN term filter so its options still show
 *  their independent counts (Apollo behaviour). */
function clauseCondition(clause: ContactQuery["filters"][number]): SQL | undefined {
  if (clause.kind === "term") {
    const inv = (cond: SQL | undefined): SQL | undefined =>
      cond ? (clause.op === "exclude" ? (sql`NOT (${cond})` as SQL) : cond) : undefined;
    switch (clause.field) {
      case "title":
        return inv(ilikeAny(sql`${contacts.jobTitle}`, clause.values));
      case "seniority":
        return inv(inArray(contacts.seniorityLevel, clause.values));
      case "department":
        return inv(ilikeAny(sql`${contacts.department}`, clause.values));
      case "location":
        return inv(
          or(
            ilikeAny(sql`${contacts.locationCity}`, clause.values),
            ilikeAny(sql`${contacts.locationCountry}`, clause.values),
          ),
        );
      case "company":
        return inv(
          or(
            ilikeAny(sql`${contacts.emailDomain}`, clause.values),
            ilikeAny(sql`${accounts.name}`, clause.values),
            ilikeAny(sql`${accounts.domain}`, clause.values),
          ),
        );
      case "industry":
        return inv(inArray(accounts.industry, clause.values));
      case "technology":
        // jsonb array overlap: does accounts.technologies contain ANY of the requested tech slugs.
        return inv(sql`${accounts.technologies} ?| ${clause.values}::text[]`);
      case "owner":
        return inv(
          sql`coalesce(${contacts.ownerUserId}, ${contacts.revealedByUserId}) = ANY(${clause.values})`,
        );
      case "outreach_status":
        return inv(inArray(contacts.outreachStatus, clause.values));
      case "email_status":
        return inv(inArray(contacts.emailStatus, clause.values));
      case "source":
        return inv(
          sql`EXISTS (SELECT 1 FROM source_imports si WHERE si.contact_id = ${contacts.id} AND si.source_name = ANY(${clause.values}))`,
        );
      case "funding_stage":
        return inv(inArray(accounts.fundingStage, clause.values));
      case "company_stage":
        return inv(inArray(accounts.companyStage, clause.values));
      default:
        return undefined; // skill — no column on the overlay
    }
  }
  if (clause.kind === "bool") {
    const want = clause.value;
    const is = (cond: SQL): SQL => (want ? cond : (sql`NOT (${cond})` as SQL));
    switch (clause.field) {
      case "has_email":
        return is(sql`${contacts.emailEnc} IS NOT NULL`);
      case "has_phone":
        return is(sql`${contacts.phoneEnc} IS NOT NULL`);
      case "has_linkedin":
        return is(sql`${contacts.linkedinUrl} IS NOT NULL`);
      case "is_revealed":
        return is(sql`${contacts.isRevealed}`);
      case "duplicate":
        return is(sql`${contacts.duplicateOfContactId} IS NOT NULL`);
      case "never_contacted":
        // never_contacted=true ⇒ no outreach_log row exists for the contact.
        return want
          ? (sql`NOT EXISTS (SELECT 1 FROM outreach_log ol WHERE ol.contact_id = ${contacts.id})` as SQL)
          : (sql`EXISTS (SELECT 1 FROM outreach_log ol WHERE ol.contact_id = ${contacts.id})` as SQL);
      case "complete":
        return is(
          sql`(${contacts.emailEnc} IS NOT NULL AND ${contacts.phoneEnc} IS NOT NULL AND ${contacts.linkedinUrl} IS NOT NULL AND ${contacts.jobTitle} IS NOT NULL)`,
        );
      default:
        return undefined; // do_not_contact — suppression matching is a documented follow-up
    }
  }
  // range (epoch-ms for date fields)
  const col = rangeColumn(clause.field);
  if (!col) return undefined;
  const bounds: SQL[] = [];
  if (clause.gte !== undefined) bounds.push(sql`${col} >= ${clause.gte}`);
  if (clause.lte !== undefined) bounds.push(sql`${col} <= ${clause.lte}`);
  return bounds.length ? and(...bounds) : undefined;
}

/** Map a range field name to its numeric SQL expression. Dates compare as epoch milliseconds. */
function rangeColumn(field: string): SQL | undefined {
  switch (field) {
    case "headcount":
    case "employee_count":
      return sql`${accounts.employeeCount}`;
    case "company_age":
      return sql`(extract(year from now())::int - ${accounts.foundedYear})`;
    case "score":
      return sql`${contacts.priorityScore}`;
    case "created_at":
      return sql`(extract(epoch from ${contacts.createdAt}) * 1000)`;
    case "last_activity_at":
      return sql`(extract(epoch from ${contacts.lastActivityAt}) * 1000)`;
    default:
      return undefined;
  }
}

/** Free-text contains across the non-PII identity fields (name/title/company-domain/linkedin). */
function textCondition(text: string | undefined): SQL | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  const like = `%${t}%`;
  return or(
    sql`${contacts.firstName} ILIKE ${like}`,
    sql`${contacts.lastName} ILIKE ${like}`,
    sql`(coalesce(${contacts.firstName}, '') || ' ' || coalesce(${contacts.lastName}, '')) ILIKE ${like}`,
    sql`${contacts.jobTitle} ILIKE ${like}`,
    sql`${contacts.emailDomain} ILIKE ${like}`,
    sql`${contacts.linkedinUrl} ILIKE ${like}`,
  );
}

/** Combine all clauses + text + the not-deleted guard into one WHERE. `exceptFacet` drops a facet's own term
 *  filter (for live facet counts). Always includes deleted_at IS NULL (DSAR tombstones never surface). */
function buildWhere(query: ContactQuery, exceptFacet?: FacetKey): SQL {
  const conds: (SQL | undefined)[] = [sql`${contacts.deletedAt} IS NULL`];
  for (const clause of query.filters) {
    if (exceptFacet && clause.kind === "term" && clause.field === exceptFacet) continue;
    conds.push(clauseCondition(clause));
  }
  conds.push(textCondition(query.text));
  return and(...conds.filter((c): c is SQL => c !== undefined)) as SQL;
}

const MASKED = {
  id: contacts.id,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  jobTitle: contacts.jobTitle,
  emailDomain: contacts.emailDomain,
  emailStatus: contacts.emailStatus,
  hasEmail: sql<boolean>`${contacts.emailEnc} IS NOT NULL`,
  hasPhone: sql<boolean>`${contacts.phoneEnc} IS NOT NULL`,
  seniorityLevel: contacts.seniorityLevel,
  department: contacts.department,
  locationCountry: contacts.locationCountry,
  locationCity: contacts.locationCity,
  outreachStatus: contacts.outreachStatus,
  isRevealed: contacts.isRevealed,
  ownerUserId: sql<string | null>`coalesce(${contacts.ownerUserId}, ${contacts.revealedByUserId})`,
  priorityScore: contacts.priorityScore,
  createdAt: contacts.createdAt,
};

type MaskedRow = {
  [K in keyof typeof MASKED]: K extends "createdAt" ? Date : unknown;
};

function toMasked(r: MaskedRow): MaskedContact {
  return {
    id: r.id as string,
    firstName: r.firstName as string | null,
    lastName: r.lastName as string | null,
    jobTitle: r.jobTitle as string | null,
    emailDomain: r.emailDomain as string | null,
    emailStatus: r.emailStatus as MaskedContact["emailStatus"],
    hasEmail: r.hasEmail as boolean,
    hasPhone: r.hasPhone as boolean,
    seniorityLevel: r.seniorityLevel as MaskedContact["seniorityLevel"],
    department: r.department as string | null,
    locationCountry: r.locationCountry as string | null,
    locationCity: r.locationCity as string | null,
    outreachStatus: r.outreachStatus as MaskedContact["outreachStatus"],
    isRevealed: r.isRevealed as boolean,
    ownerUserId: r.ownerUserId as string | null,
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

export const searchRepository = {
  /** Faceted, owner-scoped, keyset-paged contact search. Workspace-isolated via RLS (withTenantTx). */
  async searchContacts(scope: TenantScope, query: ContactQuery): Promise<SearchResultPage> {
    return withTenantTx(scope, async (tx) => {
      const where = buildWhere(query);
      // Sort + keyset: score_desc seeks on (priority_score, id); everything else on (created_at, id).
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const rows = await runSearch(tx, where, query.sort, query.limit + 1, cursor);
      const more = rows.length > query.limit;
      const page = more ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];
      let nextCursor: string | null = null;
      if (more && last) {
        const key =
          query.sort === "score_desc" ? (last.priorityScore ?? -1) : last.createdAt.toISOString();
        nextCursor = encodeCursor({ k: key, id: last.id });
      }
      return { hits: page.map(toMasked), nextCursor };
    });
  },

  /**
   * The TOTAL count of workspace-visible contacts matching a query (same WHERE as searchContacts, no paging) —
   * powers select-all-across-search ("Select all N results"). Workspace-isolated via RLS (withTenantTx). Exact,
   * uncapped count: only the per-request bulk MUTATION footprint is capped (the caller slices resolveVisibleIds).
   */
  async countContacts(scope: TenantScope, query: ContactQuery): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const where = buildWhere(query);
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contacts)
        .leftJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(where);
      return rows[0]?.n ?? 0;
    });
  },

  /**
   * Resolve a query to the matching workspace-visible contact ids (the select-all-across-search → bulk-op
   * bridge): same filters/owner-scoping as searchContacts, sliced to `limit` ids in the stable search order
   * (created_at desc, id desc). The caller passes BULK_SELECTION_CAP as the limit so a runaway "select all"
   * can never resolve an unbounded id set into a single bulk mutation. Workspace-isolated via RLS. tx-aware so
   * the caller resolves ids INSIDE the same withTenantTx as the mutation (no cross-tx visibility gap).
   */
  async resolveVisibleIds(tx: Tx, query: ContactQuery, limit: number): Promise<string[]> {
    const where = buildWhere(query);
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .leftJoin(accounts, eq(accounts.id, contacts.accountId))
      .where(where)
      .orderBy(sql`${contacts.createdAt} DESC, ${contacts.id} DESC`)
      .limit(limit);
    return rows.map((r) => r.id);
  },

  /** Live facet counts: per requested facet, the count of matching contacts per value, EXCLUDING that
   *  facet's own term filter (so its options stay independently countable). Top 50 values per facet. */
  async facetCounts(
    scope: TenantScope,
    query: ContactQuery,
    fields: FacetKey[],
  ): Promise<{ field: FacetKey; value: string; displayLabel: string; count: number }[]> {
    return withTenantTx(scope, async (tx) => {
      const out: { field: FacetKey; value: string; displayLabel: string; count: number }[] = [];
      for (const field of fields) {
        const expr = FACET_EXPR[field];
        if (!expr) continue; // join-only facet not grouped by this adapter (documented)
        const where = and(buildWhere(query, field), sql`${expr} IS NOT NULL`) as SQL;
        const rows = await tx
          .select({ value: sql<string>`${expr}::text`, count: sql<number>`count(*)::int` })
          .from(contacts)
          .leftJoin(accounts, eq(accounts.id, contacts.accountId))
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

  /** Typeahead: distinct facet values matching the prefix, with their counts, most-frequent first. */
  async suggest(scope: TenantScope, req: SuggestQuery): Promise<Suggestion[]> {
    return withTenantTx(scope, async (tx) => {
      const expr = FACET_EXPR[req.field];
      if (!expr) return [];
      const rows = await tx
        .select({ value: sql<string>`${expr}::text`, count: sql<number>`count(*)::int` })
        .from(contacts)
        .leftJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(
          and(sql`${contacts.deletedAt} IS NULL`, sql`${expr} ILIKE ${`${req.prefix}%`}`) as SQL,
        )
        .groupBy(expr)
        .orderBy(desc(sql`count(*)`))
        .limit(req.limit);
      return rows.map((r) => ({ value: r.value, displayLabel: r.value, count: r.count }));
    });
  },
};

/** Run the keyset query for a given sort. Kept separate so the cursor seek predicate stays readable. */
function runSearch(
  tx: Tx,
  where: SQL,
  sort: ContactQuery["sort"],
  limit: number,
  cursor: { k: string | number | null; id: string } | null,
) {
  const base = tx
    .select({ ...MASKED })
    .from(contacts)
    .leftJoin(accounts, eq(accounts.id, contacts.accountId));

  let seek: SQL | undefined;
  let order: SQL;
  if (sort === "score_desc") {
    order = sql`coalesce(${contacts.priorityScore}, -1) DESC, ${contacts.id} DESC`;
    if (cursor) {
      seek = sql`(coalesce(${contacts.priorityScore}, -1), ${contacts.id}) < (${Number(cursor.k ?? -1)}::int, ${cursor.id}::uuid)`;
    }
  } else {
    order = sql`${contacts.createdAt} DESC, ${contacts.id} DESC`;
    if (cursor) {
      seek = sql`(${contacts.createdAt}, ${contacts.id}) < (${String(cursor.k)}::timestamptz, ${cursor.id}::uuid)`;
    }
  }
  const finalWhere = seek ? (and(where, seek) as SQL) : where;
  return base.where(finalWhere).orderBy(order).limit(limit);
}
