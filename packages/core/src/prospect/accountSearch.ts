// accountSearch.ts — thin domain seam for the COMPANY-level (accounts) search count (24/ADR-0035), the
// firmographic sibling of bulkActions.searchCount. The account-search read/facet/suggest paths go straight
// through the @leadwolf/db accountSearchRepository (no query-semantics layer is needed — accounts have no
// title-canonicalization step), so this module exists only for the one piece that belongs in core: the
// total-matching count that powers "Select all N companies" / result-count chrome. Workspace-isolated in the
// repo via withTenantTx (RLS is the hard wall).

import { type TenantScope, accountSearchRepository } from "@leadwolf/db";
import type { AccountQuery } from "@leadwolf/types";

type WorkspaceScope = TenantScope & { workspaceId: string };

/** The TOTAL matching, workspace-visible accounts for an AccountQuery (exact, uncapped). Mirrors searchCount. */
export async function searchAccountsCount(
  scope: WorkspaceScope,
  query: AccountQuery,
): Promise<{ total: number }> {
  const total = await accountSearchRepository.countAccounts(scope, query);
  return { total };
}
