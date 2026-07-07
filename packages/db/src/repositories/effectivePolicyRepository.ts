// effectivePolicyRepository.ts — the READ side of the Phase-1 effective-policy engine (doc 11 §3, doc 12).
// Returns the raw `auth_policies` rows a (tenant, workspace) is allowed to SEE: the platform-NULL defaults PLUS
// this tenant's own org/workspace rows — exactly what RLS admits under withTenantTx (rls/auth.sql: USING
// tenant_id = <guc> OR tenant_id IS NULL). The STRICTEST-WINS composition of these rows into an AuthPolicy lives
// in @leadwolf/auth (resolvePolicyFromRows): packages/db must NOT depend on @leadwolf/auth (that is the wrong
// dependency direction — auth already depends on db), so this returns raw rows and the auth layer composes.
// Cross-tenant isolation + the resolve are proven by test/effectivePolicyResolve.itest.ts + authPolicyIsolation.itest.ts.

import { withTenantTx } from "../client.ts";
import { authPolicies } from "../schema/auth.ts";

/** A raw effective-policy row. Structurally the @leadwolf/auth `AuthPolicyRow` — kept dependency-free here so
 *  packages/db stays upstream of the resolver. */
export interface EffectivePolicyRow {
  scope: string;
  workspaceId: string | null;
  key: string;
  value: unknown;
}

export const effectivePolicyRepository = {
  /**
   * Every `auth_policies` row visible to this (tenant, workspace) under RLS: the platform-NULL defaults + this
   * tenant's org and workspace rows. A bare SELECT under withTenantTx returns exactly those (RLS does the
   * tenant/platform filtering); the auth-layer resolver then narrows the workspace rows to the requested
   * workspace. `workspaceId` is forwarded to withTenantTx so the workspace GUC is set (defence in depth for any
   * future workspace-scoped RLS on this table).
   */
  async getScopeRows(scope: {
    tenantId: string;
    workspaceId?: string;
  }): Promise<EffectivePolicyRow[]> {
    return withTenantTx(scope, async (tx) =>
      tx
        .select({
          scope: authPolicies.scope,
          workspaceId: authPolicies.workspaceId,
          key: authPolicies.key,
          value: authPolicies.value,
        })
        .from(authPolicies),
    );
  },
};
