// effectivePolicyRepository.ts — the READ side of the Phase-1 effective-policy engine (doc 11 §3, doc 12).
// Returns the raw `auth_policies` rows a (tenant, workspace) is allowed to SEE: the platform-NULL defaults PLUS
// this tenant's own org/workspace rows — exactly what RLS admits under withTenantTx (rls/auth.sql: USING
// tenant_id = <guc> OR tenant_id IS NULL). The STRICTEST-WINS composition of these rows into an AuthPolicy lives
// in @leadwolf/auth (resolvePolicyFromRows): packages/db must NOT depend on @leadwolf/auth (that is the wrong
// dependency direction — auth already depends on db), so this returns raw rows and the auth layer composes.
// Cross-tenant isolation + the resolve are proven by test/effectivePolicyResolve.itest.ts + authPolicyIsolation.itest.ts.

import { eq, sql } from "drizzle-orm";
import { type Tx, withPlatformReadTx, withTenantTx } from "../client.ts";
import { authPolicies } from "../schema/auth.ts";
import { auditRepository } from "./auditRepository.ts";

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

  /**
   * Upsert ONE org- or workspace-scoped policy key and audit it, atomically, as the tenant's security_admin
   * under withTenantTx. The WITH-CHECK RLS stamps the row with the ACTIVE tenant (a cross-tenant write is
   * blocked at the DB — proven by authPolicyIsolation.itest). This method persists an ALREADY-VALIDATED write:
   * the value-shape guard (parsePolicyKeyValue) and the security-floor guard (findFloorViolations), both in
   * @leadwolf/auth, run in the app-layer orchestration BEFORE this. The PLATFORM default (NULL-tenant) write is
   * a SEPARATE staff-only path via withPlatformTx — deliberately not reachable here. Cache invalidation is
   * delete-on-write at the caller (drop the resolver key); `version` is bumped for audit/optimistic-concurrency.
   */
  async upsertTenantKey(args: {
    tenantId: string;
    workspaceId?: string;
    scope: "org" | "workspace";
    key: string;
    value: unknown;
    actorUserId: string;
  }): Promise<void> {
    const { tenantId, workspaceId, scope, key, value, actorUserId } = args;
    await withTenantTx({ tenantId, workspaceId }, async (tx) => {
      await tx
        .insert(authPolicies)
        .values({
          scope,
          tenantId,
          workspaceId: workspaceId ?? null,
          key,
          value,
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: [
            authPolicies.scope,
            authPolicies.tenantId,
            authPolicies.workspaceId,
            authPolicies.key,
          ],
          set: {
            value,
            updatedBy: actorUserId,
            updatedAt: new Date(),
            version: sql`${authPolicies.version} + 1`,
          },
        });
      // Audited in the SAME tx (append-only audit_log) — a failed upsert rolls the audit row back too. Never
      // the value (a policy value is not a secret, but the audit stays minimal): just the scope + key changed.
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: workspaceId ?? null,
        actorUserId,
        action: "settings.update",
        entityType: "auth_policy",
        entityId: tenantId,
        metadata: { scope, key },
      });
    });
  },

  /**
   * Every PLATFORM-default row (scope='platform', tenant_id NULL) — the global defaults a staff admin manages.
   * Read on the OWNER connection (withPlatformReadTx: RLS-exempt, no audit) since a staff caller has no tenant
   * context. Returns the raw key/value rows (a super_admin console edits individual keys); the strictest-wins
   * COMPOSITION into an effective policy stays in the auth-layer resolver. Staff-gated at the route.
   */
  async getPlatformRows(): Promise<EffectivePolicyRow[]> {
    return withPlatformReadTx((tx) =>
      tx
        .select({
          scope: authPolicies.scope,
          workspaceId: authPolicies.workspaceId,
          key: authPolicies.key,
          value: authPolicies.value,
        })
        .from(authPolicies)
        .where(eq(authPolicies.scope, "platform")),
    );
  },

  /**
   * Upsert a PLATFORM-default policy key (scope='platform', tenant_id NULL). STAFF-ONLY: runs on the supplied
   * platform-OWNER transaction — the caller opens `withPlatformTx(actor, action, tx => setPlatformKey(tx, …))`,
   * which is RLS-exempt (so it can write the NULL-tenant row that the RLS reserves for the owner) and records
   * the change in `platform_audit_log` in the SAME tx. Deliberately not reachable from a tenant request. The
   * value-shape + floor guards (validatePolicyWrite against the env/code minimum) run in the app-layer
   * orchestration BEFORE this. Bumps `version` on conflict (the platform NULL-tenant onConflict case).
   */
  async setPlatformKey(tx: Tx, key: string, value: unknown, updatedBy: string): Promise<void> {
    await tx
      .insert(authPolicies)
      .values({ scope: "platform", tenantId: null, workspaceId: null, key, value, updatedBy })
      .onConflictDoUpdate({
        target: [
          authPolicies.scope,
          authPolicies.tenantId,
          authPolicies.workspaceId,
          authPolicies.key,
        ],
        set: {
          value,
          updatedBy,
          updatedAt: new Date(),
          version: sql`${authPolicies.version} + 1`,
        },
      });
  },

  /**
   * One-time BACKFILL: copy every configured `tenant_auth_policies` row into the `auth_policies` org key/value
   * rows the effective-policy engine reads, so the new resolver sees the same policy today's login gates read
   * from the old table. IDEMPOTENT (ON CONFLICT DO NOTHING → re-runs are safe); ADDITIVE (tenant_auth_policies
   * is untouched — the finalize-login switch is a SEPARATE, later step); NULL optional columns (ip_allowlist,
   * the two timeouts) are skipped ("absent" = not set). Runs on an OWNER tx (a withPlatformTx wrapper), which is
   * RLS-exempt so it can write ORG rows across ALL tenants. `enforcement_enabled` is NOT copied — it is the
   * staff-only master switch and stays on tenant_auth_policies. jsonb columns (allowed_methods) are passed
   * through; scalar columns are to_jsonb()'d.
   */
  async backfillTenantPolicies(tx: Tx): Promise<void> {
    const copy = (key: string, expr: string, where = "") =>
      tx.execute(sql`
        INSERT INTO auth_policies (scope, tenant_id, key, value)
        SELECT 'org', tenant_id, ${key}, ${sql.raw(expr)} FROM tenant_auth_policies ${sql.raw(where)}
        ON CONFLICT DO NOTHING`);
    await copy("mfa_enforcement", "to_jsonb(mfa_enforcement)");
    await copy("allowed_methods", "allowed_methods"); // already jsonb
    await copy("disable_social", "to_jsonb(disable_social)");
    await copy("require_sso", "to_jsonb(require_sso)");
    await copy("ip_allowlist", "to_jsonb(ip_allowlist)", "WHERE ip_allowlist IS NOT NULL");
    await copy(
      "session_timeout_seconds",
      "to_jsonb(session_timeout_seconds)",
      "WHERE session_timeout_seconds IS NOT NULL",
    );
    await copy(
      "idle_timeout_seconds",
      "to_jsonb(idle_timeout_seconds)",
      "WHERE idle_timeout_seconds IS NOT NULL",
    );
  },
};
