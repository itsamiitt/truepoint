// searchDatabase.ts — the GLOBAL database search orchestration (Layer-0-as-database plan, slice 2).
// Two transactions, in the order the account-intelligence routes established:
//   1. withErTx  — read the shared graph (leadwolf_er; the visibility predicate is applied inside the
//                  repository, so a private/suppressed/merged person can never reach the mapper);
//   2. withTenantTx — RLS-scoped join back to the caller's overlay, to flag which hits they already hold.
// The mapper is pure and the projection carries NO Layer-0 identifier: a hit is addressed by its public
// LinkedIn slug/URL, which is also what "Add to workspace" takes.
import {
  type DatabaseSuggestField,
  type MasterPersonRow,
  contactRepository,
  masterPersonSearchRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import type {
  DatabaseQuery,
  MaskedDatabasePerson,
  SeniorityLevel,
  Suggestion,
} from "@leadwolf/types";

export interface DatabaseSearchScope {
  tenantId: string;
  workspaceId: string;
}

export function toMaskedDatabasePerson(
  row: MasterPersonRow,
  inWorkspace: { contactId: string; isRevealed: boolean } | null,
): MaskedDatabasePerson {
  return {
    linkedinPublicId: row.linkedinPublicId,
    linkedinUrl: `https://www.linkedin.com/in/${row.linkedinPublicId}`,
    fullName: row.fullName,
    firstName: row.firstName,
    lastName: row.lastName,
    headline: row.headline,
    jobTitle: row.jobTitle,
    seniorityLevel: (row.seniorityLevel as SeniorityLevel | null) ?? null,
    locationRaw: row.locationRaw,
    locationCity: row.locationCity,
    locationCountry: row.locationCountry,
    companyName: row.company?.name ?? null,
    companyDomain: row.company?.primaryDomain ?? null,
    companyIndustry: row.company?.industry ?? null,
    hasEmail: row.hasEmail,
    hasPhone: row.hasPhone,
    updatedAt: row.updatedAt.toISOString(),
    inWorkspace,
  };
}

export async function searchDatabase(
  scope: DatabaseSearchScope,
  query: DatabaseQuery,
): Promise<{ hits: MaskedDatabasePerson[]; nextCursor: string | null }> {
  const { rows, nextCursor } = await withErTx((tx) =>
    masterPersonSearchRepository.searchPersonsTx(tx, query),
  );
  if (rows.length === 0) return { hits: [], nextCursor };

  const owned = await withTenantTx(scope, (tx) =>
    contactRepository.findRevealStateBySlugs(
      tx,
      scope.workspaceId,
      rows.map((r) => r.linkedinPublicId),
    ),
  );
  return {
    hits: rows.map((r) => toMaskedDatabasePerson(r, owned.get(r.linkedinPublicId) ?? null)),
    nextCursor,
  };
}

/**
 * The total for the same predicate, CAPPED at DATABASE_COUNT_CAP.
 *
 * This used to be exact and uncapped. An exact count over a trgm-filtered population has unbounded cost as
 * the graph grows, and nothing bills or gates off this number — it is a grid header. The workspace contact
 * count made the same trade at the same ceiling (CONTACT_COUNT_CAP). `capped` tells the client to render
 * the value as a floor ("10,000+") rather than as an exact number.
 */
export async function countDatabase(
  query: DatabaseQuery,
): Promise<{ total: number; capped: boolean }> {
  // The cap is applied in SQL (a LIMIT subquery inside countPersonsTx), not here — capping the number after
  // an uncapped count would report a smaller figure while still paying to scan every matching row.
  return withErTx((tx) => masterPersonSearchRepository.countPersonsTx(tx, query));
}

/**
 * Typeahead over the Layer-0 satellite values (skills, languages, schools) — the values behind the
 * `database-only` filters, which the WORKSPACE suggest cannot serve: the overlay holds none of this data
 * and its role is REVOKEd from every `master_*` table.
 *
 * `withErTx` only. No tenant transaction and no workspace context of any kind: these are global facts, the
 * result is identical for every caller, and the visibility predicate inside the query is what keeps a
 * suppressed or private person from being inferable from a value or its count.
 */
export async function suggestDatabase(
  field: DatabaseSuggestField,
  prefix: string,
  limit: number,
): Promise<Suggestion[]> {
  const rows = await withErTx((tx) =>
    masterPersonSearchRepository.suggestDatabaseValuesTx(tx, field, prefix, limit),
  );
  return rows.map((r) => ({ value: r.value, displayLabel: r.value, count: r.count }));
}
