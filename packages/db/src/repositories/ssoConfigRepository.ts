// ssoConfigRepository.ts — read/upsert a tenant's SSO (SAML/OIDC) configuration (17 §7, ADR-0017/0018): the
// Auth Admin ▸ Single sign-on record. tenant_sso_configs is tenant-scoped (RLS USING tenant_id = GUC), so the
// read + the upsert run under withTenantTx as leadwolf_app — a security_admin only ever touches their OWN
// org's config. The write is AUDITED (settings.update on sso_config) in the SAME transaction. The OIDC client
// secret is write-only: getForTenant returns only `hasClientSecret` (never the bytes); the pre-tenant SSO
// runtime read (the bytes, to drive a login) lives in tenantSsoConfigRepository on the privileged client.

import type { SsoConfigUpdate, SsoConfigView } from "@leadwolf/types";
import { eq } from "drizzle-orm";
import { withTenantTx } from "../client.ts";
import { tenantSsoConfigs } from "../schema/auth.ts";
import { auditRepository } from "./auditRepository.ts";

// The repository upsert values — the validated update fields PLUS the already-encrypted secret bytes
// (undefined = leave the stored secret unchanged). The plaintext secret never reaches this layer.
export type SsoConfigUpsertValues = Omit<SsoConfigUpdate, "oidcClientSecret"> & {
  oidcClientSecretEnc?: Uint8Array;
};

export const ssoConfigRepository = {
  /** The tenant's masked SSO config, or null when none is configured. The OIDC client secret is NEVER
   *  returned — only `hasClientSecret` indicates whether one is stored. */
  async getForTenant(tenantId: string): Promise<SsoConfigView | null> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantSsoConfigs)
        .where(eq(tenantSsoConfigs.tenantId, tenantId))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        protocol: r.protocol === "oidc" ? "oidc" : "saml",
        provider: r.provider,
        metadataUrl: r.metadataUrl,
        oidcIssuer: r.oidcIssuer,
        oidcClientId: r.oidcClientId,
        attributeMapping: (r.attributeMapping ?? {}) as Record<string, string>,
        jitEnabled: r.jitEnabled,
        defaultRole: r.defaultRole,
        enabled: r.enabled,
        enforced: r.enforced,
        hasClientSecret: r.oidcClientSecretEnc != null,
      };
    });
  },

  /** Upsert the tenant's SSO config and audit the change (settings.update / sso_config) atomically. An
   *  absent field keeps the current value; `oidcClientSecretEnc` undefined leaves the stored secret as-is. */
  async upsert(
    tenantId: string,
    values: SsoConfigUpsertValues,
    actorUserId: string,
  ): Promise<void> {
    await withTenantTx({ tenantId }, async (tx) => {
      // Only set the columns that were provided (insert needs the NOT-NULL protocol/provider; the update
      // path skips undefined fields so a partial PUT does not clobber unrelated columns).
      const insertValues = {
        tenantId,
        protocol: values.protocol,
        provider: values.provider,
        metadataUrl: values.metadataUrl ?? null,
        metadataXml: values.metadataXml ?? null,
        oidcIssuer: values.oidcIssuer ?? null,
        oidcClientId: values.oidcClientId ?? null,
        oidcClientSecretEnc: values.oidcClientSecretEnc ?? null,
        attributeMapping: values.attributeMapping ?? {},
        jitEnabled: values.jitEnabled ?? true,
        defaultRole: values.defaultRole ?? "member",
        enabled: values.enabled ?? false,
        enforced: values.enforced ?? false,
      };

      // The conflict-update set: skip undefined so a partial PUT preserves unrelated columns. The secret is
      // only overwritten when fresh bytes are supplied (undefined = leave the stored secret unchanged).
      const updateSet: Record<string, unknown> = {
        protocol: values.protocol,
        provider: values.provider,
        updatedAt: new Date(),
      };
      if (values.metadataUrl !== undefined) updateSet.metadataUrl = values.metadataUrl ?? null;
      if (values.metadataXml !== undefined) updateSet.metadataXml = values.metadataXml ?? null;
      if (values.oidcIssuer !== undefined) updateSet.oidcIssuer = values.oidcIssuer ?? null;
      if (values.oidcClientId !== undefined) updateSet.oidcClientId = values.oidcClientId ?? null;
      if (values.oidcClientSecretEnc !== undefined)
        updateSet.oidcClientSecretEnc = values.oidcClientSecretEnc;
      if (values.attributeMapping !== undefined)
        updateSet.attributeMapping = values.attributeMapping;
      if (values.jitEnabled !== undefined) updateSet.jitEnabled = values.jitEnabled;
      if (values.defaultRole !== undefined) updateSet.defaultRole = values.defaultRole;
      if (values.enabled !== undefined) updateSet.enabled = values.enabled;
      if (values.enforced !== undefined) updateSet.enforced = values.enforced;

      await tx
        .insert(tenantSsoConfigs)
        .values(insertValues)
        .onConflictDoUpdate({ target: tenantSsoConfigs.tenantId, set: updateSet });

      // Audit in the same tx (append-only audit_log) — a failed upsert rolls the audit row back too. NEVER
      // record the secret (or its bytes); only that one was set/rotated.
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null, // tenant-level config change
        actorUserId,
        action: "settings.update",
        entityType: "sso_config",
        entityId: tenantId,
        metadata: {
          protocol: values.protocol,
          provider: values.provider,
          enabled: values.enabled,
          enforced: values.enforced,
          jitEnabled: values.jitEnabled,
          clientSecretRotated: values.oidcClientSecretEnc !== undefined,
        },
      });
    });
  },
};
