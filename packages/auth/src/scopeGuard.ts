// scopeGuard.ts — authorize a (possibly client-supplied) tenant selection against the user's REAL
// memberships, so a forged tenantId can never reach the minted access token (and thus the RLS GUC that
// trusts the `tid` claim). Kept pure and dependency-free (only typed errors — no db/config import) so the
// core cross-tenant-bypass guard is unit-testable without a database or env. (Phase 0a security fix.)

import { ForbiddenError, InvalidCredentialsError } from "@leadwolf/types";

/**
 * Resolve the authorized active org for a login.
 * - A client-supplied `requestedTenantId` (from the org-selection step) is UNTRUSTED: it must match one of
 *   the user's active memberships, or it is a forged cross-tenant selection → `ForbiddenError`.
 * - With no selection, fall back to the user's sole/first active membership.
 * - With no memberships at all, the login cannot complete → `InvalidCredentialsError`.
 */
export function authorizeTenantSelection(
  memberships: ReadonlyArray<{ tenantId: string }>,
  requestedTenantId: string | undefined,
): string {
  if (requestedTenantId) {
    if (!memberships.some((m) => m.tenantId === requestedTenantId)) {
      throw new ForbiddenError("tenant_forbidden");
    }
    return requestedTenantId;
  }
  const fallback = memberships[0]?.tenantId;
  if (!fallback) throw new InvalidCredentialsError();
  return fallback;
}
