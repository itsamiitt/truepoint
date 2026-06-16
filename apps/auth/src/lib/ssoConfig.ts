// ssoConfig.ts — load a tenant's SSO config and present it to the provider seam as a decrypted SsoConfig
// (17 §7). The encrypted OIDC client secret is decrypted here (the only place that needs it), so providers
// never touch ciphertext. Returns null when the tenant has no enabled SSO config — callers fall back safely.
import { type SsoConfig, decryptSecret } from "@leadwolf/auth";
import { tenantSsoConfigRepository } from "@leadwolf/db";

export async function loadSsoConfig(tenantId: string): Promise<SsoConfig | null> {
  const r = await tenantSsoConfigRepository.findByTenant(tenantId);
  if (!r || !r.enabled) return null;
  return {
    tenantId: r.tenantId,
    protocol: r.protocol,
    provider: r.provider,
    oidcIssuer: r.oidcIssuer,
    oidcClientId: r.oidcClientId,
    oidcClientSecret: r.oidcClientSecretEnc ? decryptSecret(r.oidcClientSecretEnc) : null,
    metadataUrl: r.metadataUrl,
    metadataXml: r.metadataXml,
    attributeMapping: r.attributeMapping,
    jitEnabled: r.jitEnabled,
    defaultRole: r.defaultRole,
    enforced: r.enforced,
  };
}
