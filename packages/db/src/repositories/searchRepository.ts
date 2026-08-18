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
// Suppression IS now covered: buildWhere carries a NOT EXISTS anti-join over suppression_list (all three
// match rungs), so results, facet counts and typeahead all exclude suppressed subjects. NOT yet covered
// (documented, follow-ups):
// revenue range (categorical column), signal_recency. Title facet counts/suggest group by raw job_title.
//
// S-CH4 READ CUTOVER (import-redesign 05 §5, G16): every entry point takes an optional
// `{ channelsFromChild }` opt — the caller-evaluated composed read gate (core's isChannelReadFromChildEnabled;
// this repo never reads flags). Gate-on: has_email/has_phone (filter + projection) become "∃ live child row"
// (secondaries count — HubSpot's top documented gap closed), the `complete` presence legs follow, the
// `company` filter's email-domain leg matches ANY live email's domain (contact_emails.email_domain, index
// §2.3), and each returned hit carries the masked `channels` summaries (counts + type/status/lineType/
// isPrimary — never values) via ONE batched query per page. Gate-off (the default): byte-identical SQL +
// payload to the pre-S-CH4 shape, zero child-table reads. Facet COUNT grouping + suggest for `company` stay
// on the flat primary domain either way (grouping by any-value domains changes row cardinality; the
// production-engine facet model is doc 12/G24's — recorded as a doc-16 drift row).

import type {
  ContactChannelSummaries,
  ContactQuery,
  FacetKey,
  MaskedContact,
  SuggestQuery,
  Suggestion,
} from "@leadwolf/types";
import { type SQL, and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contactEmails, contactPhones } from "../schema/contactChannels.ts";
import { accounts, contacts } from "../schema/contacts.ts";
import { contactChannelRepository } from "./contactChannelRepository.ts";

// 06 §4: a contact whose account is soft-deleted renders COMPANY-LESS — the account leftJoin filters tombstones
// so company text/facets never resolve through a tombstoned account row (the contact itself still returns; the
// join simply yields NULL company fields). Applied GATE-INDEPENDENTLY + BEHAVIOUR-NEUTRALLY: nothing writes
// `accounts.deleted_at` yet, so `deleted_at IS NULL` is identically true for every account and the result set
// is unchanged; it becomes load-bearing when the soft-delete verb lands (doc 04/11 slice).
const ACCOUNT_JOIN_LIVE: SQL = and(
  eq(accounts.id, contacts.accountId),
  sql`${accounts.deletedAt} IS NULL`,
) as SQL;

/** S-CH4 read options threaded from the caller-evaluated composed gate (default: flat, byte-identical). */
export interface SearchReadOpts {
  channelsFromChild?: boolean;
}

// "∃ live child value" — the 05 §5 gate-on presence predicates. RLS on contact_emails/contact_phones
// applies inside the subquery under the caller's withTenantTx GUC (the revealedTypes subquery precedent),
// and the correlation is by contact_id (index-backed via the contact-leading partial uniques).
const emailChildExists = sql`EXISTS (SELECT 1 FROM ${contactEmails} ce WHERE ce.contact_id = ${contacts.id} AND ce.deleted_at IS NULL)`;
const phoneChildExists = sql`EXISTS (SELECT 1 FROM ${contactPhones} cp WHERE cp.contact_id = ${contacts.id} AND cp.deleted_at IS NULL)`;
// Boolean-typed projection variants (the MASKED select's hasEmail/hasPhone columns swap to these gate-on).
const hasEmailFlat = sql<boolean>`${contacts.emailEnc} IS NOT NULL`;
const hasPhoneFlat = sql<boolean>`${contacts.phoneEnc} IS NOT NULL`;
const hasEmailChild = sql<boolean>`${emailChildExists}`;
const hasPhoneChild = sql<boolean>`${phoneChildExists}`;

/** Gate-on `company` email-domain leg (05 §5, G16): match ANY live email's `email_domain` (idx §2.3), not
 *  just the flat primary's. RLS on contact_emails applies inside the correlated EXISTS. */
function emailDomainChildMatch(values: string[]): SQL | undefined {
  const parts = values.map((v) => sql`ce.email_domain ILIKE ${`%${v}%`}`);
  if (parts.length === 0) return undefined;
  return sql`EXISTS (SELECT 1 FROM ${contactEmails} ce WHERE ce.contact_id = ${contacts.id} AND ce.deleted_at IS NULL AND (${or(...parts)}))`;
}

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
function clauseCondition(
  clause: ContactQuery["filters"][number],
  opts: SearchReadOpts,
): SQL | undefined {
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
        // Gate-on the email-domain leg matches ANY live email's domain (secondaries count, G16); gate-off it
        // is the flat primary domain, byte-identical. The account name/domain legs are unchanged either way.
        return inv(
          or(
            opts.channelsFromChild
              ? emailDomainChildMatch(clause.values)
              : ilikeAny(sql`${contacts.emailDomain}`, clause.values),
            ilikeAny(sql`${accounts.name}`, clause.values),
            ilikeAny(sql`${accounts.domain}`, clause.values),
          ),
        );
      case "industry":
        return inv(inArray(accounts.industry, clause.values));
      case "technology":
        // jsonb array overlap: does accounts.technologies contain ANY of the requested tech slugs.
        // Per-element params (ARRAY[$1,$2]::text[]) — a bare array param reaches the wire as a scalar
        // ("malformed array literal") under the driver's raw-fragment binding.
        return inv(
          sql`${accounts.technologies} ?| ARRAY[${sql.join(
            clause.values.map((v) => sql`${v}`),
            sql`, `,
          )}]::text[]`,
        );
      case "owner":
        return inv(
          sql`coalesce(${contacts.ownerUserId}, ${contacts.revealedByUserId}) = ANY(ARRAY[${sql.join(
            clause.values.map((v) => sql`${v}`),
            sql`, `,
          )}]::uuid[])`,
        );
      case "outreach_status":
        return inv(inArray(contacts.outreachStatus, clause.values));
      case "email_status":
        return inv(inArray(contacts.emailStatus, clause.values));
      case "source":
        return inv(
          sql`EXISTS (SELECT 1 FROM source_imports si WHERE si.contact_id = ${contacts.id} AND si.source_name = ANY(ARRAY[${sql.join(
            clause.values.map((v) => sql`${v}`),
            sql`, `,
          )}]::text[]))`,
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
        // "∃ live child email" gate-on (secondaries count, correct for no-primary edge states); flat gate-off.
        return is(
          opts.channelsFromChild ? emailChildExists : sql`${contacts.emailEnc} IS NOT NULL`,
        );
      case "has_phone":
        return is(
          opts.channelsFromChild ? phoneChildExists : sql`${contacts.phoneEnc} IS NOT NULL`,
        );
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
        // The email/phone presence legs follow has_email/has_phone (child gate-on, flat gate-off).
        return is(
          opts.channelsFromChild
            ? (sql`(${emailChildExists} AND ${phoneChildExists} AND ${contacts.linkedinUrl} IS NOT NULL AND ${contacts.jobTitle} IS NOT NULL)` as SQL)
            : sql`(${contacts.emailEnc} IS NOT NULL AND ${contacts.phoneEnc} IS NOT NULL AND ${contacts.linkedinUrl} IS NOT NULL AND ${contacts.jobTitle} IS NOT NULL)`,
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
    // `::text` is load-bearing, not noise. email_domain is CITEXT, and pg_trgm's gin_trgm_ops is defined over
    // `text` — citext is not binary-coercible to it, so the trgm index (migration 0081) has to be built on the
    // `(email_domain::text)` EXPRESSION. An expression index is only consulted when the query's expression
    // matches textually, so dropping this cast silently un-indexes this leg. Matching is unchanged: ILIKE is
    // case-insensitive regardless of citext's own collation. accountSearchRepository already casts `domain`
    // for the same reason.
    sql`${contacts.emailDomain}::text ILIKE ${like}`,
    sql`${contacts.linkedinUrl} ILIKE ${like}`,
  );
}

/**
 * The suppression anti-join (08-architecture invariant 3: "suppression checked at every egress"; S-11).
 *
 * A predicate, not a post-filter, because search is keyset-paginated: dropping suppressed rows AFTER the page
 * is built returns short pages and makes the cursor lie about how much is left. It has to happen inside the
 * query so LIMIT counts only rows the caller may actually see.
 *
 * Matches the same three rungs as suppressionRepository.findMatch. Scope comes from RLS — the read policy
 * exposes global + this tenant + this workspace and nothing else — which is why every caller of buildWhere
 * runs inside withTenantTx.
 *
 * MEASURED BEFORE SHIPPING, because this lands on the busiest read in the product and the honest answer was
 * not obvious. Against 200k contacts in one workspace with the 0094 indexes: page-of-50 goes from ~0.1ms to
 * 0.3–1.7ms, and — the part that mattered — it does NOT degrade as the suppression list grows, because
 * Postgres hashes the small side once. The worst case was measured deliberately: suppressing the NEWEST 100k
 * contacts, so the ordered scan must walk past every one of them to fill a page, still lands at 1.4ms. The
 * naive fixture (suppress the OLDEST) never reaches them and would have greenlit this on a best case.
 */
const NOT_SUPPRESSED: SQL = sql`NOT EXISTS (
  SELECT 1 FROM suppression_list s
   WHERE s.contact_id = ${contacts.id}
      OR (s.email_blind_index IS NOT NULL AND s.email_blind_index = ${contacts.emailBlindIndex})
      OR (s.domain IS NOT NULL AND s.domain = ${contacts.emailDomain}))`;

/** Combine all clauses + text + the not-deleted guard into one WHERE. `exceptFacet` drops a facet's own term
 *  filter (for live facet counts). Always includes deleted_at IS NULL (DSAR tombstones never surface) and the
 *  suppression anti-join — applied HERE, the single chokepoint, so results and facet COUNTS can never diverge.
 *  A count that included suppressed rows while the list excluded them would be its own bug, and a confusing
 *  one: the UI would promise records that are unreachable by design. */
function buildWhere(query: ContactQuery, opts: SearchReadOpts, exceptFacet?: FacetKey): SQL {
  const conds: (SQL | undefined)[] = [sql`${contacts.deletedAt} IS NULL`, NOT_SUPPRESSED];
  for (const clause of query.filters) {
    if (exceptFacet && clause.kind === "term" && clause.field === exceptFacet) continue;
    conds.push(clauseCondition(clause, opts));
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
  phoneStatus: contacts.phoneStatus,
  // Flat presence by default; runSearch swaps these two columns to the child-EXISTS variants gate-on
  // (05 §5 — "∃ live child row", identical in steady state by CH-INV-1, correct for no-primary edges).
  hasEmail: hasEmailFlat,
  hasPhone: hasPhoneFlat,
  seniorityLevel: contacts.seniorityLevel,
  department: contacts.department,
  locationCountry: contacts.locationCountry,
  locationCity: contacts.locationCity,
  outreachStatus: contacts.outreachStatus,
  isRevealed: contacts.isRevealed,
  // Which reveal_types THIS workspace owns a claim for (non-PII). A correlated subquery keeps the row
  // cardinality 1:1 (no GROUP BY over every masked column). contact_reveals has FORCE RLS scoped to
  // app.current_workspace_id (set by this repo's withTenantTx), so the subquery is auto-workspace-scoped —
  // mirrors the ownership derivation in revealRepository.ownedRevealFields. Empty array when nothing owned.
  revealedTypes: sql<string[]>`coalesce((
    SELECT array_agg(DISTINCT cr.reveal_type)
    FROM contact_reveals cr
    WHERE cr.contact_id = ${contacts.id}
  ), '{}')`,
  ownerUserId: sql<string | null>`coalesce(${contacts.ownerUserId}, ${contacts.revealedByUserId})`,
  priorityScore: contacts.priorityScore,
  createdAt: contacts.createdAt,
  lastVerifiedAt: contacts.lastVerifiedAt,
  // The linked account's display name (via the live-account left join every search query already makes).
  // Before this, the grid's "Company" column had only email_domain to render, so an email-less contact —
  // exactly what a capture/import without an email produces — displayed as company "—" while plainly saved.
  companyName: accounts.name,
  // URL-shaped identity (D4): a name-less row can still be identified by its slug; the grid links to it.
  linkedinPublicId: contacts.linkedinPublicId,
  linkedinUrl: contacts.linkedinUrl,
  salesNavProfileUrl: contacts.salesNavProfileUrl,
};

type MaskedRow = {
  // createdAt is NOT NULL (keep its non-null guarantee so the `as Date` cast stays sound); only
  // last_verified_at is nullable (null = never verified).
  [K in keyof typeof MASKED]: K extends "createdAt"
    ? Date
    : K extends "lastVerifiedAt"
      ? Date | null
      : unknown;
};

function toMasked(r: MaskedRow, channels?: ContactChannelSummaries): MaskedContact {
  return {
    id: r.id as string,
    firstName: r.firstName as string | null,
    lastName: r.lastName as string | null,
    jobTitle: r.jobTitle as string | null,
    emailDomain: r.emailDomain as string | null,
    emailStatus: r.emailStatus as MaskedContact["emailStatus"],
    phoneStatus: r.phoneStatus as MaskedContact["phoneStatus"],
    hasEmail: r.hasEmail as boolean,
    hasPhone: r.hasPhone as boolean,
    seniorityLevel: r.seniorityLevel as MaskedContact["seniorityLevel"],
    department: r.department as string | null,
    locationCountry: r.locationCountry as string | null,
    locationCity: r.locationCity as string | null,
    outreachStatus: r.outreachStatus as MaskedContact["outreachStatus"],
    isRevealed: r.isRevealed as boolean,
    revealedTypes: r.revealedTypes as string[] as MaskedContact["revealedTypes"],
    ownerUserId: r.ownerUserId as string | null,
    createdAt: (r.createdAt as Date).toISOString(),
    lastVerifiedAt: (r.lastVerifiedAt as Date | null)?.toISOString() ?? null,
    companyName: (r.companyName as string | null) ?? null,
    linkedinPublicId: (r.linkedinPublicId as string | null) ?? null,
    linkedinUrl: (r.linkedinUrl as string | null) ?? null,
    salesNavProfileUrl: (r.salesNavProfileUrl as string | null) ?? null,
    // Additive, gate-on only: the masked per-value channel summaries (counts + type/status/lineType/
    // isPrimary — never values/domains). ABSENT gate-off ⇒ the payload is byte-identical to pre-S-CH4.
    ...(channels ? { channels } : {}),
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
  /** Faceted, owner-scoped, keyset-paged contact search. Workspace-isolated via RLS (withTenantTx).
   *  `opts.channelsFromChild` is the caller-evaluated S-CH4 composed read gate (default off ⇒ byte-identical). */
  async searchContacts(
    scope: TenantScope,
    query: ContactQuery,
    opts: SearchReadOpts = {},
  ): Promise<SearchResultPage> {
    return withTenantTx(scope, (tx) => searchRepository.searchContactsTx(tx, query, opts));
  },

  /**
   * The tx-aware core of searchContacts — runs the same keyset query inside an ALREADY-OPEN withTenantTx so a
   * caller can compose it with other workspace-scoped reads/writes in ONE transaction (no cross-tx visibility
   * gap). Used by the Phase-4 dynamic-list members read: it resolves a dynamic list's membership by running the
   * list's saved ContactQuery here, inside the same tx as the list existence check (RLS is the boundary for
   * both). `searchContacts` is just this wrapped in its own withTenantTx.
   */
  async searchContactsTx(
    tx: Tx,
    query: ContactQuery,
    opts: SearchReadOpts = {},
  ): Promise<SearchResultPage> {
    const where = buildWhere(query, opts);
    // Sort + keyset: score_desc seeks on (priority_score, id); everything else on (created_at, id).
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await runSearch(tx, where, query.sort, query.limit + 1, cursor, opts);
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    let nextCursor: string | null = null;
    if (more && last) {
      const key =
        query.sort === "score_desc" ? (last.priorityScore ?? -1) : last.createdAt.toISOString();
      nextCursor = encodeCursor({ k: key, id: last.id });
    }
    // Gate-on: attach the masked per-value channel summaries via ONE batched query per table for the whole
    // page (no N+1; contactChannelRepository bounds it by page-size × the 25-value cap). Gate-off: nothing.
    let channelsById: Map<string, ContactChannelSummaries> | undefined;
    if (opts.channelsFromChild && page.length > 0) {
      channelsById = await contactChannelRepository.channelSummariesForContacts(
        tx,
        page.map((r) => r.id),
      );
    }
    return {
      hits: page.map((r) => toMasked(r, channelsById?.get(r.id))),
      nextCursor,
    };
  },

  /**
   * The TOTAL count of workspace-visible contacts matching a query (same WHERE as searchContacts, no paging) —
   * powers select-all-across-search ("Select all N results"). Workspace-isolated via RLS (withTenantTx). Exact,
   * uncapped count: only the per-request bulk MUTATION footprint is capped (the caller slices resolveVisibleIds).
   */
  async countContacts(
    scope: TenantScope,
    query: ContactQuery,
    opts: SearchReadOpts = {},
  ): Promise<number> {
    return withTenantTx(scope, (tx) => searchRepository.countContactsTx(tx, query, opts));
  },

  /** The tx-aware core of countContacts — the exact match total computed inside an already-open withTenantTx
   *  (so the Phase-4 dynamic-list read derives its member count in the SAME tx as the page it returns). */
  async countContactsTx(tx: Tx, query: ContactQuery, opts: SearchReadOpts = {}): Promise<number> {
    const where = buildWhere(query, opts);
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(contacts)
      .leftJoin(accounts, ACCOUNT_JOIN_LIVE)
      .where(where);
    return rows[0]?.n ?? 0;
  },

  /**
   * Match totals for MANY queries in ONE round-trip, keyed by the caller's key — a UNION ALL of the same
   * per-query counts `countContactsTx` computes individually.
   *
   * Postgres still evaluates one aggregate per query; what collapses is the round-trips. That is the part
   * that hurt: the dynamic-list index counted each list separately and sequentially inside a single held
   * transaction, so N lists serialised N network waits (and held a pooled connection for all of them) before
   * the page could return. Latency there is dominated by the round-trip, not the scans.
   */
  async countContactsBatchTx(
    tx: Tx,
    items: ReadonlyArray<{ key: string; query: ContactQuery }>,
    opts: SearchReadOpts = {},
  ): Promise<Map<string, number>> {
    if (items.length === 0) return new Map();
    const parts = items.map(
      (it) => sql`
        SELECT ${it.key}::text AS k, count(*)::int AS n
        FROM ${contacts}
        LEFT JOIN ${accounts} ON ${ACCOUNT_JOIN_LIVE}
        WHERE ${buildWhere(it.query, opts)}`,
    );
    const rows = (await tx.execute(sql.join(parts, sql` UNION ALL `))) as unknown as Array<{
      k: string;
      n: number;
    }>;
    return new Map(rows.map((r) => [r.k, Number(r.n)]));
  },

  /**
   * Resolve a query to the matching workspace-visible contact ids (the select-all-across-search → bulk-op
   * bridge): same filters/owner-scoping as searchContacts, sliced to `limit` ids in the stable search order
   * (created_at desc, id desc). The caller passes BULK_SELECTION_CAP as the limit so a runaway "select all"
   * can never resolve an unbounded id set into a single bulk mutation. Workspace-isolated via RLS. tx-aware so
   * the caller resolves ids INSIDE the same withTenantTx as the mutation (no cross-tx visibility gap).
   */
  async resolveVisibleIds(
    tx: Tx,
    query: ContactQuery,
    limit: number,
    opts: SearchReadOpts = {},
  ): Promise<string[]> {
    const where = buildWhere(query, opts);
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .leftJoin(accounts, ACCOUNT_JOIN_LIVE)
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
      const groupable = fields.filter((f) => FACET_EXPR[f]); // join-only facets aren't grouped here (documented)

      // Each facet's WHERE excludes that facet's OWN term filter, so its options stay independently countable.
      // That is the only reason the WHEREs differ — and `buildWhere(query, {}, f)` is identical to
      // `buildWhere(query, {})` unless the query actually carries a term clause on `f`. So the facets with no
      // active term filter all share one WHERE and can be counted in a SINGLE pass; only the (usually one or
      // two) actively-filtered facets still need their own.
      //
      // This is what the loop cost before: eight facets meant eight sequential re-executions of the entire
      // WHERE — ILIKE legs and the accounts join included — per request, to produce eight aggregates over the
      // same rows. In the common case (no facet filters applied) it is now one scan instead of eight.
      const filtered = new Set(
        query.filters.filter((c) => c.kind === "term").map((c) => c.field as FacetKey),
      );
      const shared = groupable.filter((f) => !filtered.has(f));
      const separate = groupable.filter((f) => filtered.has(f));

      if (shared.length > 0) {
        const exprs = shared.map((f) => FACET_EXPR[f] as SQL);
        // GROUPING SETS gives one aggregate per facet in a single scan. Each result row belongs to exactly one
        // set; `grouping(expr)` is 0 for the column that set grouped by and 1 for the others, which is how a
        // real NULL value is told apart from "this column isn't part of this row's set" — the two are
        // indistinguishable from the value alone, and the old per-facet `expr IS NOT NULL` guard cannot be
        // expressed in a shared WHERE.
        const selectCols = sql.join(
          exprs.map(
            (e, i) =>
              sql`grouping(${e}) AS ${sql.raw(`g${i}`)}, (${e})::text AS ${sql.raw(`v${i}`)}`,
          ),
          sql`, `,
        );
        // row_number() partitioned by the grouping-set bitmask reproduces the per-facet "top 50" the loop got
        // from its per-query LIMIT. Without it the app would have to receive every distinct value of every
        // facet — unbounded for high-cardinality ones like title or company — and trim client-side.
        const rows = (await tx.execute(sql`
          SELECT * FROM (
            SELECT ${selectCols}, count(*)::int AS n,
                   row_number() OVER (
                     PARTITION BY grouping(${sql.join(exprs, sql`, `)})
                     ORDER BY count(*) DESC
                   ) AS rn
            FROM ${contacts}
            LEFT JOIN ${accounts} ON ${ACCOUNT_JOIN_LIVE}
            WHERE ${buildWhere(query, {})}
            GROUP BY GROUPING SETS (${sql.join(
              exprs.map((e) => sql`(${e})`),
              sql`, `,
            )})
          ) t WHERE t.rn <= 50
        `)) as unknown as Array<Record<string, unknown>>;
        for (const row of rows) {
          // Find the one facet this row grouped by, then keep it only if the value is real (the NULL bucket is
          // what the old `expr IS NOT NULL` predicate dropped).
          const i = shared.findIndex((_f, idx) => Number(row[`g${idx}`]) === 0);
          if (i < 0) continue;
          const value = row[`v${i}`];
          if (value === null || value === undefined) continue;
          const v = String(value);
          out.push({
            field: shared[i] as FacetKey,
            value: v,
            displayLabel: v,
            count: Number(row.n),
          });
        }
      }

      for (const field of separate) {
        const expr = FACET_EXPR[field] as SQL;
        // Facet COUNT grouping stays on the flat primary domain either way (05 §5 / doc-16 drift — grouping
        // by any-value domains changes row cardinality; the production-engine facet model is doc 12/G24's).
        const where = and(buildWhere(query, {}, field), sql`${expr} IS NOT NULL`) as SQL;
        const rows = await tx
          .select({ value: sql<string>`${expr}::text`, count: sql<number>`count(*)::int` })
          .from(contacts)
          .leftJoin(accounts, ACCOUNT_JOIN_LIVE)
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
        .leftJoin(accounts, ACCOUNT_JOIN_LIVE)
        // Typeahead gets the anti-join too. It never returns a contact, only aggregated VALUES — but a value
        // is still evidence: a suggestion that only exists because one suppressed person holds it confirms
        // that person is in the database, and the count leaks how many. Egress means egress.
        .where(
          and(
            sql`${contacts.deletedAt} IS NULL`,
            NOT_SUPPRESSED,
            sql`${expr} ILIKE ${`${req.prefix}%`}`,
          ) as SQL,
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
  opts: SearchReadOpts = {},
) {
  // Gate-on the hasEmail/hasPhone projection columns resolve from live child rows ("∃ live row"); gate-off
  // they stay the flat-column presence, so the SELECT is byte-identical (the MaskedRow keys are unchanged).
  const select: typeof MASKED = opts.channelsFromChild
    ? { ...MASKED, hasEmail: hasEmailChild, hasPhone: hasPhoneChild }
    : { ...MASKED };
  const base = tx.select(select).from(contacts).leftJoin(accounts, ACCOUNT_JOIN_LIVE);

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
