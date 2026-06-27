// authPolicyRepository.ts — read/upsert a tenant's auth policy (ADR-0018, 17 §10): the Auth Admin
// Security & Access record. tenant_auth_policies is tenant-scoped (RLS USING tenant_id = GUC), so the read +
// the tenant upsert run under withTenantTx as leadwolf_app — a security_admin only ever touches their OWN
// org's policy. The write is AUDITED (settings.update on auth_policy) in the SAME transaction. The
// strictest-wins resolution applied at login lives in @leadwolf/auth (resolveEffectivePolicy); this is the
// raw per-tenant record the org edits.
//
// The per-tenant ENFORCEMENT master switch (enforcement_enabled, P1-01) is STAFF-ONLY: it is never part of
// the tenant-editable AuthPolicy, the tenant upsert leaves it untouched, and only setEnforcement (run on the
// platform owner connection via withPlatformTx) flips it. getForEnforcement reads policy + the flag together
// so the login/refresh gates resolve both in one round-trip.

import type { AuthPolicy } from "@leadwolf/types";
import { eq } from "drizzle-orm";
import { type Tx, withTenantTx } from "../client.ts";
import { tenantAuthPolicies } from "../schema/auth.ts";
import { auditRepository } from "./auditRepository.ts";

// Platform default when a tenant has never configured a policy (mirrors authPolicySchema's defaults).
const DEFAULT_POLICY: AuthPolicy = {
  mfaEnforcement: "optional",
  allowedMethods: ["password", "oauth", "magic_link", "sso", "passkey"],
  disableSocial: false,
  requireSso: false,
  ipAllowlist: [],
};

type PolicyRow = typeof tenantAuthPolicies.$inferSelect;

// Map a raw row to the tenant-editable AuthPolicy. Optional timeouts are omitted when null (the contract is
// `number | undefined`, never null). enforcement_enabled is intentionally NOT projected here — it is staff
// state, surfaced only through getForEnforcement.
function rowToPolicy(r: PolicyRow): AuthPolicy {
  return {
    mfaEnforcement: r.mfaEnforcement as AuthPolicy["mfaEnforcement"],
    allowedMethods: (r.allowedMethods as AuthPolicy["allowedMethods"]) ?? [],
    disableSocial: r.disableSocial,
    requireSso: r.requireSso,
    ipAllowlist: r.ipAllowlist ?? [],
    ...(r.sessionTimeoutSeconds != null ? { sessionTimeoutSeconds: r.sessionTimeoutSeconds } : {}),
    ...(r.idleTimeoutSeconds != null ? { idleTimeoutSeconds: r.idleTimeoutSeconds } : {}),
  };
}

export const authPolicyRepository = {
  /** The tenant's configured policy, or the platform default when none is set. */
  async getForTenant(tenantId: string): Promise<AuthPolicy> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantAuthPolicies)
        .where(eq(tenantAuthPolicies.tenantId, tenantId))
        .limit(1);
      const r = rows[0];
      return r ? rowToPolicy(r) : DEFAULT_POLICY;
    });
  },

  /**
   * The tenant's policy AND its per-tenant enforcement master switch, in one read — for the login/refresh
   * gates (packages/auth). enforcementEnabled defaults to false when no row exists, so an unconfigured tenant
   * is never enforced. The gates additionally require the global env master-arm (defence in depth).
   */
  async getForEnforcement(
    tenantId: string,
  ): Promise<{ policy: AuthPolicy; enforcementEnabled: boolean }> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantAuthPolicies)
        .where(eq(tenantAuthPolicies.tenantId, tenantId))
        .limit(1);
      const r = rows[0];
      if (!r) return { policy: DEFAULT_POLICY, enforcementEnabled: false };
      return { policy: rowToPolicy(r), enforcementEnabled: r.enforcementEnabled };
    });
  },

  /** Upsert the tenant's policy and audit the change (settings.update) atomically. enforcement_enabled is
   *  NOT in the value/set lists, so a tenant policy edit never flips the staff-controlled master switch (the
   *  column keeps its default on insert and its current value on conflict). */
  async upsert(tenantId: string, policy: AuthPolicy, actorUserId: string): Promise<void> {
    await withTenantTx({ tenantId }, async (tx) => {
      const values = {
        tenantId,
        mfaEnforcement: policy.mfaEnforcement,
        allowedMethods: policy.allowedMethods,
        disableSocial: policy.disableSocial,
        requireSso: policy.requireSso,
        ipAllowlist: policy.ipAllowlist,
        sessionTimeoutSeconds: policy.sessionTimeoutSeconds ?? null,
        idleTimeoutSeconds: policy.idleTimeoutSeconds ?? null,
      };
      await tx
        .insert(tenantAuthPolicies)
        .values(values)
        .onConflictDoUpdate({
          target: tenantAuthPolicies.tenantId,
          set: { ...values, updatedAt: new Date() },
        });
      // Audit in the same tx (append-only audit_log) — a failed upsert rolls the audit row back too.
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null, // tenant-level policy change
        actorUserId,
        action: "settings.update",
        entityType: "auth_policy",
        entityId: tenantId,
        metadata: {
          mfaEnforcement: policy.mfaEnforcement,
          requireSso: policy.requireSso,
          disableSocial: policy.disableSocial,
          allowedMethods: policy.allowedMethods,
          ipAllowlistCount: policy.ipAllowlist.length,
        },
      });
    });
  },

  /**
   * Set (or clear, the break-glass direction) a tenant's per-tenant enforcement master switch. STAFF-ONLY:
   * runs on the supplied platform owner transaction (withPlatformTx, which bypasses RLS and writes the
   * platform_audit_log row in the SAME tx), so it can target any tenant — never reachable from the tenant
   * request flow. Seeds a default policy row (column defaults fill the rest) if the tenant has none yet, else
   * updates only enforcement_enabled.
   */
  async setEnforcement(tx: Tx, tenantId: string, enabled: boolean): Promise<void> {
    await tx
      .insert(tenantAuthPolicies)
      .values({ tenantId, enforcementEnabled: enabled })
      .onConflictDoUpdate({
        target: tenantAuthPolicies.tenantId,
        set: { enforcementEnabled: enabled, updatedAt: new Date() },
      });
  },
};
