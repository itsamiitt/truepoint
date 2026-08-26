// databaseRows.ts — the seam that makes ONE prospect search cover the whole platform database
// (Layer-0-as-database, revision: no separate scope). A sales-intelligence search is not "my records" and
// "everyone else" on two screens; it is one filtered list of people, where "already in my workspace" is a
// STATE of a row, not a different surface.
//
// Three mappings live here, all pure:
//   1. `toDatabaseQuery` — the workspace ContactQuery reduced to the facets the global graph can answer.
//      Workspace-only facets (owner, outreach status, tags, email verification state…) mean the user is
//      interrogating their OWN pipeline, so the database half is skipped entirely rather than answered
//      wrongly. The QUICK-filter tier of the rail is exactly the shared set below, so a quick filter can
//      never make database people silently vanish.
//   2. `databasePersonToRow` — a database person adapted into the grid's row shape, marked with
//      `databaseSlug` so the grid can tell the two apart: a database row is NOT SAVED, so it is not selectable
//      for bulk actions, and its reveal IS the save gesture (decisions.md 2026-08-25) — there is no "Add".
//   3. `ownedRowFromDatabase` + the `materialized` map — after reveal-as-save the row flips IN PLACE to the
//      workspace contact it became (real id, revealed, Layer-0 presence kept), with no refetch and no jump
//      to the top of the grid under the reader's cursor.
import type {
  ContactQuery,
  DatabaseQuery,
  MaskedContact,
  MaskedDatabasePerson,
  RevealType,
} from "@leadwolf/types";

/** A grid row: a workspace contact, or a database person adapted to the same shape. */
export type ProspectRow = MaskedContact & {
  /** Set ⇒ this person is NOT in the workspace; the row is addressable only by their public slug. */
  databaseSlug?: string;
  databaseUrl?: string;
};

/** Facets the global graph can answer, mapped 1:1 from the contact search's own field names. */
export const SHARED_TERM_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "company",
  "location",
  "seniority",
  "industry",
]);
/** Bool facets the graph carries as precomputed columns. */
export const SHARED_BOOL_FIELDS: ReadonlySet<string> = new Set(["has_email", "has_phone"]);

/**
 * Reduce a workspace query to a database query — or null when the query is inherently workspace-only.
 * Null is the honest answer: silently dropping "owner = me" would show a stranger's record as if it
 * matched the user's own filter.
 */
export function toDatabaseQuery(query: ContactQuery, limit: number): DatabaseQuery | null {
  const filters: DatabaseQuery["filters"] = [];
  for (const clause of query.filters) {
    if (clause.kind === "term") {
      if (!SHARED_TERM_FIELDS.has(clause.field)) return null;
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

/** Layer-0 channel presence as the reveal-as-save response reports it — booleans, never values. */
export interface ChannelPresence {
  hasEmail: boolean;
  hasPhone: boolean;
}

/**
 * The workspace contact a database row became after reveal-as-save: the same row, with the real id, the
 * reveal marked, and the Layer-0 presence bits kept — the overlay copy carries no channel value until it is
 * revealed, so without them the OTHER channel's reveal would vanish from the grid. `revealedType` is
 * undefined when the landing succeeded but the reveal did not (402): saved, not yet revealed.
 */
export function ownedRowFromDatabase(
  row: ProspectRow,
  contactId: string,
  presence: ChannelPresence | undefined,
  revealedType: RevealType | undefined,
): MaskedContact {
  const { databaseSlug: _slug, databaseUrl: _url, ...base } = row;
  return {
    ...base,
    id: contactId,
    hasEmail: presence?.hasEmail ?? row.hasEmail,
    hasPhone: presence?.hasPhone ?? row.hasPhone,
    isRevealed: revealedType !== undefined,
    revealedTypes: revealedType ? [revealedType] : [],
  };
}

const NO_MATERIALIZED: ReadonlyMap<string, MaskedContact> = new Map();

/**
 * Owned rows first, then database people the workspace does not already hold (deduped by slug). A slug in
 * `materialized` renders as the workspace contact it became, IN ITS PLACE — even after the database half
 * refetches and reports it `inWorkspace` — until the owned half itself returns it, at which point the owned
 * copy wins and the row joins the saved section like every other saved row.
 */
export function mergeRows(
  owned: MaskedContact[],
  database: MaskedDatabasePerson[],
  materialized: ReadonlyMap<string, MaskedContact> = NO_MATERIALIZED,
): ProspectRow[] {
  const held = new Set(owned.map((c) => c.linkedinPublicId).filter((s): s is string => Boolean(s)));
  const extra = database
    .filter(
      (p) =>
        !held.has(p.linkedinPublicId) && (materialized.has(p.linkedinPublicId) || !p.inWorkspace),
    )
    .map((p) => materialized.get(p.linkedinPublicId) ?? databasePersonToRow(p));
  return [...(owned as ProspectRow[]), ...extra];
}

/** How many rows are still database people (not saved) — the "M more available" half of the header. */
export function countDatabaseRows(rows: ProspectRow[]): number {
  return rows.filter((r) => r.databaseSlug !== undefined).length;
}
