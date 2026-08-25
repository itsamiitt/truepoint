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
import { workspaceOnlyFields } from "./filterGroups";

/** A grid row: a workspace contact, or a database person adapted to the same shape. */
export type ProspectRow = MaskedContact & {
  /** Set ⇒ this person is NOT in the workspace; the row is addressable only by their public slug. */
  databaseSlug?: string;
  databaseUrl?: string;
};

/**
 * Reduce a workspace query to a database query, reporting WHICH clauses (if any) forced the database half to
 * be skipped.
 *
 * Skipping is still the honest answer — silently dropping "owner = me" would show a stranger's record as if
 * it matched the user's own filter. What was NOT honest was doing it invisibly: 13 of the 20 sidebar controls
 * made this return null, and the entire global half of the grid vanished with no indication that a filter,
 * rather than the dataset, was the reason. The dropped fields come back with the result so the pane can say
 * so. See `facetScope` in filterGroups.ts — this reads the same metadata the sidebar badges do, so the two
 * cannot drift.
 */
export interface DatabaseQueryNarrowing {
  /** The query to run, or null when an active filter cannot be answered by the global graph. */
  query: DatabaseQuery | null;
  /** The workspace-only fields that caused `query` to be null, in sidebar order. Empty when it is not. */
  droppedFields: string[];
}

export function toDatabaseQuery(query: ContactQuery, limit: number): DatabaseQueryNarrowing {
  const droppedFields = workspaceOnlyFields(query);
  if (droppedFields.length > 0) return { query: null, droppedFields };

  const filters: DatabaseQuery["filters"] = [];
  for (const clause of query.filters) {
    if (clause.kind === "term") {
      // EXCLUDE crosses (the global contract gained `op` in stage 4). Before that it did not, and this
      // returned null for ANY excluding query — one "not in Recruiting" clause and the database half of the
      // grid silently disappeared. Passing the sense through is the fix; dropping it would show the user
      // exactly the people they asked to hide.
      filters.push({
        kind: "term",
        field: clause.field as "title" | "company" | "location" | "seniority" | "industry",
        op: clause.op,
        values: clause.values,
      });
      continue;
    }
    if (clause.kind === "bool") {
      filters.push({
        kind: "bool",
        field: clause.field as "has_email" | "has_phone",
        value: clause.value,
      });
      continue;
    }
    // Unreachable: every range facet is workspace-only, so `droppedFields` returned above. Kept as a guard
    // in case a future range facet is declared `both` without a mapping being added here.
    return { query: null, droppedFields: [clause.field] };
  }
  return { query: { text: query.text, filters, limit }, droppedFields: [] };
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
