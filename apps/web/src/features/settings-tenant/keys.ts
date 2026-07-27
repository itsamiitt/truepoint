// keys.ts — the settings-tenant feature's TanStack Query key factory. Single source so every hook and every save
// reads/invalidates the SAME keys and the cache never fragments.
export const settingsTenantKeys = {
  all: ["settings-tenant"] as const,
  /** The tenant auth policy (Tenant ▸ Security & access). */
  authPolicy: () => ["settings-tenant", "auth-policy"] as const,
  /** The tenant SSO configuration. */
  ssoConfig: () => ["settings-tenant", "sso-config"] as const,
  /** The organization profile + its workspaces and members. */
  organization: () => ["settings-tenant", "organization"] as const,
  /** Claimed domains (Tenant ▸ Security ▸ Domains & SCIM). */
  domains: () => ["settings-tenant", "domains"] as const,
  /** SCIM tokens (masked; the plaintext is returned once at creation and never cached). */
  scimTokens: () => ["settings-tenant", "scim-tokens"] as const,
};
