// databaseRows.ts — the seam that makes ONE prospect search cover the whole platform database
// (Layer-0-as-database, revision: no separate scope). A sales-intelligence search is not "my records" and
// "everyone else" on two screens; it is one filtered list of people, where "already in my workspace" is a
// STATE of a row, not a different surface.
//
// Two mappings live here, both pure:
//   1. `toDatabaseQuery` — the workspace ContactQuery reduced to the facets the global graph can answer.
//      Workspace-only facets (owner, outreach status, tags, email verification state…) mean the user is
//      interrogating their OWN pipeline, so the database half is skipped entirely rather than answered
//      wrongly.
//   2. `databasePersonToRow` — a database person adapted into the grid's row shape, marked with
//      `databaseSlug` so the grid can render "Add to workspace" instead of reveal/bulk affordances.
import type {
  ContactQuery,
  DatabaseQuery,
  MaskedContact,
  MaskedDatabasePerson,
} from "@leadwolf/types";

/** A grid row: a workspace contact, or a database person adapted to the same shape. */
export type ProspectRow = MaskedContact & {
  /** Set ⇒ this person is NOT in the workspace; the row is addressable only by their public slug. */
  databaseSlug?: string;
  databaseUrl?: string;
};

/** Facets the global graph can answer, mapped 1:1 from the contact search's own field names. */
const SHARED_TERM_FIELDS = new Set(["title", "company", "location", "seniority", "industry"]);
/** Bool facets the graph carries as precomputed columns. */
const SHARED_BOOL_FIELDS = new Set(["has_email", "has_phone"]);

/**
 * Reduce a workspace query to a database query — or null when the query is inherently workspace-only.
 * Null is the honest answer: silently dropping "owner = me" would show a stranger's record as if it
 * matched the user's own filter.
 */
export function toDatabaseQuery(query: ContactQuery, limit: number): DatabaseQuery | null {
  const filters: DatabaseQuery["filters"] = [];
  for (const clause of query.filters) {
    if (clause.kind === "term") {
      // An EXCLUDE cannot be expressed against the graph's facets; treat its presence as workspace-only
      // rather than returning results the user explicitly asked to exclude.
      if (clause.op === "exclude") return null;
      if (!SHARED_TERM_FIELDS.has(clause.field)) return null;
      filters.push({
        kind: "term",
        field: clause.field as "title" | "company" | "location" | "seniority" | "industry",
        values: clause.values,
      });
      continue;
    }
    if (clause.kind === "bool") {
      if (!SHARED_BOOL_FIELDS.has(clause.field)) return null;
      filters.push({
        kind: "bool",
        field: clause.field as "has_email" | "has_phone",
        value: clause.value,
      });
      continue;
    }
    // Ranges (created_at, score, headcount…) are overlay-only signals.
    return null;
  }
  return { text: query.text, filters, limit };
}

/** Adapt a database person to the grid row shape. Workspace-only fields take their empty state — the row
 *  renders as a prospect the user does not own yet, which is exactly what it is. */
export function databasePersonToRow(p: MaskedDatabasePerson): ProspectRow {
  return {
    // Synthetic, stable, and never sent back to the server: the row is addressed by its slug.
    id: `db:${p.linkedinPublicId}`,
    firstName: p.firstName,
    lastName: p.lastName,
    jobTitle: p.jobTitle ?? p.headline,
    emailDomain: p.companyDomain,
    companyName: p.companyName,
    linkedinPublicId: p.linkedinPublicId,
    linkedinUrl: p.linkedinUrl,
    emailStatus: "unverified",
    phoneStatus: null,
    hasEmail: p.hasEmail,
    hasPhone: p.hasPhone,
    seniorityLevel: p.seniorityLevel,
    department: null,
    locationCountry: p.locationCountry,
    locationCity: p.locationCity ?? p.locationRaw,
    outreachStatus: "new",
    isRevealed: false,
    ownerUserId: null,
    createdAt: p.updatedAt,
    lastVerifiedAt: null,
    databaseSlug: p.linkedinPublicId,
    databaseUrl: p.linkedinUrl,
  };
}

/** Owned rows first, then database people the workspace does not already hold (deduped by slug). */
export function mergeRows(owned: MaskedContact[], database: MaskedDatabasePerson[]): ProspectRow[] {
  const held = new Set(owned.map((c) => c.linkedinPublicId).filter((s): s is string => Boolean(s)));
  const extra = database
    .filter((p) => !held.has(p.linkedinPublicId) && !p.inWorkspace)
    .map(databasePersonToRow);
  return [...(owned as ProspectRow[]), ...extra];
}
