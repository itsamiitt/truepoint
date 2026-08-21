// searchDatabaseCompanies.ts — the GLOBAL company search orchestration (search-consolidation stage 2).
// The company twin of searchDatabase.ts, and the same two transactions in the same order:
//   1. withErTx     — read the shared graph (leadwolf_er; MASTER_COMPANY_VISIBLE is applied inside the
//                     repository, so a school node or a minted stub can never reach the mapper);
//   2. withTenantTx — RLS-scoped probe back into the caller's overlay, to flag which hits they already hold.
//
// WHY TWO TRANSACTIONS AND NOT ONE JOIN. `leadwolf_app` is REVOKEd from every master_* table (explicitly,
// and again by a dynamic ^master_ loop in applyMigrations), and `leadwolf_er` cannot see `accounts`. A
// single query spanning both would require tearing down that wall. It stays up; this file pays two
// round-trips instead.
import {
  type MasterCompanyRow,
  accountRepository,
  masterCompanySearchRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import {
  type DatabaseCompanyQuery,
  EMPLOYEE_BANDS,
  type EmployeeBand,
  type MaskedDatabaseCompany,
} from "@leadwolf/types";

export interface DatabaseCompanyScope {
  tenantId: string;
  workspaceId: string;
}

/** How many candidates to read per requested row when owned companies must be filtered out server-side. */
const EXCLUDE_OWNED_OVERFETCH = 3;

/** Bucket a raw headcount into the canonical band. Null headcount → null band (NOT the smallest bucket:
 *  "unknown" and "1-10" are different facts and conflating them mislabels most of the population). */
export function bandFor(employeeCount: number | null): EmployeeBand | null {
  if (employeeCount === null) return null;
  const hit = EMPLOYEE_BANDS.find(
    (b) => employeeCount >= b.min && (b.max === null || employeeCount <= b.max),
  );
  return hit?.band ?? null;
}

export function toMaskedDatabaseCompany(
  row: MasterCompanyRow,
  inWorkspace: { accountId: string; contactCount: number } | null,
): MaskedDatabaseCompany {
  return {
    primaryDomain: row.primaryDomain,
    name: row.name,
    websiteUrl: row.websiteUrl,
    logoUrl: row.logoUrl,
    description: row.description,
    // Rebuilt from the id rather than stored: the projection carries URL-shaped identity only, and a
    // company's public LinkedIn URL is derivable from the numeric id the graph already holds.
    linkedinCompanyUrl: row.linkedinCompanyId
      ? `https://www.linkedin.com/company/${row.linkedinCompanyId}`
      : null,
    industry: row.industry,
    industryCode: row.industryCode,
    industryLabel: row.industryLabel,
    employeeCount: row.employeeCount,
    employeeBand: bandFor(row.employeeCount),
    revenueMinMinor: row.revenueMinMinor,
    revenueMaxMinor: row.revenueMaxMinor,
    revenueCurrency: row.revenueCurrency,
    revenueDisplay: row.revenueDisplay,
    ownershipType: row.ownershipType,
    yearFounded: row.yearFounded,
    specialties: row.specialties,
    hqCountry: row.hqCountry,
    hqCity: row.hqCity,
    updatedAt: row.updatedAt.toISOString(),
    inWorkspace,
  };
}

export interface SearchDatabaseCompaniesOptions {
  /** Drop hits the caller's workspace already holds. See the cursor note below before changing this. */
  excludeOwned?: boolean;
}

export async function searchDatabaseCompanies(
  scope: DatabaseCompanyScope,
  query: DatabaseCompanyQuery,
  options: SearchDatabaseCompaniesOptions = {},
): Promise<{ hits: MaskedDatabaseCompany[]; nextCursor: string | null }> {
  const excludeOwned = options.excludeOwned === true;

  // THE FILTERED-KEYSET CORRECTION. When owned rows are dropped after the page is read, the cursor must be
  // derived from the last CANDIDATE examined, not the last row returned — otherwise the rows that were
  // filtered out are silently SKIPPED on the next page. `searchCompaniesTx` returns exactly that cursor, so
  // the only thing this layer must not do is recompute one from `hits`. A short page with a non-null cursor
  // is correct and expected; the client keeps loading.
  const { rows, nextCursor } = await withErTx((tx) =>
    masterCompanySearchRepository.searchCompaniesTx(
      tx,
      query,
      excludeOwned ? EXCLUDE_OWNED_OVERFETCH : 1,
    ),
  );
  if (rows.length === 0) return { hits: [], nextCursor };

  const owned = await withTenantTx(scope, (tx) =>
    accountRepository.findByDomains(
      tx,
      scope.workspaceId,
      rows.map((r) => r.primaryDomain.toLowerCase()),
    ),
  );

  const mapped = rows.map((r) =>
    toMaskedDatabaseCompany(r, owned.get(r.primaryDomain.toLowerCase()) ?? null),
  );
  const kept = excludeOwned ? mapped.filter((h) => h.inWorkspace === null) : mapped;

  return { hits: kept.slice(0, query.limit), nextCursor };
}

export async function countDatabaseCompanies(
  query: DatabaseCompanyQuery,
): Promise<{ total: number; capped: boolean }> {
  return withErTx((tx) => masterCompanySearchRepository.countCompaniesTx(tx, query));
}

/** Live facet counts for the three low-cardinality company facets. */
export async function databaseCompanyFacets(
  query: DatabaseCompanyQuery,
  fields: Array<"industry" | "hq_country" | "ownership_type">,
): Promise<Array<{ field: string; value: string; count: number }>> {
  return withErTx(async (tx) => {
    const out: Array<{ field: string; value: string; count: number }> = [];
    for (const field of fields) {
      const rows = await masterCompanySearchRepository.facetCountsTx(tx, query, field);
      for (const r of rows) out.push({ field, value: r.value, count: r.count });
    }
    return out;
  });
}
