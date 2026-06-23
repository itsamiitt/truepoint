// authPolicyRepository.ts — read/upsert a tenant's auth policy (ADR-0018, 17 §10): the Auth Admin
// Security & Access record. tenant_auth_policies is tenant-scoped (RLS USING tenant_id = GUC), so the read +
// the upsert run under withTenantTx as leadwolf_app — a security_admin only ever touches their OWN org's
// policy. The write is AUDITED (settings.update on auth_policy) in the SAME transaction. The strictest-wins
// resolution applied at login lives in @leadwolf/auth (resolveEffectivePolicy); this is the raw per-tenant
// record the org edits.

import type { AuthPolicy } from "@leadwolf/types";
import { eq } from "drizzle-orm";
import { withTenantTx } from "../client.ts";
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
      if (!r) return DEFAULT_POLICY;
      return {
        mfaEnforcement: r.mfaEnforcement as AuthPolicy["mfaEnforcement"],
        allowedMethods: (r.allowedMethods as AuthPolicy["allowedMethods"]) ?? [],
        disableSocial: r.disableSocial,
        requireSso: r.requireSso,
        ipAllowlist: r.ipAllowlist ?? [],
        ...(r.sessionTimeoutSeconds != null
          ? { sessionTimeoutSeconds: r.sessionTimeoutSeconds }
          : {}),
      };
    });
  },

  /** Upsert the tenant's policy and audit the change (settings.update) atomically. */
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
};
