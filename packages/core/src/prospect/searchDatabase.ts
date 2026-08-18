// searchDatabase.ts — the GLOBAL database search orchestration (Layer-0-as-database plan, slice 2).
// Two transactions, in the order the account-intelligence routes established:
//   1. withErTx  — read the shared graph (leadwolf_er; the visibility predicate is applied inside the
//                  repository, so a private/suppressed/merged person can never reach the mapper);
//   2. withTenantTx — RLS-scoped join back to the caller's overlay, to flag which hits they already hold.
// The mapper is pure and the projection carries NO Layer-0 identifier: a hit is addressed by its public
// LinkedIn slug/URL, which is also what "Add to workspace" takes.
import {
  type MasterPersonRow,
  contactRepository,
  masterPersonSearchRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import type { DatabaseQuery, MaskedDatabasePerson, SeniorityLevel } from "@leadwolf/types";

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

export async function countDatabase(query: DatabaseQuery): Promise<{ total: number }> {
  const total = await withErTx((tx) => masterPersonSearchRepository.countPersonsTx(tx, query));
  return { total };
}
